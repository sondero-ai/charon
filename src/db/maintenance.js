import { db } from './connection.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Keeps the SQLite file bounded on a small VPS. decision_logs stores a full
 * candidate JSON per event, so it grows fastest. Candidates still referenced by
 * a position are never deleted.
 */
export function pruneOldRows({ retentionDays = Number(process.env.DB_RETENTION_DAYS || 30), nowMs = Date.now() } = {}) {
  if (!(retentionDays > 0)) return {};
  const cutoff = nowMs - retentionDays * DAY_MS;
  const result = {};
  const run = (label, sql, params) => {
    try {
      result[label] = db.prepare(sql).run(...params).changes;
    } catch (err) {
      result[label] = `skipped: ${err.message}`;
    }
  };
  run('decision_logs', 'DELETE FROM decision_logs WHERE created_at_ms < ?', [cutoff]);
  run('signal_events', 'DELETE FROM signal_events WHERE at_ms < ?', [cutoff]);
  run('learning_runs', 'DELETE FROM learning_runs WHERE created_at_ms < ?', [cutoff]);
  run('candidates', `
    DELETE FROM candidates
    WHERE created_at_ms < ?
      AND id NOT IN (SELECT candidate_id FROM dry_run_positions WHERE candidate_id IS NOT NULL)
      AND id NOT IN (SELECT candidate_id FROM trade_intents WHERE candidate_id IS NOT NULL)
  `, [cutoff]);
  return result;
}
