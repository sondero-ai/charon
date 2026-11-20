import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from './settings.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizeSol = currentPositionSizeSol();
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    // Re-check the cap inside the write transaction. Two signal handlers can
    // pass canOpenMorePositions() at the same time (trending, migration, fee
    // claim run concurrently) and each would insert, overshooting the limit the
    // operator set. The count and the insert must happen in one atomic step.
    const maxPositions = Number(strat.max_open_positions ?? numSetting('max_open_positions', 3));
    if (maxPositions > 0 && openPositionCount() >= maxPositions) return null;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

export class DuplicatePositionError extends Error {
  constructor(mint) {
    super(`An open position already exists for ${mint}; entry refused before signing.`);
    this.name = 'DuplicatePositionError';
    this.code = 'DUPLICATE_POSITION';
    this.mint = mint;
  }
}

/** Single source of truth for position size, shared by intents and execution. */
export function currentPositionSizeSol() {
  const strat = activeStrategy();
  const size = Number(strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1));
  return Number.isFinite(size) && size > 0 ? size : 0.1;
}

export function openPositionForMint(mint) {
  return db.prepare(`
    SELECT id FROM dry_run_positions
    WHERE mint = ? AND status IN ('open', 'pending_open')
    LIMIT 1
  `).get(mint) || null;
}

function pickTpPercent(decision, strat) {
  for (const value of [decision?.suggested_tp_percent, strat.tp_percent, numSetting('default_tp_percent', 50)]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 50;
}

function pickSlPercent(decision, strat) {
  for (const value of [decision?.suggested_sl_percent, strat.sl_percent, numSetting('default_sl_percent', -25)]) {
    const number = Number(value);
    if (Number.isFinite(number) && number < 0) return number;
  }
  return -25;
}

/**
 * Writes the position row *before* any swap is signed. The unique partial index
 * on (mint) WHERE status IN ('open','pending_open') makes the duplicate guard
 * atomic, so a second entry cannot spend SOL and then drop the tokens.
 */
export function reserveLivePosition(candidateId, candidate, decision, reason = 'live_buy') {
  const strat = activeStrategy();
  const mint = candidate.token.mint;
  if (openPositionForMint(mint)) throw new DuplicatePositionError(mint);
  const sizeSol = currentPositionSizeSol();
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = pickTpPercent(decision, strat);
  const sl = pickSlPercent(decision, strat);
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    // Same reason as the dry-run path: the cap check outside this transaction
    // can race with a concurrent handler and open an extra live position.
    const maxPositions = Number(strat.max_open_positions ?? numSetting('max_open_positions', 3));
    if (maxPositions > 0 && openPositionCount() >= maxPositions) {
      throw new Error('position cap reached');
    }
    let result;
    try {
      result = db.prepare(`
        INSERT INTO dry_run_positions (
          candidate_id, mint, symbol, status, opened_at_ms, pending_at_ms, size_sol, entry_price, entry_mcap,
          token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
          trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
          execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json
        ) VALUES (?, ?, ?, 'pending_open', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, 'live', NULL, NULL, ?, ?)
      `).run(
        candidateId,
        mint,
        candidate.token.symbol,
        now(),
        now(),
        sizeSol,
        entryPrice,
        entryMcap,
        entryPrice,
        entryMcap,
        tp,
        sl,
        trailingEnabled,
        trailingPercent,
        decision?.id || null,
        strat.id,
        json({ candidate, decision, reason, strategy: strat.id, reserved: true }),
      );
    } catch (err) {
      if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) throw new DuplicatePositionError(mint);
      throw err;
    }
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

export function finalizeLivePosition(positionId, { signature = null, tokenAmountRaw = null, actualSizeSol = null, feeLamports = null } = {}) {
  return db.transaction(() => {
    const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
    if (!position) throw new Error(`position #${positionId} vanished before finalize`);
    const sizeSol = Number(actualSizeSol) > 0 ? Number(actualSizeSol) : position.size_sol;
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'open', entry_signature = ?, token_amount_raw = ?, size_sol = ?,
          entry_fee_lamports = ?, pending_at_ms = NULL, last_checked_at_ms = ?, snapshot_json = ?
      WHERE id = ?
    `).run(
      signature,
      tokenAmountRaw == null ? null : String(tokenAmountRaw),
      sizeSol,
      feeLamports == null ? null : Number(feeLamports),
      now(),
      spreadSnapshot(position.snapshot_json, { signature, tokenAmountRaw, sizeSol, feeLamports, filled: true }),
      positionId,
    );
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, 'live_buy_filled', ?)
    `).run(
      positionId, position.mint, now(), position.entry_price, position.entry_mcap,
      sizeSol, Number(tokenAmountRaw) || null,
      json({ signature, tokenAmountRaw, sizeSol, feeLamports }),
    );
    return positionId;
  })();
}

export function failLivePosition(positionId, errorMessage = '') {
  return db.transaction(() => {
    const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
    if (!position) return null;
    const reason = `ENTRY_FAILED: ${String(errorMessage || 'unknown error').slice(0, 200)}`;
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'entry_failed', closed_at_ms = ?, exit_reason = ?, pending_at_ms = NULL
      WHERE id = ? AND status = 'pending_open'
    `).run(now(), reason, positionId);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, NULL, NULL, 0, NULL, 'ENTRY_FAILED', ?)
    `).run(positionId, position.mint, now(), json({ error: String(errorMessage || '').slice(0, 500) }));
    return positionId;
  })();
}

function spreadSnapshot(snapshotJson, extra) {
  try {
    const parsed = JSON.parse(snapshotJson || '{}');
    return json({ ...parsed, ...extra });
  } catch {
    return json({ ...extra });
  }
}
