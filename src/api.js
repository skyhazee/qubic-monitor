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

module.exports = { fetchNode, fetchAllNodes, searchNode, fetchStats, fetchQubicPrice };
