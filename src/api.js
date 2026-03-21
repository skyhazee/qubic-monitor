const BASE_URL = 'https://guardians.qubic.org/api/v1';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=qubic-network&vs_currencies=usd';

async function fetchNode(operator, alias) {
  const url = `${BASE_URL}/nodes/${encodeURIComponent(operator)}/${encodeURIComponent(alias)}`;
  const res = await fetch(url, {
    headers: {
      'accept': '*/*',
      'user-agent': 'QubicMonitorBot/1.0',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Node API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${BASE_URL}/stats`, {
    headers: {
      'accept': '*/*',
      'user-agent': 'QubicMonitorBot/1.0',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Stats API error: ${res.status}`);
  return res.json();
}

async function fetchQubicPrice() {
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: {
        'accept': '*/*',
        'user-agent': 'QubicMonitorBot/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data['qubic-network']?.usd ?? null;
  } catch {
    return null;
  }
}

module.exports = { fetchNode, fetchStats, fetchQubicPrice };
