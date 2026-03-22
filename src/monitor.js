const { fetchNode } = require('./api');
const { getAllNodes, getAllChatIds, getNodesByChat, getNodeStatus, setNodeStatus } = require('./db');
const { escapeHtml } = require('./format');

const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

function startMonitor(bot) {
  console.log('🔍 Node monitor started (checking every 5 minutes)');

  async function checkNodes() {
    // Get unique operator+type combos across all users
    const allNodes = getAllNodes();
    const uniqueKeys = new Map();
    for (const n of allNodes) {
      const key = `${n.operator}:${n.type}`;
      if (!uniqueKeys.has(key)) {
        uniqueKeys.set(key, { operator: n.operator, type: n.type, alias: n.alias });
      }
    }

    for (const [key, info] of uniqueKeys) {
      try {
        const nodeData = await fetchNode(info.operator, info.type);
        const isOnline = nodeData?.node?.lastSuccess ?? false;
        const prevStatus = getNodeStatus(info.operator, info.type);

        // First run — just record status, no alert
        if (prevStatus === null) {
          setNodeStatus(info.operator, info.type, { online: isOnline, checkedAt: new Date().toISOString() });
          continue;
        }

        const wasOnline = prevStatus.online;

        // Status changed — send alerts
        if (wasOnline && !isOnline) {
          // Went OFFLINE
          const reason = nodeData?.node?.lastFailureReason || 'unknown';
          await sendAlertToSubscribers(bot, info, '🔴', 'OFFLINE', `Reason: ${reason.replace(/_/g, ' ')}`);
        } else if (!wasOnline && isOnline) {
          // Came back ONLINE
          await sendAlertToSubscribers(bot, info, '🟢', 'ONLINE', 'Node is back up!');
        }

        setNodeStatus(info.operator, info.type, { online: isOnline, checkedAt: new Date().toISOString() });
      } catch (err) {
        console.error(`Monitor error for ${info.alias}:`, err.message);
      }

      // Small delay between checks to avoid rate limiting
      await sleep(1000);
    }
  }

  // Run first check after 30 seconds (let bot initialize)
  setTimeout(() => {
    checkNodes().catch(err => console.error('Monitor check error:', err));
  }, 30000);

  // Then run periodically
  setInterval(() => {
    checkNodes().catch(err => console.error('Monitor check error:', err));
  }, CHECK_INTERVAL);
}

async function sendAlertToSubscribers(bot, nodeInfo, icon, status, detail) {
  const allNodes = getAllNodes();
  // Find all chat_ids that have this node registered
  const subscribers = [...new Set(
    allNodes
      .filter(n => n.operator === nodeInfo.operator && n.type === nodeInfo.type)
      .map(n => n.chat_id)
  )];

  const msg = `${icon} <b>Alert: ${escapeHtml(nodeInfo.alias)} is ${status}</b>\n` +
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startMonitor };
