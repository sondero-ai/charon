import { now, sleep } from '../utils.js';

/**
 * Rugcheck.xyz client — the free replacement for the safety half of GMGN.
 *
 * We only use it for pre-entry risk data (rug history, LP lock, danger flags),
 * never for price or liquidity (Jupiter/DexScreener are better sources for
 * that). The API is keyless, so a failure here must degrade to "unknown",
 * never to "safe".
 */

const ENABLED = process.env.RUGCHECK_ENABLED !== 'false';
const BASE_URL = (process.env.RUGCHECK_BASE_URL || 'https://api.rugcheck.xyz/v1').replace(/\/+$/, '');
const TIMEOUT_MS = clamp(Number(process.env.RUGCHECK_TIMEOUT_MS || 8000), 1000, 30_000);
const CACHE_TTL_MS = clamp(Number(process.env.RUGCHECK_CACHE_TTL_MS || 5 * 60_000), 10_000, 60 * 60_000);
const FAILURE_TTL_MS = clamp(Number(process.env.RUGCHECK_FAILURE_TTL_MS || 60_000), 5_000, 10 * 60_000);
const REQUEST_DELAY_MS = clamp(Number(process.env.RUGCHECK_REQUEST_DELAY_MS || 1200), 0, 30_000);
const MAX_CACHE_ENTRIES = clamp(Number(process.env.RUGCHECK_MAX_CACHE_ENTRIES || 500), 50, 5000);

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

const cache = new Map();
const inflight = new Map();
let lastRequestAt = 0;

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

function finiteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Normalises the raw report into the small shape the strategy gate uses.
 * Exported so tests can pin behaviour without touching the network.
 */
export function normalizeReport(report) {
  if (!report || typeof report !== 'object') return null;
  const risks = Array.isArray(report.risks)
    ? report.risks
      .map(risk => ({
        name: String(risk?.name || '').trim(),
        level: String(risk?.level || '').trim().toLowerCase(),
        score: finiteOrNull(risk?.score),
        description: String(risk?.description || '').trim(),
      }))
      .filter(risk => risk.name)
    : [];
  const markets = Array.isArray(report.markets) ? report.markets : [];
  const lockedPcts = markets
    .map(market => finiteOrNull(market?.lp?.lpLockedPct))
    .filter(value => value !== null);
  const token = report.token || {};
  return {
    mint: String(report.mint || ''),
    score: finiteOrNull(report.score_normalised) ?? finiteOrNull(report.score),
    scoreRaw: finiteOrNull(report.score),
    rugged: report.rugged === true,
    risks,
    riskCount: risks.length,
    dangerCount: risks.filter(risk => risk.level === 'danger').length,
    warnCount: risks.filter(risk => risk.level === 'warn' || risk.level === 'warning').length,
    creatorRugged: risks.some(risk => /rug/i.test(risk.name)),
    lpLockedPct: lockedPcts.length ? Math.max(...lockedPcts) : null,
    totalHolders: finiteOrNull(report.totalHolders),
    mintAuthority: token.mintAuthority ?? report.mintAuthority ?? null,
    freezeAuthority: token.freezeAuthority ?? report.freezeAuthority ?? null,
    tokenProgram: String(report.tokenProgram || ''),
    fetchedAtMs: now(),
  };
}

/**
 * Returns the normalised report, or null when the lookup failed. Callers must
 * treat null as "unknown risk", not as "no risk".
 */
export async function fetchRugcheckReport(mint) {
  if (!ENABLED) return null;
  const address = String(mint || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;

  const cached = cacheGet(address);
  if (cached !== undefined) return cached;
  if (inflight.has(address)) return inflight.get(address);

  const run = (async () => {
    try {
      await pace();
      const res = await fetch(`${BASE_URL}/tokens/${encodeURIComponent(address)}/report`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        cacheSet(address, null, FAILURE_TTL_MS);
        return null;
      }
      const payload = await res.json();
      const normalized = normalizeReport(payload);
      cacheSet(address, normalized, CACHE_TTL_MS);
      return normalized;
    } catch {
      // Timeouts, DNS failures and rate limits all mean "unknown", not "safe".
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
 * Strategy gate for Rugcheck data. Pure: no DB, no network, so the money path
 * can be tested. Every rule is opt-in via a strategy value > 0 / === 1, which
 * keeps the filter in observe mode until an operator enables it.
 */
export function rugcheckFailures(strategy = {}, rugcheck = null) {
  if (!rugcheck) return [];
  const failures = [];
  const maxScore = Number(strategy.max_rugcheck_score ?? 0);
  const maxDangers = Number(strategy.rugcheck_max_dangers ?? 0);
  const minLpLockedPct = Number(strategy.min_lp_locked_pct ?? 0);
  const rejectRugged = Number(strategy.rugcheck_reject_rugged ?? 0) === 1;

  if (rejectRugged && rugcheck.rugged === true) {
    failures.push('rugcheck: token flagged as rugged');
  }
  if (maxScore > 0 && Number.isFinite(rugcheck.score) && rugcheck.score > maxScore) {
    failures.push(`rugcheck score: ${rugcheck.score} > ${maxScore}`);
  }
  if (maxDangers > 0 && rugcheck.dangerCount > maxDangers) {
    failures.push(`rugcheck danger flags: ${rugcheck.dangerCount} > ${maxDangers}`);
  }
  if (minLpLockedPct > 0 && Number.isFinite(rugcheck.lpLockedPct) && rugcheck.lpLockedPct < minLpLockedPct) {
    failures.push(`LP locked: ${rugcheck.lpLockedPct}% < ${minLpLockedPct}%`);
  }
  return failures;
}

/** Short human line for logs and Telegram alerts. */
export function rugcheckSummary(rugcheck) {
  if (!rugcheck) return 'rugcheck: unavailable';
  const risks = rugcheck.risks.slice(0, 3).map(risk => risk.name).join(', ');
  return [
    `score ${rugcheck.score ?? '?'}`,
    `${rugcheck.dangerCount} danger`,
    rugcheck.lpLockedPct === null ? 'LP ?' : `LP locked ${rugcheck.lpLockedPct}%`,
    rugcheck.rugged ? 'RUGGED' : null,
    risks ? `(${risks})` : null,
  ].filter(Boolean).join(' · ');
}
