import { now, sleep } from '../utils.js';

/**
 * DexScreener fallback for price, market cap and liquidity.
 *
 * Jupiter indexes a freshly migrated token a few seconds late and reports a
 * meaningless market cap in the meantime (a token that just graduated at 60k
 * shows up as 59 USD). That single number was rejecting real graduations on
 * `market cap min`, so any candidate without a sane mcap now gets a second
 * opinion here. Keyless, one call per candidate.
 */

const BASE_URL = (process.env.DEXSCREENER_API_URL || 'https://api.dexscreener.com').replace(/\/+$/, '');
const TIMEOUT_MS = clamp(Number(process.env.DEXSCREENER_TIMEOUT_MS || 8000), 1000, 30_000);
const CACHE_TTL_MS = clamp(Number(process.env.DEXSCREENER_CACHE_TTL_MS || 20_000), 5_000, 10 * 60_000);
const FAILURE_TTL_MS = clamp(Number(process.env.DEXSCREENER_FAILURE_TTL_MS || 30_000), 5_000, 10 * 60_000);
const REQUEST_DELAY_MS = clamp(Number(process.env.DEXSCREENER_REQUEST_DELAY_MS || 300), 0, 10_000);
const MAX_CACHE_ENTRIES = 500;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

const cache = new Map();
const inflight = new Map();
let lastRequestAt = 0;

function positive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cacheGet(mint) {
  const entry = cache.get(mint);
  if (!entry) return undefined;
  if (entry.expiresAtMs <= now()) {
    cache.delete(mint);
    return undefined;
  }
  return entry.value;
}

function cacheSet(mint, value, ttlMs) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(mint, { value, expiresAtMs: now() + ttlMs });
}

async function pace() {
  if (!REQUEST_DELAY_MS) return;
  const elapsed = now() - lastRequestAt;
  if (elapsed < REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS - elapsed);
  lastRequestAt = now();
}

/**
 * Picks the deepest pair. A token can have a pumpfun pair with no liquidity and
 * a pumpswap pair with real depth; the deepest one is the tradable market.
 */
export function pickPair(pairs = []) {
  const usable = (Array.isArray(pairs) ? pairs : [])
    .filter(pair => pair && (positive(pair.priceUsd) || positive(pair.fdv) || positive(pair.marketCap)))
    .sort((a, b) => (positive(b?.liquidity?.usd) || 0) - (positive(a?.liquidity?.usd) || 0));
  return usable[0] || null;
}

export function normalizeDexScreener(payload) {
  const pair = pickPair(payload?.pairs);
  if (!pair) return null;
  return {
    mint: String(pair.baseToken?.address || ''),
    symbol: String(pair.baseToken?.symbol || ''),
    dexId: String(pair.dexId || ''),
    pairAddress: String(pair.pairAddress || ''),
    priceUsd: positive(pair.priceUsd),
    fdv: positive(pair.fdv),
    marketCap: positive(pair.marketCap),
    liquidityUsd: positive(pair?.liquidity?.usd),
    volume24h: positive(pair?.volume?.h24),
    priceChange5m: Number.isFinite(Number(pair?.priceChange?.m5)) ? Number(pair.priceChange.m5) : null,
    pairCreatedAtMs: positive(pair.pairCreatedAt),
    fetchedAtMs: now(),
  };
}

export async function fetchDexScreenerToken(mint) {
  const address = String(mint || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;

  const cached = cacheGet(address);
  if (cached !== undefined) return cached;
  if (inflight.has(address)) return inflight.get(address);

  const run = (async () => {
    try {
      await pace();
      const res = await fetch(`${BASE_URL}/latest/dex/tokens/${encodeURIComponent(address)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        cacheSet(address, null, FAILURE_TTL_MS);
        return null;
      }
      const normalized = normalizeDexScreener(await res.json());
      cacheSet(address, normalized, CACHE_TTL_MS);
      return normalized;
    } catch {
      cacheSet(address, null, FAILURE_TTL_MS);
      return null;
    } finally {
      inflight.delete(address);
    }
  })();

  inflight.set(address, run);
  return run;
}

/** Market cap from DexScreener, preferring the fully diluted value. */
export function dexscreenerMarketCap(info) {
  if (!info) return null;
  return info.fdv || info.marketCap || null;
}
