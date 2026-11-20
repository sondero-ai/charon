import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'charon-cap-'));
process.env.DB_PATH = join(dir, 'cap.sqlite');
process.env.TELEGRAM_POLLING = 'false';
process.env.TELEGRAM_CHAT_ID = '-100777';
process.env.TELEGRAM_BOT_TOKEN = '123456:AAtestTokenForSuite000000000000000';
process.env.TRADING_MODE = 'dry_run';
process.env.GMGN_ENABLED = 'false';

const { initDb, db, closeDb } = await import('../src/db/connection.js');
const { createDryRunPosition, openPositionCount } = await import('../src/db/positions.js');

initDb();

// The seeded sniper strategy is the active one; cap it at two for this test.
const row = db.prepare("select config_json from strategies where id = 'sniper'").get();
const config = { ...JSON.parse(row.config_json), max_open_positions: 2, position_size_sol: 0.05 };
db.prepare("update strategies set config_json = ? where id = 'sniper'").run(JSON.stringify(config));

function candidate(index) {
  return {
    token: { mint: `Mint${index}1111111111111111111111111111111111111`, symbol: `T${index}` },
    metrics: { priceUsd: 0.00001 * (index + 1), marketCapUsd: 50000 + index * 1000 },
    filters: { passed: true, failures: [] },
  };
}

const decision = { suggested_tp_percent: 30, suggested_sl_percent: -15 };

test('the cap is enforced inside the write transaction', () => {
  const outcomes = [];
  for (let i = 0; i < 5; i++) {
    outcomes.push(createDryRunPosition(i + 1, candidate(i), decision, 'test'));
  }
  const opened = outcomes.filter(id => id !== null && id !== undefined);
  assert.equal(opened.length, 2, `expected 2 inserts, got ${opened.length}`);
  assert.equal(outcomes.slice(2).every(id => id === null), true, 'extra inserts must return null');
  assert.equal(openPositionCount(), 2);
});

test('a closed position frees a slot', () => {
  const open = db.prepare("select id from dry_run_positions where status = 'open' order by id limit 1").get();
  db.prepare("update dry_run_positions set status = 'closed', closed_at_ms = ? where id = ?").run(Date.now(), open.id);
  const id = createDryRunPosition(99, candidate(9), decision, 'test');
  assert.notEqual(id, null);
  assert.equal(openPositionCount(), 2);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
