import { now, sleep } from '../utils.js';

/**
 * Jupiter Token API v2 activity snapshot — the "is this real people or bots?"
 * half of the entry filter.
 *
 * GMGN's smart-money bundle metrics are behind a paid balance, but Jupiter v2
 * exposes the same discrimination for free: holders, unique traders, buys vs
 * sells, and organic volume per window. A token where 1,900 trades come from
 * 130 wallets with $1.50 average size is a bot loop, not demand.
 */

const BASE_URL = (process.env.JUPITER_TOKEN_API_URL || 'https://api.jup.ag/tokens/v2').replace(/\/+$/, '');
const API_KEY = process.env.JUPITER_API_KEY || '';
const TIMEOUT_MS = clamp(Number(process.env.ACTIVITY_TIMEOUT_MS || 8000), 1000, 30_000);
const CACHE_TTL_MS = clamp(Number(process.env.ACTIVITY_CACHE_TTL_MS || 30_000), 5_000, 10 * 60_000);
const FAILURE_TTL_MS = clamp(Number(process.env.ACTIVITY_FAILURE_TTL_MS || 30_000), 5_000, 10 * 60_000);
const REQUEST_DELAY_MS = clamp(Number(process.env.ACTIVITY_REQUEST_DELAY_MS || 1200), 0, 30_000);
const MAX_CACHE_ENTRIES = 500;
const RATE_LIMIT_COOLDOWN_MS = clamp(Number(process.env.ACTIVITY_RATE_LIMIT_COOLDOWN_MS || 15_000), 1000, 5 * 60_000);

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

const cache = new Map();
const inflight = new Map();
let lastRequestAt = 0;
let cooldownUntil = 0;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const wait = Math.max(cooldownUntil - now(), 0);
  if (wait > 0) await sleep(wait);
  if (!REQUEST_DELAY_MS) return;
  const elapsed = now() - lastRequestAt;
  if (elapsed < REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS - elapsed);
  lastRequestAt = now();
}

function windowStats(stats = {}) {
  const buys = num(stats.numBuys);
  const sells = num(stats.numSells);
  const traders = num(stats.numTraders);
  const buyVolume = num(stats.buyVolume);
  const sellVolume = num(stats.sellVolume);
  const trades = buys + sells;
  const volume = buyVolume + sellVolume;
  return {
    buys,
    sells,
    traders,
    buyVolume,
    sellVolume,
    organicBuyVolume: num(stats.buyOrganicVolume),
    organicSellVolume: num(stats.sellOrganicVolume),
    priceChangePct: Number.isFinite(Number(stats.priceChange)) ? Number(stats.priceChange) : null,
    tradesPerTrader: traders > 0 ? trades / traders : null,
    tradesPerTraderBuys: traders > 0 ? buys / traders : null,
    avgTradeUsd: trades > 0 ? volume / trades : null,
    sellBuyVolumeRatio: buyVolume > 0 ? sellVolume / buyVolume : (sellVolume > 0 ? Infinity : null),
    organicShare: volume > 0 ? (num(stats.buyOrganicVolume) + num(stats.sellOrganicVolume)) / volume : null,
  };
}

export function normalizeActivity(token) {
  if (!token || typeof token !== 'object') return null;
  const audit = token.audit || {};
  const stats5m = token.stats5m || token.stats_5m || {};
  const stats1h = token.stats1h || token.stats_1h || {};
  const hasAnyStats = Object.keys(stats5m).length > 0 || Object.keys(stats1h).length > 0;
  return {
    mint: String(token.id || token.address || token.mint || ''),
    symbol: String(token.symbol || ''),
    holders: num(token.holderCount ?? token.holders),
    organicScore: num(token.organicScore),
    organicLabel: String(token.organicScoreLabel || ''),
    top10Pct: Number.isFinite(Number(audit.topHoldersPercentage)) ? Number(audit.topHoldersPercentage) : null,
    m5: windowStats(stats5m),
    h1: windowStats(stats1h),
    hasStats: hasAnyStats,
    fetchedAtMs: now(),
  };
}

export async function fetchJupiterActivity(mint) {
  const address = String(mint || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;

  const cached = cacheGet(address);
  if (cached !== undefined) return cached;
  if (inflight.has(address)) return inflight.get(address);

  const run = (async () => {
    try {
      await pace();
      const url = `${BASE_URL}/search?query=${encodeURIComponent(address)}`;
      const headers = { accept: 'application/json' };
      if (API_KEY) headers['x-api-key'] = API_KEY;
      const doFetch = () => fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      let res = await doFetch();
      if (res.status === 429) {
        // Jupiter's free host throttles hard. Back off globally, then retry once.
        cooldownUntil = now() + RATE_LIMIT_COOLDOWN_MS;
        await pace();
        res = await doFetch();
      }
      if (!res.ok) {
        if (res.status === 429) cooldownUntil = now() + RATE_LIMIT_COOLDOWN_MS;
        cacheSet(address, null, FAILURE_TTL_MS);
        return null;
      }
      const payload = await res.json();
      const token = Array.isArray(payload) ? payload[0] : payload;
      const normalized = normalizeActivity(token);
      cacheSet(address, normalized, CACHE_TTL_MS);
      return normalized;
    } catch {
      // Unknown activity is not safe activity: callers must skip, not veto.
      cacheSet(address, null, FAILURE_TTL_MS);
      return null;
    } finally {
      inflight.delete(address);
    }
  })();

  inflight.set(address, run);
  return run;
}

/**
 * Pure gate over the activity snapshot. Every knob is opt-in (`0` = off) so a
 * missing value never silently blocks or silently passes a trade.
 */
export function activityFailures(strategy = {}, activity = null) {
  if (!activity || !activity.hasStats) return [];
  const failures = [];
  const maxTradesPerTrader = Number(strategy.max_trades_per_trader_5m ?? 0);
  const minAvgTradeUsd = Number(strategy.min_avg_trade_usd_5m ?? 0);
  const maxSellBuyRatio = Number(strategy.max_sell_buy_ratio_5m ?? 0);
  const maxDropPct = Number(strategy.max_price_drop_5m_pct ?? 0);
  const m5 = activity.m5;

  if (maxTradesPerTrader > 0 && Number.isFinite(m5.tradesPerTrader) && m5.tradesPerTrader > maxTradesPerTrader) {
    failures.push(`bot churn: ${m5.tradesPerTrader.toFixed(1)} trades/trader > ${maxTradesPerTrader}`);
  }
  if (minAvgTradeUsd > 0 && Number.isFinite(m5.avgTradeUsd) && m5.avgTradeUsd < minAvgTradeUsd) {
    failures.push(`dust trades: avg $${m5.avgTradeUsd.toFixed(2)} < $${minAvgTradeUsd}`);
  }
  if (maxSellBuyRatio > 0 && m5.sellBuyVolumeRatio !== null && m5.sellBuyVolumeRatio > maxSellBuyRatio) {
    failures.push(`dump pressure: sell/buy ${m5.sellBuyVolumeRatio.toFixed(1)}x > ${maxSellBuyRatio}x`);
  }
  if (maxDropPct < 0 && m5.priceChangePct !== null && m5.priceChangePct < maxDropPct) {
    failures.push(`already dumping: ${m5.priceChangePct.toFixed(0)}% in 5m < ${maxDropPct}%`);
  }
  return failures;
}

export function activitySummary(activity) {
  if (!activity) return 'activity: unavailable';
  if (!activity.hasStats) return `activity: no stats (holders ${activity.holders})`;
  const m5 = activity.m5;
  return [
    `holders ${activity.holders}`,
    `5m ${m5.buys}b/${m5.sells}s`,
    `${m5.traders} traders`,
    m5.tradesPerTrader === null ? null : `${m5.tradesPerTrader.toFixed(1)}/trader`,
    m5.avgTradeUsd === null ? null : `avg $${m5.avgTradeUsd.toFixed(0)}`,
  ].filter(Boolean).join(' · ');
}
