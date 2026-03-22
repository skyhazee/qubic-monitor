function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function scoreBar(score, width = 10) {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function formatNumber(num) {
  if (num == null) return '—';
  return Number(num).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatUsd(num) {
  if (num == null) return '—';
  if (num < 0.01) return `$${num.toFixed(6)}`;
  return `$${formatNumber(num)}`;
}

function syncStatus(lastTick, referenceTick) {
  if (lastTick === referenceTick) return '🟢 Synced';
  const diff = referenceTick - lastTick;
  if (diff <= 5) return `🟡 Almost synced (${diff} ticks behind)`;
  return `🔴 Out of sync (${diff} ticks behind)`;
}

function formatNodeCard(data, stats, price) {
  const { node, history } = data;
  if (!node) return '❌ Node not found.';

  const isActive = node.lastSuccess;
  const type = (node.type || '').toUpperCase();
  const live = node.liveScore || {};

  // Calculate ranking from allTypes
  let ranking = '—';
  let totalNodes = stats?.activeNodes || '—';

  // Eligible status
  let eligibleText;
  if (node.eligibleForReward) {
    eligibleText = '✅ Eligible for reward';
  } else {
    const reason = node.ineligibleReason
      ? node.ineligibleReason.replace(/_/g, ' ')
      : 'unknown';
    eligibleText = `❌ Ineligible — ${reason}`;
  }

  // Sync status
  const syncText = syncStatus(node.lastTick, node.lastReferenceTick);

  // Estimated reward — estimatedReward is in QUBIC tokens
  const estRewardQubic = live.estimatedReward || 0;
  let estRewardUsd = '—';
  if (price && estRewardQubic > 0) {
    estRewardUsd = formatUsd(estRewardQubic * price);
  }

  // Epoch progress
  const epochProgress = stats?.epochProgress;
  let epochText = '';
  if (epochProgress) {
    const pct = epochProgress.progress_percent?.toFixed(1) || '—';
    const remaining = epochProgress.time_remaining_seconds;
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    epochText = `\n📅 <b>Epoch ${stats.reference?.epoch || '—'}</b> — ${pct}% (${days}d ${hours}h remaining)`;
  }

  let msg = ``;
  msg += `${isActive ? '🟢' : '🔴'} <b>${escapeHtml(node.alias)}</b> — ${type}\n`;
  msg += `├ Operator: <code>${node.operator}</code>\n`;
  msg += `├ ${eligibleText}\n`;
  msg += `├ ${syncText}\n`;
  msg += `├ Checks: <b>${formatNumber(node.successfulChecks || 0)} / ${formatNumber(node.totalChecks || 0)}</b>\n`;
  msg += `├ Last Tick: <code>${formatNumber(node.lastTick)}</code>\n`;
  msg += `└ Ref Tick:  <code>${formatNumber(node.lastReferenceTick)}</code>\n`;

  msg += `\n📊 <b>Live Scores</b>\n`;
  msg += `├ Uptime:  ${scoreBar(live.uptimeScore || 0)} ${(live.uptimeScore || 0).toFixed(1)}%\n`;
  msg += `├ Sync:    ${scoreBar(live.syncScore || 0)} ${(live.syncScore || 0).toFixed(1)}%\n`;
  msg += `├ Final:   ${scoreBar(live.finalScore || 0)} ${(live.finalScore || 0).toFixed(1)}%\n`;
  msg += `├ Points:  <b>${formatNumber(live.rewardPoints)}</b>\n`;
  msg += `└ Est. Reward: <b>${formatNumber(estRewardQubic)} QUBIC</b>`;
  if (estRewardUsd !== '—') msg += ` (~${estRewardUsd})`;
  msg += `\n`;

  msg += epochText;
  if (price) {
    msg += `\n💰 QUBIC Price: <b>$${price.toFixed(8)}</b>`;
  }

  // Epoch history
  if (history && history.length > 0) {
    msg += `\n\n📜 <b>Epoch History</b>\n`;
    for (const h of history.slice(-5)) {
      const eIcon = h.eligible ? '✅' : '❌';
      msg += `├ <b>Epoch ${h.epoch}</b> ${eIcon}\n`;
      msg += `│  Uptime: ${(h.uptimeScore || 0).toFixed(1)}% | `;
      msg += `Sync: ${(h.syncScore || 0).toFixed(1)}% | `;
      msg += `Final: ${(h.finalScore || 0).toFixed(1)}%\n`;
      msg += `│  Points: ${formatNumber(h.rewardPoints)}`;
      if (!h.eligible && h.disqualifyReason) {
        msg += ` | ⚠️ ${h.disqualifyReason.replace(/_/g, ' ')}`;
      }
      msg += `\n`;
    }
  }

  return msg;
}

function formatNodeSummary(data, stats, price) {
  const { node } = data;
  if (!node) return null;

  const isActive = node.lastSuccess;
  const type = (node.type || '').toUpperCase();
  const live = node.liveScore || {};
  const syncText = syncStatus(node.lastTick, node.lastReferenceTick);
  const eligible = node.eligibleForReward ? '✅' : '❌';

  const estReward = live.estimatedReward || 0;
  let msg = `${isActive ? '🟢' : '🔴'} <b>${escapeHtml(node.alias)}</b> [${type}] ${eligible}\n`;
  msg += `   ${syncText} | Final: ${(live.finalScore || 0).toFixed(1)}% | Est: ${formatNumber(estReward)} QUBIC`;

  if (price && estReward > 0) {
    msg += ` (~${formatUsd(estReward * price)})`;
  }

  return msg;
}

module.exports = { formatNodeCard, formatNodeSummary, escapeHtml, formatNumber };
