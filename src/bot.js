const TelegramBot = require('node-telegram-bot-api');
const { fetchNode, searchNode, fetchStats, fetchQubicPrice, fetchWalletBalance, fetchBobTick, normalizeBobRpcUrl } = require('./api');
const {
  addNode,
  removeNode,
  removeNodeByAlias,
  getNodesByChat,
  nodeExistsByOperator,
  addBobNode,
  removeBobNode,
  getBobNodesByChat,
  getBobStatus,
} = require('./db');
const { formatNodeCard, formatWalletCard, escapeHtml, formatNumber } = require('./format');
const { formatBobStatus } = require('./bobMonitor');

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
/history <code>address or alias</code> — Epoch history
/wallet — View wallet balances (auto-detected)
/bobadd <code>alias url</code> — Monitor BOB RPC VPS
/bobcheck — Show BOB tick/speed/stuck status
/bobremove <code>alias</code> — Remove BOB RPC monitor
/help — Show this message

<b>Examples:</b>
<code>/add 0xami</code>
<code>/add SFRKDOXI...GYRAD</code>
<code>/bobadd vps1 http://1.2.3.4:40420</code>
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

/history <code>address or alias</code>
View full epoch history for a node.

/wallet
Lihat saldo wallet dari semua node yang terdaftar.
Alamat wallet otomatis terdeteksi dari Operator address.

/bobadd <code>alias url</code>
Tambah endpoint BOB RPC dari VPS. URL boleh base URL <code>http://ip:40420</code> atau full <code>http://ip:40420/qubic</code>.

/bobcheck
Lihat status BOB RPC, tick, tick/sec, lag, latency, dan status stuck/behind.

/bobremove <code>alias</code>
Hapus endpoint BOB RPC dari monitor.

<b>🔔 Auto Alerts:</b>
Bot otomatis alert kalau node kamu:
• Offline / kembali online
• Sync score turun drastis
• Jadi ineligible / kembali eligible
• Epoch berakhir (reward summary)
• Saldo wallet berubah (incoming/outgoing)
• BOB RPC offline, stuck, behind, atau recovered

<b>Examples:</b>
<code>/add 0xami</code>
<code>/info bitos</code>
<code>/history raykiee</code>
<code>/bobadd vps1 http://1.2.3.4:40420</code>
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

  // /check — show full detail cards for each node
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

      // Delete loading message
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

      // Send header
      let header = `📋 <b>Node Terdaftar</b> (${nodes.length})\n`;
      if (stats?.epochProgress) {
        const pct = stats.epochProgress.progress_percent?.toFixed(1) || '—';
        const remaining = stats.epochProgress.time_remaining_seconds;
        const days = Math.floor(remaining / 86400);
        const hours = Math.floor((remaining % 86400) / 3600);
        header += `📅 <b>Epoch ${stats.reference?.epoch || '—'}</b> — ${pct}% (${days}d ${hours}h remaining)\n`;
      }
      if (price) {
        header += `💰 QUBIC Price: <b>$${price.toFixed(8)}</b>`;
      }
      await bot.sendMessage(chatId, header, { parse_mode: 'HTML' });

      // Send detailed card for each node
      for (const n of nodes) {
        try {
          const nodeData = await fetchNode(n.operator, n.type);
          if (nodeData && nodeData.node) {
            const card = formatNodeCard(nodeData, stats, price);
            await bot.sendMessage(chatId, card, { parse_mode: 'HTML' });
          } else {
            await bot.sendMessage(chatId,
              `⚠️ <b>${escapeHtml(n.alias)}</b> — data tidak tersedia`,
              { parse_mode: 'HTML' }
            );
          }
        } catch {
          await bot.sendMessage(chatId,
            `⚠️ <b>${escapeHtml(n.alias)}</b> — gagal fetch`,
            { parse_mode: 'HTML' }
          );
        }
      }
    } catch (err) {
      console.error('Error in /check:', err);
      await bot.editMessageText(
        `❌ Gagal fetch data: ${escapeHtml(err.message)}`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
      ).catch(() => {
        bot.sendMessage(chatId, `❌ Gagal fetch data: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
      });
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

  // /history QUERY — full epoch history
  bot.onText(/\/history(?:@\w+)?\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1].trim();

    const loadingMsg = await bot.sendMessage(chatId, '⏳ Fetching epoch history...');

    try {
      const [matches, price] = await Promise.all([
        searchNode(query),
        fetchQubicPrice(),
      ]);

      if (matches.length === 0) {
        await bot.editMessageText(
          '❌ Node tidak ditemukan.',
          { chat_id: chatId, message_id: loadingMsg.message_id }
        );
        return;
      }

      const firstNode = matches[0];
      let detailedData;
      try {
        detailedData = await fetchNode(firstNode.operator, firstNode.type);
      } catch {
        detailedData = null;
      }

      if (!detailedData || !detailedData.history || detailedData.history.length === 0) {
        await bot.editMessageText(
          `📜 <b>${escapeHtml(firstNode.alias)}</b> — belum ada epoch history.`,
          { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
        );
        return;
      }

      const node = detailedData.node;
      const type = (node?.type || '').toUpperCase();
      let msg = `📜 <b>Epoch History — ${escapeHtml(node?.alias || firstNode.alias)}</b> [${type}]\n\n`;

      // Show all epochs, newest first
      const epochs = [...detailedData.history].reverse();
      for (const h of epochs) {
        const icon = h.eligible ? '✅' : '❌';
        msg += `<b>Epoch ${h.epoch}</b> ${icon}\n`;
        msg += `├ Uptime: ${(h.uptimeScore || 0).toFixed(1)}%\n`;
        msg += `├ Sync: ${(h.syncScore || 0).toFixed(1)}%\n`;
        msg += `├ Final: ${(h.finalScore || 0).toFixed(1)}%\n`;
        msg += `├ Points: ${formatNumber(h.rewardPoints)}`;
        if (!h.eligible && h.disqualifyReason) {
          msg += `\n├ ⚠️ ${h.disqualifyReason.replace(/_/g, ' ')}`;
        }
        msg += `\n\n`;
      }

      // Delete loading and send
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

      if (msg.length > 4000) {
        // Split into multiple messages
        const chunks = [];
        let chunk = '';
        for (const line of msg.split('\n')) {
          if ((chunk + line + '\n').length > 4000) {
            chunks.push(chunk);
            chunk = '';
          }
          chunk += line + '\n';
        }
        if (chunk) chunks.push(chunk);
        for (const c of chunks) {
          await bot.sendMessage(chatId, c, { parse_mode: 'HTML' });
        }
      } else {
        await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      }
    } catch (err) {
      console.error('Error in /history:', err);
      await bot.editMessageText(
        `❌ Gagal fetch: ${escapeHtml(err.message)}`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
      ).catch(() => {
        bot.sendMessage(chatId, `❌ Gagal fetch: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
      });
    }
  });

  // /wallet — show wallet balances for all registered nodes (auto-detect from operator address)
  bot.onText(/\/wallet(?:@\w+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    const nodes = getNodesByChat(chatId);

    if (nodes.length === 0) {
      return bot.sendMessage(chatId,
        '📋 Belum ada node terdaftar.\nGunakan <code>/add address_or_alias</code> untuk menambahkan node terlebih dahulu.',
        { parse_mode: 'HTML' }
      );
    }

    // Get unique operator addresses
    const uniqueAddresses = new Map();
    for (const n of nodes) {
      if (!uniqueAddresses.has(n.operator)) {
        uniqueAddresses.set(n.operator, n.alias);
      }
    }

    const loadingMsg = await bot.sendMessage(chatId,
      `⏳ Fetching wallet balances untuk ${uniqueAddresses.size} address...`
    );

    try {
      const price = await fetchQubicPrice();

      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

      let totalBalance = 0n;
      let cardCount = 0;

      for (const [address, alias] of uniqueAddresses) {
        try {
          const balData = await fetchWalletBalance(address);
          const card = formatWalletCard(address, alias, balData, price);
          await bot.sendMessage(chatId, card, { parse_mode: 'HTML' });
          cardCount++;
          if (balData && balData.balance) {
            totalBalance += BigInt(balData.balance);
          }
        } catch (err) {
          await bot.sendMessage(chatId,
            `⚠️ <b>${escapeHtml(alias)}</b> — gagal fetch balance`,
            { parse_mode: 'HTML' }
          );
        }
      }

      // Send total summary if more than 1 address
      if (cardCount > 1) {
        let summary = `\n📊 <b>Total Balance</b>: <b>${formatNumber(Number(totalBalance))} QUBIC</b>`;
        if (price && totalBalance > 0n) {
          summary += ` (~$${(Number(totalBalance) * price).toFixed(2)})`;
        }
        await bot.sendMessage(chatId, summary, { parse_mode: 'HTML' });
      }
    } catch (err) {
      console.error('Error in /wallet:', err);
      await bot.sendMessage(chatId,
        `❌ Gagal fetch wallet data: ${escapeHtml(err.message)}`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // /bobadd ALIAS URL - monitor a BOB JSON-RPC endpoint
  bot.onText(/\/bobadd(?:@\w+)?\s+(\S+)\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const alias = match[1].trim();
    const url = match[2].trim();

    if (!/^https?:\/\//i.test(url)) {
      return bot.sendMessage(chatId,
        'URL harus diawali http:// atau https://\nContoh: <code>/bobadd vps1 http://1.2.3.4:40420</code>',
        { parse_mode: 'HTML' }
      );
    }

    const loadingMsg = await bot.sendMessage(chatId, 'Testing BOB RPC endpoint...');

    try {
      const live = await fetchBobTick(url);
      const added = addBobNode(chatId, alias, url);
      const statusLine = added ? 'BOB endpoint ditambahkan.' : 'BOB endpoint dengan alias itu sudah ada.';
      await bot.editMessageText(
        `<b>${escapeHtml(statusLine)}</b>\n` +
        `|- Alias: <b>${escapeHtml(alias)}</b>\n` +
        `|- Tick: <code>${formatNumber(live.tick)}</code>\n` +
        `|- Latency: <b>${live.latencyMs} ms</b>\n` +
        `\`- URL: <code>${escapeHtml(normalizeBobRpcUrl(url))}</code>`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
      );
    } catch (err) {
      await bot.editMessageText(
        `Gagal test BOB RPC: ${escapeHtml(err.message)}\n\n` +
        `Pastikan port 40420 bisa diakses dan endpoint <code>/qubic</code> aktif.`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
      );
    }
  });

  // /bobcheck - show BOB endpoint monitor status
  bot.onText(/\/bobcheck(?:@\w+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    const nodes = getBobNodesByChat(chatId);

    if (nodes.length === 0) {
      return bot.sendMessage(chatId,
        'Belum ada BOB endpoint.\nGunakan <code>/bobadd alias http://ip:40420</code>.',
        { parse_mode: 'HTML' }
      );
    }

    for (const node of nodes) {
      const status = getBobStatus(node.alias, node.url);
      await bot.sendMessage(chatId, formatBobStatus(node.alias, node.url, status), { parse_mode: 'HTML' });
    }
  });

  // /bobremove ALIAS
  bot.onText(/\/bobremove(?:@\w+)?\s+(\S+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const alias = match[1].trim();
    const removed = removeBobNode(chatId, alias);

    if (removed) {
      bot.sendMessage(chatId, `BOB endpoint <b>${escapeHtml(alias)}</b> dihapus.`, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(chatId, `BOB endpoint <b>${escapeHtml(alias)}</b> tidak ditemukan.`, { parse_mode: 'HTML' });
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

  bot.onText(/\/history(?:@\w+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      '⚠️ Masukkan address atau alias:\n<code>/history address_or_alias</code>\n\nContoh:\n<code>/history raykiee</code>',
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/\/bobadd(?:@\w+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      'Masukkan alias dan URL BOB RPC:\n<code>/bobadd vps1 http://1.2.3.4:40420</code>',
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/\/bobremove(?:@\w+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      'Masukkan alias BOB endpoint:\n<code>/bobremove vps1</code>',
      { parse_mode: 'HTML' }
    );
  });

  console.log('🤖 Qubic Node Monitor Bot is running...');
  return bot;
}

module.exports = { createBot };
