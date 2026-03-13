// api/search.js — Serper.dev proxy with Mullvad SOCKS5 VPN for privacy
// All outgoing search requests route through Mullvad to prevent IP leakage

const { SocksProxyAgent } = require('socks-proxy-agent');

const MULLVAD_TIMEOUT = 5000;

function createProxyAgent() {
  const proxyUrl = process.env.MULLVAD_PROXY || 'socks5://nl-ams-wg-socks5-001.relays.mullvad.net:1080';
  return new SocksProxyAgent(proxyUrl, { timeout: MULLVAD_TIMEOUT });
}

/**
 * Fetch via Mullvad SOCKS5 proxy with automatic fallback to direct.
 * Only used for Serper.dev calls — not for Anthropic/sanctions.io.
 */
async function fetchViaProxy(url, options = {}) {
  const mullvadEnabled = process.env.MULLVAD_ENABLED !== 'false';

  if (mullvadEnabled) {
    try {
      const agent = createProxyAgent();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MULLVAD_TIMEOUT);

      const resp = await fetch(url, {
        ...options,
        agent,
        signal: controller.signal
      });

      clearTimeout(timeout);
      return resp;
    } catch (err) {
      console.warn('MULLVAD_FALLBACK:', err.message, '— falling back to direct connection');
    }
  }

  // Direct fallback (no proxy)
  return fetch(url, options);
}

/**
 * Serper Google search
 */
async function serperGoogle(query, opts = {}) {
  const resp = await fetchViaProxy('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      q: query,
      gl: opts.gl || 'nl',
      hl: opts.hl || 'nl',
      num: opts.num || 5
    })
  });

  const data = await resp.json();
  return (data.organic || []).map(r => ({
    titel: r.title,
    link: r.link,
    snippet: r.snippet,
    bron: opts.bron || 'Google'
  }));
}

/**
 * Serper News search
 */
async function serperNews(query, opts = {}) {
  const resp = await fetchViaProxy('https://google.serper.dev/news', {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      q: query,
      gl: opts.gl || 'nl',
      hl: opts.hl || 'nl',
      num: opts.num || 10,
      tbs: opts.tbs || 'qdr:y5'
    })
  });

  const data = await resp.json();
  return (data.news || []).map(r => ({
    titel: r.title,
    link: r.link,
    snippet: r.snippet,
    datum: r.date,
    bron: r.source || 'Nieuws'
  }));
}

module.exports = { fetchViaProxy, serperGoogle, serperNews };
