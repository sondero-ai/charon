import axios from 'axios';
import { JSON_HEADERS, GRADUATED_LOOKBACK_MS } from '../config.js';
import { now } from '../utils.js';

export const graduated = new Map();
let failures = 0;
let pausedUntil = 0;

export async function fetchGraduatedCoins() {
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
