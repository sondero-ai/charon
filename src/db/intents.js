import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';
import { currentPositionSizeSol } from './positions.js';

export function createTradeIntent(candidateId, candidate, decision, mode, status, side = 'buy') {
  const sizeSol = currentPositionSizeSol();
  const result = db.prepare(`
    INSERT INTO trade_intents (
      candidate_id, mint, mode, status, created_at_ms, updated_at_ms, side,
      size_sol, confidence, reason, llm_decision_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    candidate.token.mint,
    mode,
    status,
    now(),
    now(),
    side,
    sizeSol,
    decision.confidence,
    decision.reason,
    decision.id || null,
    json({ candidate, decision, mode, status, sizeSol }),
  );
  return Number(result.lastInsertRowid);
}

/**
 * Atomically takes ownership of a pending intent. Returns false when another tap
 * already claimed it — the only reliable way to stop a double swap.
 */
export function claimIntent(intentId) {
  const result = db.prepare(`
    UPDATE trade_intents
    SET status = 'executing', claimed_at_ms = ?, updated_at_ms = ?
    WHERE id = ? AND status = 'pending_confirmation'
  `).run(now(), now(), intentId);
  return result.changes === 1;
}

export function settleIntent(intentId, status, { signature = null, error = null } = {}) {
  db.prepare(`
    UPDATE trade_intents
    SET status = ?, updated_at_ms = ?, signature = COALESCE(?, signature), error = ?
    WHERE id = ?
  `).run(status, now(), signature, error == null ? null : String(error).slice(0, 500), intentId);
}

export function intentById(id) {
  const row = db.prepare('SELECT * FROM trade_intents WHERE id = ?').get(id);
  return row ? { ...row, payload: safeJson(row.payload_json, {}) } : null;
}
