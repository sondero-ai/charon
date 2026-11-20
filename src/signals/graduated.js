import axios from 'axios';
import { JSON_HEADERS, GRADUATED_LOOKBACK_MS } from '../config.js';
import { now } from '../utils.js';

export const graduated = new Map();
let failures = 0;
let pausedUntil = 0;

// pump.fun's own API answers with a Cloudflare challenge from datacenter IPs, so
// the default source is GeckoTerminal's new-pools feed filtered to PumpSwap: a
// PumpSwap pool only exists once a bonding curve has graduated.
const GRADUATED_SOURCE = (process.env.GRADUATED_SOURCE || 'geckoterminal').toLowerCase();
const GECKO_PAGES = Math.max(1, Number(process.env.GRADUATED_GECKO_PAGES || 2));

async function fetchFromPumpFun() {
  if (Date.now() < pausedUntil) return;
  try {
    const res = await axios.get('https://advanced-api-v2.pump.fun/coins/graduated', {
      timeout: 10_000,
      headers: JSON_HEADERS,
    });
    const coins = Array.isArray(res.data?.coins) ? res.data.coins : [];
    const cutoff = now() - GRADUATED_LOOKBACK_MS;
    for (const coin of coins) {
      const mint = coin?.coinMint;
      if (!mint) continue;
      const graduationDate = Number(coin.graduationDate || 0);
      if (graduationDate > 0 && graduationDate < cutoff) continue;
      graduated.set(mint, { ...coin, seenAt: now() });
    }
    for (const [mint, coin] of graduated) {
      const ts = Number(coin.graduationDate || coin.seenAt || 0);
      if (ts > 0 && ts < cutoff) graduated.delete(mint);
    }
    failures = 0;
    console.log(`[graduated] loaded ${coins.length}, tracking ${graduated.size}`);
  } catch (err) {
    // This endpoint sits behind a Cloudflare challenge on some hosts. Log once,
    // then back off for ten minutes instead of retrying every poll forever.
    failures += 1;
    if (failures === 1) console.log(`[graduated] ${err.message}`);
    if (failures >= 3) {
      failures = 0;
      pausedUntil = Date.now() + 10 * 60_000;
      console.log('[graduated] source unavailable, paused for 10m (migration watcher still feeds this map)');
    }
  }
}

function coinFromGeckoPool(pool) {
  const attributes = pool?.attributes || {};
  const baseId = pool?.relationships?.base_token?.data?.id || '';
  const mint = String(baseId).replace(/^solana_/, '');
  if (!mint) return null;
  const label = String(attributes.name || '').split(' / ')[0].trim();
  const marketCap = Number(attributes.fdv_usd || attributes.market_cap_usd || 0) || null;
  return {
    coinMint: mint,
    name: label,
    ticker: label.split(/\s+/)[0] || label,
    marketCap,
    usd_market_cap: marketCap,
    priceUsd: Number(attributes.base_token_price_usd || 0) || null,
    liquidityUsd: Number(attributes.reserve_in_usd || 0) || null,
    volume: Number(attributes.volume_usd?.h24 || 0) || 0,
    poolAddress: attributes.address || null,
    graduationDate: now(),
    seenAt: now(),
    source: 'geckoterminal_pumpswap',
  };
}

async function fetchFromGeckoTerminal() {
  if (Date.now() < pausedUntil) return;
  const cutoff = now() - GRADUATED_LOOKBACK_MS;
  let pools = 0;
  let mapped = 0;
  for (let page = 1; page <= GECKO_PAGES; page += 1) {
    let res;
    try {
      res = await axios.get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools', {
        timeout: 12_000,
        params: { page },
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      // Free tier is 30 calls/min; a 429 means back off for a minute, not retry.
      if (err.response?.status === 429) {
        pausedUntil = Date.now() + 60_000;
        console.log('[graduated] geckoterminal rate limited, paused 60s');
      } else {
        console.log(`[graduated] geckoterminal ${err.message}`);
      }
      return;
    }
    const rows = Array.isArray(res.data?.data) ? res.data.data : [];
    pools += rows.length;
    for (const row of rows) {
      const dexId = row?.relationships?.dex?.data?.id;
      if (dexId !== 'pumpswap') continue;
      const coin = coinFromGeckoPool(row);
      if (!coin) continue;
      const existing = graduated.get(coin.coinMint);
      // Keep the first graduation timestamp so the lookback prune stays honest.
      if (existing?.graduationDate) coin.graduationDate = existing.graduationDate;
      graduated.set(coin.coinMint, coin);
      mapped += 1;
    }
  }
  for (const [mint, coin] of graduated) {
    const ts = Number(coin.graduationDate || coin.seenAt || 0);
    if (ts > 0 && ts < cutoff) graduated.delete(mint);
  }
  console.log(`[graduated] gecko pools ${pools}, pumpswap ${mapped}, tracking ${graduated.size}`);
}

export async function fetchGraduatedCoins() {
  if (GRADUATED_SOURCE === 'pumpfun') {
    return fetchFromPumpFun();
  }
  return fetchFromGeckoTerminal();
}
