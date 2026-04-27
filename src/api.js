const BASE_URL = 'https://guardians.qubic.org/api/v1';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=qubic-network&vs_currencies=usd';

const HEADERS = {
  'accept': '*/*',
  'user-agent': 'QubicMonitorBot/1.0',
};

async function fetchNode(operator, type) {
  const url = `${BASE_URL}/nodes/${encodeURIComponent(operator)}/${encodeURIComponent(type)}`;
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Node API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchAllNodes() {
  const res = await fetch(`${BASE_URL}/nodes`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Nodes list API error: ${res.status}`);
  return res.json();
}

/**
 * Search for a node by address (operator) or alias.
 * Returns matching nodes from the full node list.
 */
async function searchNode(query) {
  const allNodes = await fetchAllNodes();
  const q = query.toLowerCase().trim();

  // Try exact operator match first
  const byOperator = allNodes.filter(n => n.operator.toLowerCase() === q);
  if (byOperator.length > 0) return byOperator;

  // Try exact alias match
  const byAlias = allNodes.filter(n => n.alias.toLowerCase() === q);
  if (byAlias.length > 0) return byAlias;

  // Try partial alias match
  const byPartial = allNodes.filter(n => n.alias.toLowerCase().includes(q));
  if (byPartial.length > 0) return byPartial;

  return [];
}

async function fetchStats() {
  const res = await fetch(`${BASE_URL}/stats`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Stats API error: ${res.status}`);
  return res.json();
}

async function fetchQubicPrice() {
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data['qubic-network']?.usd ?? null;
  } catch {
    return null;
  }
}

const QUBIC_RPC_URL = 'https://rpc.qubic.org/live/v1/balances';
const QUBIC_STATUS_URL = process.env.QUBIC_STATUS_URL || 'https://rpc.qubic.org/v1/tick-info';

async function fetchWalletBalance(address) {
  const url = `${QUBIC_RPC_URL}/${encodeURIComponent(address)}`;
  const res = await fetch(url, {
    headers: {
      'accept': '*/*',
      'origin': 'https://explorer.qubic.org',
      'referer': 'https://explorer.qubic.org/',
      'user-agent': 'QubicMonitorBot/1.0',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Wallet API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.balance || null;
}

async function fetchReferenceTick() {
  const res = await fetch(QUBIC_STATUS_URL, {
    headers: HEADERS,
    signal: AbortSignal.timeout(Number(process.env.BOB_RPC_TIMEOUT_MS || 10000)),
  });
  if (!res.ok) throw new Error(`Reference tick API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const tick = parseTickValue(data?.tickInfo?.tick ?? data?.tick ?? data?.currentTick);
  if (tick == null) throw new Error('Reference tick API did not return a tick');
  return tick;
}

async function fetchBobTick(url) {
  const endpoint = normalizeBobRpcUrl(url);
  const startedAt = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'user-agent': 'QubicMonitorBot/1.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'qubic_getTickNumber',
      params: [],
      id: 1,
    }),
    signal: AbortSignal.timeout(Number(process.env.BOB_RPC_TIMEOUT_MS || 10000)),
  });

  const latencyMs = Date.now() - startedAt;
  if (!res.ok) throw new Error(`BOB RPC error: ${res.status} ${res.statusText}`);

  const data = await res.json();
  if (data.error) {
    const message = data.error.message || JSON.stringify(data.error);
    throw new Error(`BOB RPC returned error: ${message}`);
  }

  const tick = parseTickValue(
    data.result?.tick ??
    data.result?.tickNumber ??
    data.result?.number ??
    data.result
  );
  if (tick == null) throw new Error('BOB RPC did not return a tick number');

  return { tick, latencyMs, endpoint };
}

function normalizeBobRpcUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (!clean) throw new Error('BOB RPC URL is empty');
  if (clean.endsWith('/qubic')) return clean;
  return `${clean}/qubic`;
}

function parseTickValue(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return Number.parseInt(trimmed, 16);
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    return parseTickValue(value.tick ?? value.tickNumber ?? value.number);
  }
  return null;
}

module.exports = {
  fetchNode,
  fetchAllNodes,
  searchNode,
  fetchStats,
  fetchQubicPrice,
  fetchWalletBalance,
  fetchReferenceTick,
  fetchBobTick,
  normalizeBobRpcUrl,
};
