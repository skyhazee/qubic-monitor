require('dotenv').config();
const db = require('./db');
const { createBot } = require('./bot');

// Validate token
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || token === 'your_telegram_bot_token_here') {
  console.error('❌ TELEGRAM_BOT_TOKEN belum di-set!');
  console.error('   1. Copy .env.example ke .env');
  console.error('   2. Isi token dari @BotFather');
  process.exit(1);
}

// Initialize database
db.init();
console.log('✅ Database initialized');

// Start bot
const bot = createBot(token);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  bot.stopPolling();
  process.exit(0);
});
