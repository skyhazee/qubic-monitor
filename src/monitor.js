const { fetchNode, fetchStats, fetchWalletBalance, fetchQubicPrice } = require('./api');
const { getAllNodes, getNodeStatus, setNodeStatus, getWalletBalance, setWalletBalance } = require('./db');
const { escapeHtml, formatNumber, formatBalanceChange } = require('./format');

const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const SYNC_THRESHOLD = 50; // alert if sync score drops below this

function startMonitor(bot) {
  console.log('🔍 Node monitor started (checking every 5 minutes)');
  let lastEpoch = null;

  async function checkNodes() {
    const allNodes = getAllNodes();
    const uniqueKeys = new Map();
    for (const n of allNodes) {
      const key = `${n.operator}:${n.type}`;
      if (!uniqueKeys.has(key)) {
        uniqueKeys.set(key, { operator: n.operator, type: n.type, alias: n.alias });
      }
    }

    // Check epoch change
    let stats;
    try {
      stats = await fetchStats();
      const currentEpoch = stats?.reference?.epoch;
      if (lastEpoch !== null && currentEpoch && currentEpoch !== lastEpoch) {
        // Epoch changed — notify all users
        await sendEpochAlert(bot, lastEpoch, currentEpoch, stats);
      }
      if (currentEpoch) lastEpoch = currentEpoch;
    } catch (err) {
      console.error('Monitor: failed to fetch stats:', err.message);
    }

    for (const [key, info] of uniqueKeys) {
      try {
        const nodeData = await fetchNode(info.operator, info.type);
        const node = nodeData?.node;
        if (!node) continue;

        const isOnline = node.lastSuccess ?? false;
        const syncScore = node.liveScore?.syncScore ?? 0;
        const isEligible = node.eligibleForReward ?? false;
        const prevStatus = getNodeStatus(info.operator, info.type);

        // First run — record status, no alert
        if (prevStatus === null) {
          setNodeStatus(info.operator, info.type, {
            online: isOnline,
            syncScore,
            eligible: isEligible,
            checkedAt: new Date().toISOString(),
          });
          continue;
        }

        const wasOnline = prevStatus.online;
        const wasSyncOk = (prevStatus.syncScore ?? 100) >= SYNC_THRESHOLD;
        const isSyncOk = syncScore >= SYNC_THRESHOLD;
        const wasEligible = prevStatus.eligible ?? true;

        // 1. Offline/Online alerts
        if (wasOnline && !isOnline) {
          const reason = node.lastFailureReason || 'unknown';
          await sendAlertToSubscribers(bot, info,
            '🔴', 'OFFLINE',
            `Reason: ${reason.replace(/_/g, ' ')}`
          );
        } else if (!wasOnline && isOnline) {
          await sendAlertToSubscribers(bot, info,
            '🟢', 'ONLINE',
            'Node is back up!'
          );
        }

        // 2. Sync score drop alert
        if (wasSyncOk && !isSyncOk) {
          await sendAlertToSubscribers(bot, info,
            '⚠️', `SYNC LOW (${syncScore.toFixed(1)}%)`,
            `Sync score dropped below ${SYNC_THRESHOLD}%`
          );
        } else if (!wasSyncOk && isSyncOk) {
          await sendAlertToSubscribers(bot, info,
            '✅', `SYNC RECOVERED (${syncScore.toFixed(1)}%)`,
            `Sync score is back above ${SYNC_THRESHOLD}%`
          );
        }

        // 3. Eligible status change
        if (wasEligible && !isEligible) {
          const reason = node.ineligibleReason
            ? node.ineligibleReason.replace(/_/g, ' ')
            : 'unknown';
          await sendAlertToSubscribers(bot, info,
            '❌', 'INELIGIBLE FOR REWARD',
            `Reason: ${reason}`
          );
        } else if (!wasEligible && isEligible) {
          await sendAlertToSubscribers(bot, info,
            '🎉', 'NOW ELIGIBLE FOR REWARD',
            'Node is eligible to receive rewards!'
          );
        }

        // Update status
        setNodeStatus(info.operator, info.type, {
          online: isOnline,
          syncScore,
          eligible: isEligible,
          checkedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`Monitor error for ${info.alias}:`, err.message);
      }

      await sleep(1000);
    }
  }

  async function checkWallets() {
    const allNodes = getAllNodes();
    if (allNodes.length === 0) return;

    // Collect unique operator addresses and their subscribers
    const addressMap = new Map(); // address -> { aliases: Set, chatIds: Set }
    for (const n of allNodes) {
      if (!addressMap.has(n.operator)) {
        addressMap.set(n.operator, { aliases: new Set(), chatIds: new Set() });
      }
      const entry = addressMap.get(n.operator);
      entry.aliases.add(n.alias);
      entry.chatIds.add(n.chat_id);
    }

    let price;
    try {
      price = await fetchQubicPrice();
    } catch {
      price = null;
    }

    for (const [address, info] of addressMap) {
      try {
        const balData = await fetchWalletBalance(address);
        if (!balData) continue;

        const prevBal = getWalletBalance(address);

        // First run — just save the snapshot
        if (!prevBal) {
          setWalletBalance(address, balData);
          continue;
        }

        // Compare balances
        const alias = [...info.aliases][0]; // use first alias
        const changeMsg = formatBalanceChange(alias, address, prevBal, balData, price);

        if (changeMsg) {
          // Send notification to all subscribers
          for (const chatId of info.chatIds) {
            try {
              await bot.sendMessage(chatId, changeMsg, { parse_mode: 'HTML' });
            } catch (err) {
              console.error(`Failed to send wallet alert to ${chatId}:`, err.message);
            }
          }
        }

        // Update snapshot
        setWalletBalance(address, balData);
      } catch (err) {
        console.error(`Wallet monitor error for ${address.substring(0, 8)}...:`, err.message);
      }

      await sleep(1000);
    }
  }

  async function runChecks() {
    await checkNodes();
    await checkWallets();
  }

  // Run first check after 30 seconds
  setTimeout(() => {
    runChecks().catch(err => console.error('Monitor check error:', err));
  }, 30000);

  // Then run periodically
  setInterval(() => {
    runChecks().catch(err => console.error('Monitor check error:', err));
  }, CHECK_INTERVAL);
}

async function sendAlertToSubscribers(bot, nodeInfo, icon, status, detail) {
  const allNodes = getAllNodes();
  const subscribers = [...new Set(
    allNodes
      .filter(n => n.operator === nodeInfo.operator && n.type === nodeInfo.type)
      .map(n => n.chat_id)
  )];

  const msg = `${icon} <b>Alert: ${escapeHtml(nodeInfo.alias)} — ${status}</b>\n` +
    `├ Type: ${(nodeInfo.type || '').toUpperCase()}\n` +
    `├ ${detail}\n` +
    `└ <code>${nodeInfo.operator}</code>`;

  for (const chatId of subscribers) {
    try {
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    } catch (err) {
      console.error(`Failed to send alert to ${chatId}:`, err.message);
    }
  }
}

async function sendEpochAlert(bot, oldEpoch, newEpoch, stats) {
  const allNodes = getAllNodes();
  const chatIds = [...new Set(allNodes.map(n => n.chat_id))];

  let msg = `🔔 <b>Epoch ${oldEpoch} telah berakhir!</b>\n`;
  msg += `├ Epoch baru: <b>${newEpoch}</b>\n`;
  if (stats?.epochRewards) {
    const r = stats.epochRewards;
    msg += `├ BOB Pool: <b>${formatNumber(r.bobPool)} QUBIC</b>\n`;
    msg += `├ LITE Pool: <b>${formatNumber(r.litePool)} QUBIC</b>\n`;
    msg += `└ Total Pool: <b>${formatNumber(r.totalPool)} QUBIC</b>`;
  }
  msg += `\n\nGunakan /check untuk lihat skor terbaru.`;

  for (const chatId of chatIds) {
    try {
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    } catch (err) {
      console.error(`Failed to send epoch alert to ${chatId}:`, err.message);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startMonitor };
