const TelegramBot = require('node-telegram-bot-api');
const { fetchNode, searchNode, fetchStats, fetchQubicPrice } = require('./api');
const { addNode, removeNode, removeNodeByAlias, getNodesByChat, nodeExistsByOperator } = require('./db');
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
/add <code>address or alias</code> — Add node to watchlist
/check — Show all registered nodes
/remove <code>address or alias</code> — Remove a node
/info <code>address or alias</code> — Quick look (no save)
/help — Show this message

<b>Examples:</b>
<code>/add 0xami</code>
<code>/add SFRKDOXI...GYRAD</code>
    `.trim();
    bot.sendMessage(chatId, welcome, { parse_mode: 'HTML' });
  });

  // /help
  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const help = `
🛡️ <b>Qubic Node Monitor — Help</b>

/add <code>address or alias</code>
Add a node by its operator address OR alias name.

/check
View all your registered nodes with live scores.

/remove <code>address or alias</code>
Remove a node from your watchlist.

/info <code>address or alias</code>
Get detailed info about any node without adding it.

<b>Examples:</b>
<code>/add 0xami</code>
<code>/add SFRKDOXIGWAXJDKTSWQDGXYDWSEBWSDRNKCTYZIKLCNKPQRXGSLAPKZGYRAD</code>
<code>/info bitos</code>
<code>/remove 0xami</code>
    `.trim();
    bot.sendMessage(chatId, help, { parse_mode: 'HTML' });
  });

  // /add QUERY (address or alias)
  bot.onText(/\/add(?:@\w+)?\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1].trim();

    if (!query) {
      return bot.sendMessage(chatId,
        '⚠️ Masukkan address atau alias.\n<code>/add address_or_alias</code>',
        { parse_mode: 'HTML' }
      );
    }

    const loadingMsg = await bot.sendMessage(chatId, '⏳ Searching node...');

    try {
      const [matches, stats, price] = await Promise.all([
        searchNode(query),
        fetchStats(),
        fetchQubicPrice(),
      ]);

      if (matches.length === 0) {
        await bot.editMessageText(
          '❌ Node tidak ditemukan. Periksa kembali address atau alias.',
          { chat_id: chatId, message_id: loadingMsg.message_id }
        );
        return;
      }

      // If multiple matches, add all and show info for each
      let finalMsg = '';
      let addedCount = 0;

      for (const node of matches) {
        if (nodeExistsByOperator(chatId, node.operator, node.type)) {
          finalMsg += `ℹ️ <b>${escapeHtml(node.alias)}</b> [${(node.type || '').toUpperCase()}] sudah ada di watchlist.\n\n`;
          continue;
        }

        addNode(chatId, node.operator, node.alias, node.type);
        addedCount++;

        // Fetch detailed data (with history)
        let detailedData;
        try {
          detailedData = await fetchNode(node.operator, node.type);
        } catch {
          detailedData = { node, history: [] };
        }

        if (detailedData && detailedData.node) {
          const card = formatNodeCard(detailedData, stats, price);
          finalMsg += `✅ <b>Node ditambahkan!</b>\n\n${card}\n\n`;
        } else {
          finalMsg += `✅ <b>${escapeHtml(node.alias)}</b> ditambahkan (detail gagal di-fetch).\n\n`;
        }
      }

      if (!finalMsg) {
        finalMsg = 'ℹ️ Semua node sudah ada di watchlist.';
      }

      // Telegram message limit is 4096 chars
      if (finalMsg.length > 4000) {
        await bot.editMessageText(
          `✅ ${addedCount} node ditambahkan! Gunakan /check untuk lihat detail.`,
          { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
        );
      } else {
        await bot.editMessageText(finalMsg.trim(), {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML',
        });
      }
    } catch (err) {
      console.error('Error in /add:', err);
      await bot.editMessageText(
        `❌ Gagal fetch data: ${escapeHtml(err.message)}`,
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
        '📋 Belum ada node terdaftar.\nGunakan <code>/add address_or_alias</code> untuk menambahkan.',
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

      let replyMsg = `📋 <b>Node Terdaftar</b> (${nodes.length})\n\n`;

      for (const n of nodes) {
        try {
          const nodeData = await fetchNode(n.operator, n.type);
          if (nodeData && nodeData.node) {
            const summary = formatNodeSummary(nodeData, stats, price);
            if (summary) {
              replyMsg += summary + '\n\n';
              continue;
            }
          }
          replyMsg += `⚠️ <b>${escapeHtml(n.alias)}</b> — data tidak tersedia\n\n`;
        } catch {
          replyMsg += `⚠️ <b>${escapeHtml(n.alias)}</b> — gagal fetch\n\n`;
        }
      }

      // Epoch info
      if (stats?.epochProgress) {
        const pct = stats.epochProgress.progress_percent?.toFixed(1) || '—';
        const remaining = stats.epochProgress.time_remaining_seconds;
        const days = Math.floor(remaining / 86400);
        const hours = Math.floor((remaining % 86400) / 3600);
        replyMsg += `\n📅 <b>Epoch ${stats.reference?.epoch || '—'}</b> — ${pct}% (${days}d ${hours}h remaining)`;
      }

      if (price) {
        replyMsg += `\n💰 QUBIC Price: <b>$${price.toFixed(8)}</b>`;
      }

      // Handle long messages
      if (replyMsg.length > 4000) {
        await bot.editMessageText(replyMsg.substring(0, 4000) + '...', {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML',
        });
      } else {
        await bot.editMessageText(replyMsg, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML',
        });
      }
    } catch (err) {
      console.error('Error in /check:', err);
      await bot.editMessageText(
        `❌ Gagal fetch data: ${escapeHtml(err.message)}`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
      );
    }
  });

  // /remove QUERY
  bot.onText(/\/remove(?:@\w+)?\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1].trim();

    // Try by alias first
    let removed = removeNodeByAlias(chatId, query);
    if (!removed) {
      // Try as operator — remove all types for that operator
      const nodes = getNodesByChat(chatId);
      const matching = nodes.filter(n => n.operator.toLowerCase() === query.toLowerCase());
      for (const n of matching) {
        removeNode(chatId, n.operator, n.type);
        removed = true;
      }
    }

    if (removed) {
      bot.sendMessage(chatId,
        `🗑️ Node dihapus dari watchlist.`,
        { parse_mode: 'HTML' }
      );
    } else {
      bot.sendMessage(chatId,
        `⚠️ Node tidak ditemukan di watchlist. Gunakan /check untuk lihat daftar.`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // /info QUERY — quick look without adding
  bot.onText(/\/info(?:@\w+)?\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1].trim();

    const loadingMsg = await bot.sendMessage(chatId, '⏳ Searching node...');

    try {
      const [matches, stats, price] = await Promise.all([
        searchNode(query),
        fetchStats(),
        fetchQubicPrice(),
      ]);

      if (matches.length === 0) {
        await bot.editMessageText(
          '❌ Node tidak ditemukan.',
          { chat_id: chatId, message_id: loadingMsg.message_id }
        );
        return;
      }

      // Show first match in detail
      const firstNode = matches[0];
      let detailedData;
      try {
        detailedData = await fetchNode(firstNode.operator, firstNode.type);
      } catch {
        detailedData = { node: firstNode, history: [] };
      }

      const card = formatNodeCard(detailedData, stats, price);

      if (card.length > 4000) {
        await bot.editMessageText(card.substring(0, 4000) + '...', {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML',
        });
      } else {
        await bot.editMessageText(card, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML',
        });
      }
    } catch (err) {
      console.error('Error in /info:', err);
      await bot.editMessageText(
        `❌ Gagal fetch: ${escapeHtml(err.message)}`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
      );
    }
  });

  // Handle commands without arguments
  bot.onText(/\/add(?:@\w+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      '⚠️ Masukkan address atau alias:\n<code>/add address_or_alias</code>\n\nContoh:\n<code>/add 0xami</code>\n<code>/add SFRKDOXIGWAXJDKTSWQDGXYDWSEBWSDRNKCTYZIKLCNKPQRXGSLAPKZGYRAD</code>',
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/\/remove(?:@\w+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      '⚠️ Masukkan address atau alias:\n<code>/remove address_or_alias</code>',
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/\/info(?:@\w+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      '⚠️ Masukkan address atau alias:\n<code>/info address_or_alias</code>',
      { parse_mode: 'HTML' }
    );
  });

  console.log('🤖 Qubic Node Monitor Bot is running...');
  return bot;
}

module.exports = { createBot };
