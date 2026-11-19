import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'charon-exec-'));
process.env.DB_PATH = join(dir, 'test.sqlite');
process.env.TELEGRAM_POLLING = 'false';
process.env.TELEGRAM_CHAT_ID = '-100777';
process.env.TELEGRAM_BOT_TOKEN = '123456:AAtestTokenForSuite000000000000000';
process.env.TRADING_MODE = 'dry_run';

const { initDb, db, closeDb } = await import('../src/db/connection.js');
const {
  reserveLivePosition, finalizeLivePosition, failLivePosition, openPositionForMint, DuplicatePositionError,
} = await import('../src/db/positions.js');
const { createTradeIntent, claimIntent, settleIntent, intentById } = await import('../src/db/intents.js');
const { evaluateExitReason } = await import('../src/execution/positions.js');

initDb();
after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const decision = { id: 1, confidence: 82, reason: 'suite', suggested_tp_percent: 60, suggested_sl_percent: -30 };

function candidate(mint) {
  return {
    token: { mint, symbol: 'TST', name: 'Test' },
    metrics: { priceUsd: 0.0001, marketCapUsd: 50_000 },
    holders: { top20Percent: 20, maxHolderPercent: 5 },
    savedWalletExposure: { holderCount: 0, checked: 3 },
    signals: { route: 'fee_claim' },
    filters: { passed: true, failures: [] },
  };
}

test('a live entry reserves the row before any swap', () => {
  const id = reserveLivePosition(1, candidate('MintReserve111'), decision, 'suite');
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  assert.equal(row.status, 'pending_open');
  assert.equal(row.entry_signature, null);
  assert.equal(row.execution_mode, 'live');
  assert.equal(openPositionForMint('MintReserve111').id, id);
});

test('a second entry for the same mint is refused without spending', () => {
  assert.throws(
    () => reserveLivePosition(1, candidate('MintReserve111'), decision, 'suite'),
    (err) => err instanceof DuplicatePositionError && err.code === 'DUPLICATE_POSITION',
  );
  const open = db.prepare("SELECT COUNT(*) c FROM dry_run_positions WHERE mint = 'MintReserve111' AND status IN ('open','pending_open')").get();
  assert.equal(open.c, 1);
});

test('the SQL index refuses a duplicate even without the application guard', () => {
  assert.throws(() => {
    db.prepare(`
      INSERT INTO dry_run_positions (mint, symbol, status, opened_at_ms, size_sol)
      VALUES ('MintReserve111', 'TST', 'open', ?, 0.1)
    `).run(Date.now());
  }, /UNIQUE|constraint/i);
});

test('finalize records the landed fill, not the intent', () => {
  const id = openPositionForMint('MintReserve111').id;
  finalizeLivePosition(id, { signature: 'SigFill111', tokenAmountRaw: '999000000', actualSizeSol: 0.0987, feeLamports: 5000 });
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  assert.equal(row.status, 'open');
  assert.equal(row.entry_signature, 'SigFill111');
  assert.equal(row.token_amount_raw, '999000000');
  assert.equal(row.size_sol, 0.0987);
  assert.equal(row.entry_fee_lamports, 5000);
  const trades = db.prepare("SELECT COUNT(*) c FROM dry_run_trades WHERE position_id = ? AND reason = 'live_buy_filled'").get(id);
  assert.equal(trades.c, 1);
});

test('a failed entry frees the mint instead of leaving it locked', () => {
  const id = reserveLivePosition(2, candidate('MintFail222'), decision, 'suite');
  failLivePosition(id, 'jupiter order rejected');
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  assert.equal(row.status, 'entry_failed');
  assert.match(row.exit_reason, /^ENTRY_FAILED/);
  assert.equal(openPositionForMint('MintFail222'), null);
});

test('a confirmed intent can only be claimed once', () => {
  const id = createTradeIntent(3, candidate('MintIntent333'), decision, 'live', 'pending_confirmation');
  assert.equal(claimIntent(id), true);
  assert.equal(claimIntent(id), false);
  settleIntent(id, 'executed_live', { signature: 'SigIntent333' });
  assert.equal(intentById(id).signature, 'SigIntent333');
  assert.equal(intentById(id).status, 'executed_live');
});

test('a claimed intent cannot be rejected afterwards', () => {
  const id = createTradeIntent(4, candidate('MintIntent444'), decision, 'live', 'pending_confirmation');
  claimIntent(id);
  const result = db.prepare("UPDATE trade_intents SET status='rejected' WHERE id=? AND status='pending_confirmation'").run(id);
  assert.equal(result.changes, 0);
});

const basePosition = { opened_at_ms: 0, tp_percent: 50, sl_percent: -25, trailing_enabled: 0, trailing_percent: 20 };
const loose = { max_hold_ms: 0 };

test('missing market data arms the exit after the grace cycles, never before', () => {
  const args = { position: basePosition, pnlPercent: null, dataMissing: true, strat: loose, highWaterMcap: 100, mcap: 100 };
  assert.equal(evaluateExitReason({ ...args, missingCycles: 1 }), null);
  assert.equal(evaluateExitReason({ ...args, missingCycles: 2 }), null);
  assert.equal(evaluateExitReason({ ...args, missingCycles: 3 }), 'NO_MARKET_DATA');
});

test('stop loss fires on live data', () => {
  assert.equal(evaluateExitReason({
    position: basePosition, pnlPercent: -30, dataMissing: false, missingCycles: 0,
    strat: loose, highWaterMcap: 100, mcap: 70,
  }), 'SL');
});

test('take profit fires unless trailing is enabled', () => {
  const args = { pnlPercent: 60, dataMissing: false, missingCycles: 0, strat: loose, highWaterMcap: 160, mcap: 160 };
  assert.equal(evaluateExitReason({ ...args, position: basePosition }), 'TP');
  assert.equal(evaluateExitReason({ ...args, position: { ...basePosition, trailing_enabled: 1, trailing_armed: 1 } }), null);
});

test('trailing stops out after the high-water mark drops', () => {
  const position = { ...basePosition, trailing_enabled: 1, trailing_armed: 1, trailing_percent: 20 };
  assert.equal(evaluateExitReason({
    position, pnlPercent: 50, dataMissing: false, missingCycles: 0,
    strat: loose, highWaterMcap: 200, mcap: 150,
  }), 'TRAILING_TP');
});

test('max hold wins even when market data is gone', () => {
  assert.equal(evaluateExitReason({
    position: basePosition, pnlPercent: null, dataMissing: true, missingCycles: 0,
    strat: { max_hold_ms: 1000 }, highWaterMcap: 100, mcap: 100, nowMs: 5000,
  }), 'MAX_HOLD');
});
