const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');

let data = {
  nodes: [],
  nodeStatus: {},
  walletBalances: {},
  bobNodes: [],
  bobStatus: {},
};

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
      if (!data.nodes) data.nodes = [];
      if (!data.nodeStatus) data.nodeStatus = {};
      if (!data.walletBalances) data.walletBalances = {};
      if (!data.bobNodes) data.bobNodes = [];
      if (!data.bobStatus) data.bobStatus = {};
    }
  } catch {
    data = { nodes: [], nodeStatus: {}, walletBalances: {}, bobNodes: [], bobStatus: {} };
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

function normalizeBobUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (clean.endsWith('/qubic')) return clean;
  return `${clean}/qubic`;
}

function addBobNode(chatId, alias, url) {
  const cleanAlias = String(alias || '').trim();
  const cleanUrl = normalizeBobUrl(url);
  if (!cleanAlias || !cleanUrl) return false;
  if (bobNodeExists(chatId, cleanAlias)) return false;

  data.bobNodes.push({
    chat_id: chatId,
    alias: cleanAlias,
    url: cleanUrl,
    added_at: new Date().toISOString(),
  });
  save();
  return true;
}

function removeBobNode(chatId, alias) {
  const before = data.bobNodes.length;
  data.bobNodes = data.bobNodes.filter(n =>
    !(n.chat_id === chatId && n.alias.toLowerCase() === String(alias).toLowerCase())
  );
  if (data.bobNodes.length < before) {
    save();
    return true;
  }
  return false;
}

function getBobNodesByChat(chatId) {
  return data.bobNodes.filter(n => n.chat_id === chatId);
}

function getAllBobNodes() {
  return data.bobNodes;
}

function bobNodeExists(chatId, alias) {
  return data.bobNodes.some(n =>
    n.chat_id === chatId && n.alias.toLowerCase() === String(alias).toLowerCase()
  );
}

function getBobStatus(alias, url) {
  const key = normalizeBobUrl(url);
  return data.bobStatus[key] || null;
}

function setBobStatus(alias, url, status) {
  const key = normalizeBobUrl(url);
  data.bobStatus[key] = status;
  save();
}

module.exports = {
  init, addNode, removeNode, removeNodeByAlias,
  getNodesByChat, getAllNodes, getAllChatIds,
  nodeExistsByOperator, getNodeStatus, setNodeStatus,
  getWalletBalance, setWalletBalance,
  addBobNode, removeBobNode, getBobNodesByChat, getAllBobNodes,
  bobNodeExists, getBobStatus, setBobStatus,
};
