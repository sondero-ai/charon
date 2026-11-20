import test from 'node:test';
import assert from 'node:assert/strict';

const { pickPair, normalizeDexScreener, dexscreenerMarketCap } = await import('../src/enrichment/dexscreener.js');

// Shape of the real payload for a token that had just graduated: a pumpfun
// pair with no liquidity and a pumpswap pair with the tradable market.
const payload = {
  pairs: [
    { dexId: 'pumpfun', priceUsd: '0.00006578', fdv: 65.78, marketCap: 65.78, liquidity: { usd: null }, pairCreatedAt: 1795131728000 },
    { dexId: 'pumpswap', priceUsd: '0.00006210', fdv: 62517, marketCap: 62517, liquidity: { usd: 16731.05 }, pairCreatedAt: 1795142396000, priceChange: { m5: -3.2 } },
  ],
};

test('the deepest pair wins, so dust pairs cannot set the market cap', () => {
  const info = normalizeDexScreener(payload);
  assert.equal(info.dexId, 'pumpswap');
  assert.equal(info.fdv, 62517);
  assert.equal(info.liquidityUsd, 16731.05);
  assert.equal(info.priceChange5m, -3.2);
});

test('pairs without a price or fdv are ignored', () => {
  assert.equal(pickPair([{ dexId: 'x', liquidity: { usd: 10 } }]), null);
  assert.equal(normalizeDexScreener({ pairs: null }), null);
  assert.equal(normalizeDexScreener(null), null);
});

test('market cap prefers fdv and falls back to marketCap', () => {
  assert.equal(dexscreenerMarketCap({ fdv: 1000, marketCap: 900 }), 1000);
  assert.equal(dexscreenerMarketCap({ marketCap: 900 }), 900);
  assert.equal(dexscreenerMarketCap(null), null);
});
