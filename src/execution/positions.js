import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { liveWalletPubkey } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();
let monitorRunning = false;
const MISSING_DATA_EXIT_CYCLES = Math.max(1, Number(process.env.MISSING_DATA_EXIT_CYCLES || 3));

function pnlPercentFromMarket(position, liveMcap, livePrice, jupiterPnl) {
  const entryMcap = Number(position.entry_mcap);
  const entryPrice = Number(position.entry_price);
  if (Number.isFinite(liveMcap) && liveMcap > 0 && Number.isFinite(entryMcap) && entryMcap > 0) {
    return (liveMcap / entryMcap - 1) * 100;
  }
  if (Number.isFinite(livePrice) && livePrice > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
    return (livePrice / entryPrice - 1) * 100;
  }
  const walletPnl = Number(jupiterPnl?.totalPnlPercentageNative);
  return Number.isFinite(walletPnl) ? walletPnl : null;
}

async function runPartialTp({ position, strat, pnlPercent, price, mcap }) {
  const percent = Number(strat.partial_tp_sell_percent);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) return false;
  if (position.execution_mode !== 'live') {
    db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
    return true;
  }
  if (!position.token_amount_raw) {
    console.log(`[position] ${position.id} partial TP skipped: no confirmed token amount`);
    return false;
  }
  const total = Number(position.token_amount_raw);
  const sellAmount = Math.floor(total * percent / 100);
  if (!(sellAmount > 0)) return false;
  let sell;
  try {
    sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP', { exact: true });
  } catch (err) {
    // The flag stays unset so the next cycle retries: a failed partial sell
    // must never disable the rule permanently.
    console.log(`[position] ${position.id} partial TP failed, will retry: ${err.message}`);
    return false;
  }
  const receivedSol = Number(sell.outputAmount || 0) > 0 ? Number(sell.outputAmount) / 1_000_000_000 : 0;
  const remaining = total - sellAmount;
  db.transaction(() => {
    db.prepare(`
      UPDATE dry_run_positions
      SET partial_tp_done = 1, token_amount_raw = ?, realized_sol = COALESCE(realized_sol, 0) + ?
      WHERE id = ?
    `).run(String(remaining), receivedSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
    `).run(position.id, position.mint, now(), price, mcap,
      position.size_sol * (percent / 100), sellAmount,
      json({ pnlPercent, sell, partialSellPercent: percent, remaining, receivedSol }));
  })();
  console.log(`[position] ${position.id} partial TP sold ${sellAmount} for ${receivedSol} SOL, ${remaining} left`);
  return true;
}

/**
 * Pure exit decision, so the money rules can be tested without a network call.
 * Order: max hold (time-based, always valid) → missing data escalation →
 * stop loss → take profit → trailing.
 */
export function evaluateExitReason({ position, pnlPercent, dataMissing, missingCycles, strat, highWaterMcap, mcap, nowMs = now() }) {
  if (Number(strat?.max_hold_ms) > 0 && (nowMs - Number(position.opened_at_ms)) >= Number(strat.max_hold_ms)) {
    return 'MAX_HOLD';
  }
  if (dataMissing) {
    return missingCycles >= MISSING_DATA_EXIT_CYCLES ? 'NO_MARKET_DATA' : null;
  }
  if (!Number.isFinite(Number(pnlPercent))) return null;
  const slHit = Number(pnlPercent) <= Number(position.sl_percent);
  const tpHit = Number(pnlPercent) >= Number(position.tp_percent);
  const trailingArmed = Boolean(position.trailing_armed) || (Boolean(position.trailing_enabled) && tpHit);
  const trailDrop = Number(highWaterMcap) > 0 && Number(mcap) > 0
    ? (Number(mcap) / Number(highWaterMcap) - 1) * 100
    : 0;
  const trailingHit = trailingArmed && Boolean(position.trailing_enabled)
    && trailDrop <= -Math.abs(Number(position.trailing_percent));
  if (slHit) return 'SL';
  if (tpHit && !position.trailing_enabled) return 'TP';
  if (trailingHit) return 'TRAILING_TP';
  return null;
}

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  const asset = await fetchJupiterAsset(position.mint);
  const liveMcap = firstPositiveNumber(asset?.mcap, asset?.fdv);
  const livePrice = firstPositiveNumber(asset?.usdPrice);
  // Display values fall back to the last high-water mark, but PnL and every exit
  // rule use live data only — a stale fallback must not look like a flat market.
  const mcap = firstPositiveNumber(liveMcap, position.high_water_mcap, position.entry_mcap);
  const price = firstPositiveNumber(livePrice, position.high_water_price, position.entry_price);
  const pnlPercent = pnlPercentFromMarket(position, liveMcap, livePrice, jupiterPnl);
  const dataMissing = pnlPercent == null;
  const missingCycles = dataMissing ? Number(position.missing_data_cycles || 0) + 1 : 0;
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap || 0));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  const effectivePnl = dataMissing ? 0 : pnlPercent;
  let pnlSol = Number(position.size_sol) * effectivePnl / 100;
  if (dataMissing) pnlSol = 0;
  else if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlNative))) pnlSol = Number(jupiterPnl.totalPnlNative);
  const tpHit = !dataMissing && pnlPercent >= Number(position.tp_percent);
  const trailingArmed = Boolean(position.trailing_armed) || (Boolean(position.trailing_enabled) && tpHit);
  const strat = strategyById(position.strategy_id);
  let exitReason = evaluateExitReason({
    position, pnlPercent, dataMissing, missingCycles, strat, highWaterMcap, mcap,
  });

  // Partial TP only on confirmed profit; the flag is written after the fill.
  if (!exitReason && !dataMissing && strat?.partial_tp && !position.partial_tp_done
    && pnlPercent >= Number(strat.partial_tp_at_percent)) {
    await runPartialTp({ position, strat, pnlPercent, price, mcap });
  }

  let finalPnlPercent = effectivePnl;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?,
        missing_data_cycles = ?, last_checked_at_ms = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0, missingCycles, now(), position.id);

  if (dataMissing && missingCycles === 1) {
    console.log(`[position] ${position.id} market data missing (1/${MISSING_DATA_EXIT_CYCLES}) — exit armed`);
  }

  let closed = false;
  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } catch (err) {
      // Never mark a position closed when the sell did not land.
      console.log(`[position] ${position.id} exit ${exitReason} blocked: ${err.message}`);
      db.prepare('UPDATE dry_run_positions SET close_attempts = COALESCE(close_attempts, 0) + 1 WHERE id = ?').run(position.id);
      return { ...position, exitReason: null, exitError: err.message };
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    const realizedBefore = Number(position.realized_sol || 0);
    if (receivedSol != null) {
      finalPnlSol = realizedBefore + receivedSol - Number(position.size_sol);
      finalPnlPercent = Number(position.size_sol) > 0 ? (finalPnlSol / Number(position.size_sol)) * 100 : 0;
    }
    db.transaction(() => {
      db.prepare(`
        UPDATE dry_run_positions
        SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
            pnl_percent = ?, pnl_sol = ?, exit_signature = ?, realized_sol = COALESCE(realized_sol, 0) + ?
        WHERE id = ?
      `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, receivedSol || 0, position.id);
      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
      `).run(position.id, position.mint, now(), price, mcap, position.size_sol,
        position.token_amount_raw || position.token_amount_est, exitReason,
        json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell }));
    })();
    closed = true;
  } else if (exitReason && autoExit) {
    db.transaction(() => {
      db.prepare(`
        UPDATE dry_run_positions
        SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
        WHERE id = ?
      `).run(now(), price, mcap, exitReason, pnlPercent ?? 0, pnlSol, position.id);
      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
      `).run(position.id, position.mint, now(), price, mcap, position.size_sol,
        position.token_amount_est, exitReason, json({ pnlPercent: pnlPercent ?? 0, pnlSol, dataMissing }));
    })();
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    dataMissing,
    missingDataCycles: missingCycles,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
  };
}

export async function monitorPositions() {
  // One cycle at a time: a slow sell must not overlap the next 10s tick.
  if (monitorRunning) {
    console.log('[position] previous monitor cycle still running, tick skipped');
    return;
  }
  monitorRunning = true;
  try {
    const positions = openPositions();
    let walletPnlData = {};
    const pubkey = liveWalletPubkey();
    if (pubkey && positions.some(p => p.execution_mode === 'live')) {
      walletPnlData = await fetchJupiterWalletPnl(pubkey);
    }
    for (const position of positions) {
      const jupiterPnl = position.execution_mode === 'live'
        ? (walletPnlData[position.mint]?.pnl || null)
        : null;
      const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
        console.log(`[position] ${position.id} ${err.message}`);
        return null;
      });
      if (result?.exitReason) await sendPositionExit(result);
    }
  } finally {
    monitorRunning = false;
  }
}
