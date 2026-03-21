const TelegramBot = require('node-telegram-bot-api');
const { fetchNode, fetchStats, fetchQubicPrice } = require('./api');
const { addNode, removeNode, getNodesByChat, nodeExists } = require('./db');
const { formatNodeCard, formatNodeSummary, escapeHtml } = require('./format');

function createBot(token) {
  const bot = new TelegramBot(token, { polling: true });

  // /start
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcome = `
🛡️ <b>Qubic Node Monitor Bot</b>

Monitor your Qubic guardian nodes right from Telegram.

<b>Commands:</b>
/add <code>ADDRESS/ALIAS</code> — Add a node to watch
/check — Show all your registered nodes
/remove <code>ADDRESS/ALIAS</code> — Remove a node
/help — Show this message

<b>Example:</b>
<code>/add SFRKDOXI.../bob</code>
    `.trim();
    bot.sendMessage(chatId, welcome, { parse_mode: 'HTML' });
  });

  // /help
  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const help = `
🛡️ <b>Qubic Node Monitor — Help</b>

/add <code>ADDRESS/ALIAS</code>
Add a node to your watchlist. You'll get a quick status report.

/check
View all your registered nodes with live scores.

/remove <code>ADDRESS/ALIAS</code>
Remove a node from your watchlist.

/info <code>ADDRESS/ALIAS</code>
Get detailed info about any node (without adding it).

<b>Format:</b> ADDRESS is the operator ID, ALIAS is the node name (e.g. bob, lite)
    `.trim();
    bot.sendMessage(chatId, help, { parse_mode: 'HTML' });
  });

  // /add ADDRESS/ALIAS
  bot.onText(/\/add(?:@\w+)?\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].trim();
    const slashIdx = input.indexOf('/');

    if (slashIdx === -1) {
      return bot.sendMessage(chatId,
        '⚠️ Format salah. Gunakan:\n<code>/add ADDRESS/ALIAS</code>\n\nContoh:\n<code>/add SFRKDOXIGWAXJDKTSWQDGXYDWSEBWSDRNKCTYZIKLCNKPQRXGSLAPKZGYRAD/bob</code>',
        { parse_mode: 'HTML' }
      );
    }

    const operator = input.substring(0, slashIdx).trim();
    const alias = input.substring(slashIdx + 1).trim();

    if (!operator || !alias) {
      return bot.sendMessage(chatId,
        '⚠️ Address dan alias tidak boleh kosong.\n<code>/add ADDRESS/ALIAS</code>',
        { parse_mode: 'HTML' }
      );
    }

    // Check if already exists
    if (nodeExists(chatId, operator, alias)) {
      return bot.sendMessage(chatId,
        `ℹ️ Node <b>${escapeHtml(alias)}</b> sudah ada di watchlist kamu.`,
        { parse_mode: 'HTML' }
      );
    }

    const loadingMsg = await bot.sendMessage(chatId, '⏳ Fetching node data...');

    try {
      const [nodeData, stats, price] = await Promise.all([
        fetchNode(operator, alias),
        fetchStats(),
        fetchQubicPrice(),
      ]);

      if (!nodeData || !nodeData.node) {
        await bot.editMessageText(
          '❌ Node tidak ditemukan. Periksa kembali address dan alias.',
          { chat_id: chatId, message_id: loadingMsg.message_id }
        );
        return;
      }

      // Add to DB
      const type = nodeData.node.type || '';
      addNode(chatId, operator, alias, type);

      const card = formatNodeCard(nodeData, stats, price);
      const finalMsg = `✅ <b>Node ditambahkan!</b>\n\n${card}`;

      await bot.editMessageText(finalMsg, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error('Error in /add:', err);
      await bot.editMessageText(
        `❌ Gagal fetch data node: ${escapeHtml(err.message)}`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
      );
    }
  });

  // /check
  bot.onText(/\/check(?:@\w+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    const nodes = getNodesByChat(chatId);

    if (nodes.length === 0) {
      return bot.sendMessage(chatId,
        '📋 Belum ada node terdaftar.\nGunakan <code>/add ADDRESS/ALIAS</code> untuk menambahkan.',
        { parse_mode: 'HTML' }
      );
    }

    const loadingMsg = await bot.sendMessage(chatId,
      `⏳ Fetching data untuk ${nodes.length} node...`
    );

    try {
      const [stats, price] = await Promise.all([
        fetchStats(),
        fetchQubicPrice(),
      ]);

      let msg = `📋 <b>Node Terdaftar</b> (${nodes.length})\n\n`;

      for (const n of nodes) {
        try {
          const nodeData = await fetchNode(n.operator, n.alias);
          if (nodeData && nodeData.node) {
            const summary = formatNodeSummary(nodeData, stats, price);
            if (summary) {
              msg += summary + '\n\n';
              continue;
            }
          }
          msg += `⚠️ <b>${escapeHtml(n.alias)}</b> — data tidak tersedia\n\n`;
        } catch {
          msg += `⚠️ <b>${escapeHtml(n.alias)}</b> — gagal fetch\n\n`;
        }
      }

      // Add epoch info
      if (stats?.epochProgress) {
        const pct = stats.epochProgress.progress_percent?.toFixed(1) || '—';
        const remaining = stats.epochProgress.time_remaining_seconds;
        const days = Math.floor(remaining / 86400);
        const hours = Math.floor((remaining % 86400) / 3600);
        msg += `\n📅 <b>Epoch ${stats.reference?.epoch || '—'}</b> — ${pct}% (${days}d ${hours}h remaining)`;
      }

      if (price) {
        msg += `\n💰 QUBIC Price: <b>$${price.toFixed(8)}</b>`;
      }

      await bot.editMessageText(msg, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error('Error in /check:', err);
      await bot.editMessageText(
        `❌ Gagal fetch data: ${escapeHtml(err.message)}`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
      );
    }
  });

  // /remove ADDRESS/ALIAS
  bot.onText(/\/remove(?:@\w+)?\s+(.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].trim();
    const slashIdx = input.indexOf('/');

    if (slashIdx === -1) {
      return bot.sendMessage(chatId,
        '⚠️ Format: <code>/remove ADDRESS/ALIAS</code>',
        { parse_mode: 'HTML' }
      );
    }

    const operator = input.substring(0, slashIdx).trim();
    const alias = input.substring(slashIdx + 1).trim();

    const removed = removeNode(chatId, operator, alias);
    if (removed) {
      bot.sendMessage(chatId,
        `🗑️ Node <b>${escapeHtml(alias)}</b> dihapus dari watchlist.`,
        { parse_mode: 'HTML' }
      );
    } else {
      bot.sendMessage(chatId,
        `⚠️ Node <b>${escapeHtml(alias)}</b> tidak ditemukan di watchlist kamu.`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // /info ADDRESS/ALIAS — quick look without adding
  bot.onText(/\/info(?:@\w+)?\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].trim();
    const slashIdx = input.indexOf('/');

    if (slashIdx === -1) {
      return bot.sendMessage(chatId,
        '⚠️ Format: <code>/info ADDRESS/ALIAS</code>',
        { parse_mode: 'HTML' }
      );
    }

    const operator = input.substring(0, slashIdx).trim();
    const alias = input.substring(slashIdx + 1).trim();

    const loadingMsg = await bot.sendMessage(chatId, '⏳ Fetching node data...');

    try {
      const [nodeData, stats, price] = await Promise.all([
        fetchNode(operator, alias),
        fetchStats(),
        fetchQubicPrice(),
      ]);

      if (!nodeData || !nodeData.node) {
        await bot.editMessageText(
          '❌ Node tidak ditemukan.',
          { chat_id: chatId, message_id: loadingMsg.message_id }
        );
        return;
      }

      const card = formatNodeCard(nodeData, stats, price);
      await bot.editMessageText(card, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error('Error in /info:', err);
      await bot.editMessageText(
        `❌ Gagal fetch: ${escapeHtml(err.message)}`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
      );
    }
  });

  // Handle /add without arguments
  bot.onText(/\/add(?:@\w+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      '⚠️ Gunakan format:\n<code>/add ADDRESS/ALIAS</code>\n\nContoh:\n<code>/add SFRKDOXIGWAXJDKTSWQDGXYDWSEBWSDRNKCTYZIKLCNKPQRXGSLAPKZGYRAD/bob</code>',
      { parse_mode: 'HTML' }
    );
  });

  console.log('🤖 Qubic Node Monitor Bot is running...');
  return bot;
}

module.exports = { createBot };
