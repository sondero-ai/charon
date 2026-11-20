import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeActivity, activityFailures, activitySummary } = await import('../src/enrichment/activity.js');

// Trimmed from the real Jupiter v2 payload: LOOSY, the token the operator
// called good because real people were buying it.
const loosy = {
  id: 'GUyj5yDeaKwCnLvMSxZKVVGLLLJ5nn5fxXXewkfnpump',
  symbol: 'LOOSY',
  holderCount: 199,
  organicScore: 0,
  audit: { topHoldersPercentage: 15, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
  stats5m: { numBuys: 171, numSells: 144, numTraders: 180, buyVolume: 5899, sellVolume: 6804, priceChange: -6.7 },
};

// DCI: 2,000 trades from 130 wallets at about one dollar each, a bot loop.
const dci = {
  id: 'Hej9C9CWjzdq5iCsuaY49eqTMR7pdgkV3uqvWmHMpump',
  symbol: 'DCI',
  holderCount: 2670,
  audit: { topHoldersPercentage: 25 },
  stats5m: { numBuys: 945, numSells: 952, numTraders: 131, buyVolume: 1201, sellVolume: 1563, priceChange: 15.8 },
};

const strat = { max_trades_per_trader_5m: 5, min_avg_trade_usd_5m: 5, max_sell_buy_ratio_5m: 3, max_price_drop_5m_pct: -40 };

test('window stats are derived, not guessed', () => {
  const a = normalizeActivity(loosy);
  assert.equal(a.holders, 199);
  assert.equal(a.m5.tradesPerTrader, 315 / 180);
  assert.equal(a.m5.avgTradeUsd, (5899 + 6804) / 315);
  assert.equal(a.m5.sellBuyVolumeRatio, 6804 / 5899);
  assert.equal(a.hasStats, true);
});

test('a token bought by real people passes the bot gate', () => {
  assert.deepEqual(activityFailures(strat, normalizeActivity(loosy)), []);
});

test('a bot loop is rejected on churn and dust trade size', () => {
  const failures = activityFailures(strat, normalizeActivity(dci));
  assert.equal(failures.length, 2);
  assert.match(failures.join(' | '), /bot churn: 14\.5 trades\/trader/);
  assert.match(failures.join(' | '), /dust trades/);
});

test('a token already dumping is rejected even when trade size looks normal', () => {
  const dumping = {
    ...loosy,
    stats5m: { numBuys: 4, numSells: 60, numTraders: 64, buyVolume: 500, sellVolume: 5000, priceChange: -88 },
  };
  const failures = activityFailures(strat, normalizeActivity(dumping));
  assert.match(failures.join(' | '), /dump pressure/);
  assert.match(failures.join(' | '), /already dumping: -88%/);
});

test('missing stats never block a trade and never look clean', () => {
  const empty = normalizeActivity({ id: 'x', holderCount: 40 });
  assert.equal(empty.hasStats, false);
  assert.deepEqual(activityFailures(strat, empty), []);
  assert.equal(activityFailures(strat, null).length, 0);
  assert.match(activitySummary(empty), /no stats/);
});

test('every knob defaults to off', () => {
  assert.deepEqual(activityFailures({}, normalizeActivity(dci)), []);
});

test('zero buy volume with sells still counts as dump pressure', () => {
  const a = normalizeActivity({ ...loosy, stats5m: { numBuys: 0, numSells: 10, numTraders: 10, buyVolume: 0, sellVolume: 900, priceChange: -10 } });
  assert.equal(a.m5.sellBuyVolumeRatio, Infinity);
  assert.match(activityFailures(strat, a).join(' | '), /dump pressure/);
});
