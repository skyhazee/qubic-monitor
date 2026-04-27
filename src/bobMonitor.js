const { fetchBobTick, fetchReferenceTick, normalizeBobRpcUrl } = require('./api');
const { getAllBobNodes, getBobStatus, setBobStatus } = require('./db');
const { escapeHtml, formatNumber } = require('./format');

const CHECK_INTERVAL_MS = Number(process.env.BOB_CHECK_INTERVAL_MS || 10000);
const OFFLINE_AFTER_ERRORS = Number(process.env.BOB_OFFLINE_AFTER_ERRORS || 3);
const STUCK_AFTER_MS = Number(process.env.BOB_STUCK_AFTER_MS || 120000);
const LAG_THRESHOLD_TICKS = Number(process.env.BOB_LAG_THRESHOLD_TICKS || 100);
const SLOW_TPS_THRESHOLD = Number(process.env.BOB_SLOW_TPS_THRESHOLD || 1.0);
const SPEED_WINDOW_MS = Number(process.env.BOB_SPEED_WINDOW_MS || 60000);
const SLOW_ALERT_AFTER_MS = Number(process.env.BOB_SLOW_ALERT_AFTER_MS || 120000);
const ALERT_REPEAT_INTERVAL_MS = Number(process.env.BOB_ALERT_REPEAT_INTERVAL_MS || 1800000);
const ALERT_BEHIND = String(process.env.BOB_ALERT_BEHIND || 'false').toLowerCase() === 'true';
const REFERENCE_LOG_INTERVAL_MS = Number(process.env.REFERENCE_TICK_LOG_INTERVAL_MS || 300000);
let lastReferenceTickErrorLogAt = 0;

function startBobMonitor(bot) {
  console.log(`BOB monitor started (checking every ${Math.round(CHECK_INTERVAL_MS / 1000)}s)`);

  setTimeout(() => {
    runBobChecks(bot).catch(err => console.error('BOB monitor check error:', err.message));
  }, 10000);

  setInterval(() => {
    runBobChecks(bot).catch(err => console.error('BOB monitor check error:', err.message));
  }, CHECK_INTERVAL_MS);
}

async function runBobChecks(bot) {
  const bobNodes = getAllBobNodes();
  if (bobNodes.length === 0) return;

  const uniqueNodes = collectUniqueBobNodes(bobNodes);
  let referenceTick = null;
  let referenceSource = null;

  try {
    const reference = await fetchReferenceTick();
    referenceTick = reference.tick;
    referenceSource = reference.source;
  } catch (err) {
    logReferenceTickError(err);
  }

  const outcomes = [];
  for (const node of uniqueNodes.values()) {
    const prev = getBobStatus(node.alias, node.url);
    try {
      const result = await fetchBobTick(node.url);
      outcomes.push({ node, prev, ok: true, ...result });
    } catch (err) {
      outcomes.push({ node, prev, ok: false, error: err.message });
    }
    await sleep(300);
  }

  const observedTicks = outcomes.filter(o => o.ok).map(o => o.tick);
  const effectiveReferenceTick = referenceTick ?? (observedTicks.length > 0 ? Math.max(...observedTicks) : null);

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      await handleBobError(bot, outcome);
      continue;
    }
    await handleBobSuccess(bot, outcome, effectiveReferenceTick, referenceTick != null, referenceSource);
  }
}

async function handleBobError(bot, outcome) {
  const { node, prev, error } = outcome;
  const errorCount = (prev?.errorCount || 0) + 1;
  const status = errorCount >= OFFLINE_AFTER_ERRORS ? 'OFFLINE' : (prev?.status || 'UNKNOWN');

  setBobStatus(node.alias, node.url, {
    ...prev,
    status,
    online: false,
    error,
    errorCount,
    checkedAt: new Date().toISOString(),
  });

  if (prev && prev.status !== 'OFFLINE' && status === 'OFFLINE') {
    await sendBobAlert(bot, node, 'OFFLINE', [
      `Error: ${error}`,
      `Failed checks: ${errorCount}`,
    ]);
  }
}

async function handleBobSuccess(bot, outcome, referenceTick, hasExternalReference, referenceSource) {
  const { node, prev, tick, latencyMs, endpoint } = outcome;
  const now = Date.now();

  if (!Number.isFinite(tick) || tick <= 0) {
    await handleBobWarmup(bot, outcome, referenceTick, hasExternalReference, referenceSource);
    return;
  }

  const prevTick = prev?.tick > 0 ? prev.tick : undefined;
  const prevCheckedAtMs = prev?.checkedAt ? Date.parse(prev.checkedAt) : null;
  const tickAdvanced = typeof prevTick !== 'number' || tick > prevTick;
  const lastTickAdvancedAt = tickAdvanced
    ? now
    : (prev?.lastTickAdvancedAt ? Date.parse(prev.lastTickAdvancedAt) : now);

  const seconds = prevCheckedAtMs ? Math.max((now - prevCheckedAtMs) / 1000, 1) : null;
  const tickDelta = typeof prevTick === 'number' ? Math.max(tick - prevTick, 0) : null;
  const tickPerSecond = seconds && tickDelta != null ? tickDelta / seconds : null;
  const speedSamples = updateSpeedSamples(prev?.speedSamples, tick, now);
  const averageTickPerSecond = calculateAverageTickPerSecond(speedSamples);
  const lag = referenceTick != null ? Math.max(referenceTick - tick, 0) : null;
  const stuckForMs = now - lastTickAdvancedAt;
  const isStuck = stuckForMs >= STUCK_AFTER_MS && (!hasExternalReference || referenceTick == null || referenceTick > tick);
  const isBehind = lag != null && lag > LAG_THRESHOLD_TICKS;
  const isSlow = averageTickPerSecond != null && averageTickPerSecond < SLOW_TPS_THRESHOLD && isBehind;
  const slowSinceMs = isSlow
    ? (prev?.slowSince ? Date.parse(prev.slowSince) : now)
    : null;
  const slowForMs = slowSinceMs ? now - slowSinceMs : 0;
  const isSlowConfirmed = isSlow && slowForMs >= SLOW_ALERT_AFTER_MS;
  const status = isStuck ? 'STUCK' : isSlowConfirmed ? 'SLOW' : isBehind ? 'BEHIND' : 'OK';

  const nextStatus = {
    ...pickAlertState(prev),
    status,
    online: true,
    tick,
    prevTick,
    tickPerSecond,
    averageTickPerSecond,
    speedSamples,
    lag,
    referenceTick,
    referenceSource,
    hasExternalReference,
    latencyMs,
    endpoint,
    error: null,
    errorCount: 0,
    slowSince: slowSinceMs ? new Date(slowSinceMs).toISOString() : null,
    slowForMs,
    lastTickAdvancedAt: new Date(lastTickAdvancedAt).toISOString(),
    checkedAt: new Date(now).toISOString(),
  };

  setBobStatus(node.alias, node.url, nextStatus);

  if (!prev) return;

  const alertStatus = getAlertStatus(status, prev.status);
  if (!alertStatus) return;
  if (!shouldSendAlert(nextStatus, alertStatus, now)) return;

  nextStatus.lastAlertStatus = alertStatus;
  nextStatus.lastAlertAt = new Date(now).toISOString();
  setBobStatus(node.alias, node.url, nextStatus);

  if (alertStatus === 'RECOVERED') {
    await sendBobAlert(bot, node, 'RECOVERED', buildBobDetail(nextStatus));
    return;
  }

  await sendBobAlert(bot, node, alertStatus, buildBobDetail(nextStatus));
}

async function handleBobWarmup(bot, outcome, referenceTick, hasExternalReference, referenceSource) {
  const { node, prev, tick, latencyMs, endpoint } = outcome;
  const now = Date.now();
  const nextStatus = {
    ...pickAlertState(prev),
    status: 'WARMING',
    online: true,
    tick,
    prevTick: prev?.tick,
    tickPerSecond: null,
    averageTickPerSecond: prev?.averageTickPerSecond ?? null,
    speedSamples: [],
    lag: null,
    referenceTick,
    referenceSource,
    hasExternalReference,
    latencyMs,
    endpoint,
    error: null,
    errorCount: 0,
    slowSince: null,
    slowForMs: 0,
    lastTickAdvancedAt: prev?.lastTickAdvancedAt || new Date(now).toISOString(),
    checkedAt: new Date(now).toISOString(),
  };

  setBobStatus(node.alias, node.url, nextStatus);
}

function updateSpeedSamples(previousSamples, tick, now) {
  const samples = Array.isArray(previousSamples) ? previousSamples : [];
  return [...samples, { at: now, tick }]
    .filter(sample =>
      Number.isFinite(sample.at) &&
      Number.isFinite(sample.tick) &&
      sample.tick > 0 &&
      now - sample.at <= SPEED_WINDOW_MS
    )
    .slice(-20);
}

function calculateAverageTickPerSecond(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const seconds = (last.at - first.at) / 1000;
  const tickDelta = last.tick - first.tick;
  if (seconds <= 0 || tickDelta < 0) return null;
  return tickDelta / seconds;
}

function getAlertStatus(status, previousStatus) {
  if (status === 'OFFLINE' || status === 'STUCK' || status === 'SLOW') return status;
  if (status === 'BEHIND' && ALERT_BEHIND) return 'BEHIND';
  if (status === 'OK' && previousStatus && previousStatus !== 'OK' && previousStatus !== 'BEHIND') return 'RECOVERED';
  return null;
}

function shouldSendAlert(status, alertStatus, now) {
  if (status.lastAlertStatus !== alertStatus) return true;
  const lastAlertAtMs = status.lastAlertAt ? Date.parse(status.lastAlertAt) : 0;
  return !lastAlertAtMs || now - lastAlertAtMs >= ALERT_REPEAT_INTERVAL_MS;
}

function pickAlertState(prev) {
  return {
    lastAlertStatus: prev?.lastAlertStatus || null,
    lastAlertAt: prev?.lastAlertAt || null,
  };
}

function logReferenceTickError(err) {
  const now = Date.now();
  if (now - lastReferenceTickErrorLogAt < REFERENCE_LOG_INTERVAL_MS) return;

  lastReferenceTickErrorLogAt = now;
  console.error(
    'BOB monitor: failed to fetch external reference tick; using local max fallback:',
    err.message
  );
}

function collectUniqueBobNodes(bobNodes) {
  const unique = new Map();
  for (const node of bobNodes) {
    const url = normalizeBobRpcUrl(node.url);
    if (!unique.has(url)) {
      unique.set(url, { alias: node.alias, url: node.url, subscribers: new Set() });
    }
    unique.get(url).subscribers.add(node.chat_id);
  }
  return unique;
}

function buildBobDetail(status) {
  const lines = [
    `Tick: ${formatNumber(status.tick)}`,
    `Speed: ${formatTickRate(status.tickPerSecond)}`,
    `Avg speed: ${formatTickRate(status.averageTickPerSecond)}`,
    `Lag: ${status.lag == null ? '-' : `${formatNumber(status.lag)} ticks`}`,
    `RPC latency: ${status.latencyMs} ms`,
  ];
  if (status.referenceTick != null) {
    lines.push(`Reference: ${formatNumber(status.referenceTick)}${status.hasExternalReference ? '' : ' (local max)'}`);
  }
  return lines;
}

async function sendBobAlert(bot, node, status, detailLines) {
  const allNodes = getAllBobNodes();
  const subscribers = [...new Set(
    allNodes
      .filter(n => normalizeBobRpcUrl(n.url) === normalizeBobRpcUrl(node.url))
      .map(n => n.chat_id)
  )];

  const msg = `<b>BOB ${escapeHtml(status)} - ${escapeHtml(node.alias)}</b>\n` +
    detailLines.map((line, index) => `${index === detailLines.length - 1 ? '`-' : '|-'} ${escapeHtml(line)}`).join('\n') +
    `\n<code>${escapeHtml(normalizeBobRpcUrl(node.url))}</code>`;

  for (const chatId of subscribers) {
    try {
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    } catch (err) {
      console.error(`Failed to send BOB alert to ${chatId}:`, err.message);
    }
  }
}

function formatBobStatus(alias, url, status) {
  if (!status) {
    return `<b>${escapeHtml(alias)}</b>\n` +
      `|- Status: belum ada data monitor\n` +
      `\`- URL: <code>${escapeHtml(normalizeBobRpcUrl(url))}</code>`;
  }

  const lines = [
    `<b>${escapeHtml(alias)}</b> - <b>${escapeHtml(status.status || 'UNKNOWN')}</b>`,
    `|- Tick: <code>${formatNumber(status.tick)}</code>`,
    `|- Speed: <b>${formatTickRate(status.tickPerSecond)}</b>`,
    `|- Avg speed: <b>${formatTickRate(status.averageTickPerSecond)}</b>`,
    `|- Lag: <b>${status.lag == null ? '-' : `${formatNumber(status.lag)} ticks`}</b>`,
    `|- RPC latency: <b>${status.latencyMs == null ? '-' : `${status.latencyMs} ms`}</b>`,
  ];

  if (status.referenceTick != null) {
    lines.push(`|- Reference: <code>${formatNumber(status.referenceTick)}</code>${status.hasExternalReference ? '' : ' (local max)'}`);
  }
  if (status.error) {
    lines.push(`|- Error: ${escapeHtml(status.error)}`);
  }
  if (status.checkedAt) {
    lines.push(`|- Last check: ${escapeHtml(status.checkedAt)}`);
  }
  lines.push(`\`- URL: <code>${escapeHtml(normalizeBobRpcUrl(url))}</code>`);
  return lines.join('\n');
}

function formatTickRate(value) {
  if (value == null || Number.isNaN(value)) return '-';
  return `${value.toFixed(3)} tick/sec`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startBobMonitor, formatBobStatus };
