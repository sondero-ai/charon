import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeReport, rugcheckFailures, rugcheckSummary } = await import('../src/enrichment/rugcheck.js');

const sampleReport = {
  mint: 'AeCDew1bqgUyHYfKH5crHKvB3PEKwazfUgRwnbtupump',
  score: 77398,
  score_normalised: 76,
  rugged: false,
  totalHolders: 29,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token: { mintAuthority: null, freezeAuthority: null },
  risks: [
    { name: 'Creator history of rugged tokens', level: 'danger', score: 74400 },
    { name: 'Low Liquidity', level: 'danger', score: 2997 },
  ],
  markets: [
    { lp: { lpLockedPct: 100 } },
    { lp: { lpLockedPct: 40 } },
  ],
};

test('normalizeReport keeps the fields the gate needs', () => {
  const normalized = normalizeReport(sampleReport);
  assert.equal(normalized.score, 76);
  assert.equal(normalized.scoreRaw, 77398);
  assert.equal(normalized.dangerCount, 2);
  assert.equal(normalized.riskCount, 2);
  assert.equal(normalized.creatorRugged, true);
  assert.equal(normalized.lpLockedPct, 100);
  assert.equal(normalized.totalHolders, 29);
  assert.equal(normalized.mintAuthority, null);
});

test('normalizeReport tolerates a partial payload without inventing safety', () => {
  const normalized = normalizeReport({ mint: 'x' });
  assert.equal(normalized.score, null);
  assert.equal(normalized.lpLockedPct, null);
  assert.equal(normalized.dangerCount, 0);
  assert.equal(normalizeReport(null), null);
});

test('a missing rugcheck report never blocks a trade on its own', () => {
  assert.deepEqual(rugcheckFailures({ max_rugcheck_score: 50 }, null), []);
});

test('every rugcheck knob defaults to off', () => {
  const risky = normalizeReport(sampleReport);
  assert.deepEqual(rugcheckFailures({}, risky), []);
  assert.deepEqual(rugcheckFailures({ max_rugcheck_score: 0, rugcheck_max_dangers: 0, min_lp_locked_pct: 0, rugcheck_reject_rugged: 0 }, risky), []);
});

test('score, danger count and LP lock are enforced once enabled', () => {
  const risky = normalizeReport({ ...sampleReport, markets: [{ lp: { lpLockedPct: 40 } }] });
  const failures = rugcheckFailures({ max_rugcheck_score: 50, rugcheck_max_dangers: 1, min_lp_locked_pct: 90 }, risky);
  assert.equal(failures.length, 3);
  assert.match(failures.join(' | '), /rugcheck score: 76 > 50/);
  assert.match(failures.join(' | '), /danger flags: 2 > 1/);
  assert.match(failures.join(' | '), /LP locked: 40% < 90%/);
});

test('LP lock uses the best market, not the worst', () => {
  const risky = normalizeReport(sampleReport);
  assert.deepEqual(rugcheckFailures({ min_lp_locked_pct: 90 }, risky), []);
});

test('rugged flag is only fatal when the operator opts in', () => {
  const rugged = normalizeReport({ ...sampleReport, rugged: true });
  assert.equal(rugcheckFailures({}, rugged).length, 0);
  assert.match(rugcheckFailures({ rugcheck_reject_rugged: 1 }, rugged)[0], /flagged as rugged/);
});

test('summary is a single readable line', () => {
  const line = rugcheckSummary(normalizeReport(sampleReport));
  assert.match(line, /score 76/);
  assert.match(line, /2 danger/);
  assert.match(line, /LP locked 100%/);
  assert.equal(rugcheckSummary(null), 'rugcheck: unavailable');
});
