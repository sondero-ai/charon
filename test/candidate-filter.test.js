import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'charon-filter-'));
process.env.DB_PATH = join(dir, 'filter.sqlite');
process.env.TELEGRAM_POLLING = 'false';
process.env.TELEGRAM_CHAT_ID = '-100777';
process.env.TELEGRAM_BOT_TOKEN = '123456:AAtestTokenForSuite000000000000000';
process.env.TRADING_MODE = 'dry_run';
process.env.GMGN_ENABLED = 'false';

const { initDb, db, closeDb } = await import('../src/db/connection.js');
const { filterCandidate } = await import('../src/pipeline/candidateBuilder.js');

initDb();

const strategy = {
  id: 'test', entry_mode: 'immediate', min_source_count: 1, require_fee_claim: false,
  token_age_max_ms: 0, min_mcap_usd: 50000, max_mcap_usd: 300000, min_fee_claim_sol: 0,
  min_gmgn_total_fee_sol: 0, min_holders: 50, max_top20_holder_percent: 100,
  min_saved_wallet_holders: 0, max_ath_distance_pct: 0, min_graduated_volume_usd: 0,
  trending_min_volume_usd: 0, trending_min_swaps: 0, trending_max_rug_ratio: 0,
  trending_max_bundler_rate: 0, max_rugcheck_score: 0, rugcheck_max_dangers: 0,
  min_lp_locked_pct: 0, rugcheck_reject_rugged: 0, max_trades_per_trader_5m: 5,
  min_avg_trade_usd_5m: 5, max_sell_buy_ratio_5m: 3, max_price_drop_5m_pct: -40,
};
db.prepare("update strategies set config_json = ? where id = 'sniper'").run(JSON.stringify(strategy));

function candidate(overrides = {}) {
  return {
    token: { mint: 'So11111111111111111111111111111111111111112' },
    metrics: { marketCapUsd: 120000, gmgnTotalFeesSol: 0, graduatedVolumeUsd: 0, holderCount: 0, ...overrides.metrics },
    holders: { maxHolderPercent: 0 },
    savedWalletExposure: { holderCount: 0 },
    chart: null,
    trending: null,
    feeClaim: null,
    graduation: null,
    rugcheck: overrides.rugcheck ?? null,
    activity: overrides.activity ?? null,
  };
}

test('a fresh migration with no holder data is not vetoed on holders', () => {
  const result = filterCandidate(candidate());
  assert.equal(result.passed, true, result.failures.join('; '));
});

test('a token with real but thin holders is rejected', () => {
  const result = filterCandidate(candidate({ metrics: { holderCount: 8 } }));
  assert.equal(result.passed, false);
  assert.match(result.failures.join('; '), /holders: 8 < 50/);
});

test('market cap outside the 50k to 300k band is rejected', () => {
  assert.match(filterCandidate(candidate({ metrics: { marketCapUsd: 20000 } })).failures.join('; '), /market cap min/);
  assert.match(filterCandidate(candidate({ metrics: { marketCapUsd: 396000 } })).failures.join('; '), /market cap max/);
});

test('a bot loop is rejected by the activity gate', () => {
  const activity = {
    hasStats: true, holders: 2670, top10Pct: 25,
    m5: { buys: 945, sells: 952, traders: 131, buyVolume: 1201, sellVolume: 1563, priceChangePct: 15.8, tradesPerTrader: 14.5, avgTradeUsd: 1.46, sellBuyVolumeRatio: 1.3 },
    h1: { buys: 0, sells: 0, traders: 0, buyVolume: 0, sellVolume: 0, priceChangePct: null, tradesPerTrader: null, avgTradeUsd: null, sellBuyVolumeRatio: null },
  };
  const result = filterCandidate(candidate({ metrics: { holderCount: 2670 }, activity }));
  assert.equal(result.passed, false);
  assert.match(result.failures.join('; '), /bot churn/);
});

test('missing activity data skips the gate instead of auto-passing everything', () => {
  const result = filterCandidate(candidate({ metrics: { holderCount: 200 }, activity: null }));
  assert.equal(result.passed, true, result.failures.join('; '));
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
