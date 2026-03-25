const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');

let data = { nodes: [], nodeStatus: {}, walletBalances: {} };

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
      if (!data.nodes) data.nodes = [];
      if (!data.nodeStatus) data.nodeStatus = {};
      if (!data.walletBalances) data.walletBalances = {};
    }
  } catch {
    data = { nodes: [], nodeStatus: {}, walletBalances: {} };
  }
}

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function init() {
  load();
  console.log(`✅ Loaded ${data.nodes.length} node entries`);
}

function addNode(chatId, operator, alias, type = '') {
  if (nodeExistsByOperator(chatId, operator, type)) return false;
  data.nodes.push({
    chat_id: chatId,
    operator,
    alias,
    type,
    added_at: new Date().toISOString(),
  });
  save();
  return true;
}

function removeNode(chatId, operator, type) {
  const before = data.nodes.length;
  data.nodes = data.nodes.filter(n =>
    !(n.chat_id === chatId && n.operator === operator && n.type === type)
  );
  if (data.nodes.length < before) {
    save();
    return true;
  }
  return false;
}

function removeNodeByAlias(chatId, alias) {
  const before = data.nodes.length;
  data.nodes = data.nodes.filter(n =>
    !(n.chat_id === chatId && n.alias.toLowerCase() === alias.toLowerCase())
  );
  if (data.nodes.length < before) {
    save();
    return true;
  }
  return false;
}

function getNodesByChat(chatId) {
  return data.nodes.filter(n => n.chat_id === chatId);
}

function getAllNodes() {
  return data.nodes;
}

function getAllChatIds() {
  return [...new Set(data.nodes.map(n => n.chat_id))];
}

function nodeExistsByOperator(chatId, operator, type) {
  return data.nodes.some(n =>
    n.chat_id === chatId && n.operator === operator && n.type === type
  );
}

// Status tracking for alerts
function getNodeStatus(operator, type) {
  const key = `${operator}:${type}`;
  return data.nodeStatus[key] || null;
}

function setNodeStatus(operator, type, status) {
  const key = `${operator}:${type}`;
  data.nodeStatus[key] = status;
  save();
}

// Wallet balance tracking
function getWalletBalance(address) {
  return data.walletBalances[address] || null;
}

function setWalletBalance(address, balanceData) {
  data.walletBalances[address] = balanceData;
  save();
}

module.exports = {
  init, addNode, removeNode, removeNodeByAlias,
  getNodesByChat, getAllNodes, getAllChatIds,
  nodeExistsByOperator, getNodeStatus, setNodeStatus,
  getWalletBalance, setWalletBalance,
};
