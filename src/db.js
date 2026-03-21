const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'qubic_monitor.db');
let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      operator TEXT NOT NULL,
      alias TEXT NOT NULL,
      type TEXT DEFAULT '',
      added_at TEXT DEFAULT (datetime('now')),
      UNIQUE(chat_id, operator, alias)
    )
  `);
  return db;
}

function addNode(chatId, operator, alias, type = '') {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO nodes (chat_id, operator, alias, type)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(chatId, operator, alias, type);
  return result.changes > 0;
}

function removeNode(chatId, operator, alias) {
  const stmt = db.prepare(`
    DELETE FROM nodes WHERE chat_id = ? AND operator = ? AND alias = ?
  `);
  const result = stmt.run(chatId, operator, alias);
  return result.changes > 0;
}

function getNodesByChat(chatId) {
  return db.prepare(`
    SELECT * FROM nodes WHERE chat_id = ? ORDER BY added_at ASC
  `).all(chatId);
}

function nodeExists(chatId, operator, alias) {
  const row = db.prepare(`
    SELECT 1 FROM nodes WHERE chat_id = ? AND operator = ? AND alias = ?
  `).get(chatId, operator, alias);
  return !!row;
}

module.exports = { init, addNode, removeNode, getNodesByChat, nodeExists };
