import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_POLLING = 'false';
process.env.TELEGRAM_CHAT_ID = '-100777';
process.env.TELEGRAM_BOT_TOKEN = '123456:AAtestTokenForSuite000000000000000';
process.env.GMGN_ENABLED = 'false';

const { trendingMintAllowed } = await import('../src/signals/trending.js');

test('an empty suffix accepts every launchpad', () => {
  assert.equal(trendingMintAllowed('9MZiGiBiFA6vLkqJ8kk7MsniLgrU6VrtiWripZFMmain', ''), true);
  assert.equal(trendingMintAllowed('J7bLsZcpkfky92ir8k36Munz91nHKtcDNhDy8d3Qpump', ''), true);
});

test('a suffix filters the list, so pump-only behaviour is still available', () => {
  assert.equal(trendingMintAllowed('J7bLsZcpkfky92ir8k36Munz91nHKtcDNhDy8d3Qpump', 'pump'), true);
  assert.equal(trendingMintAllowed('9MZiGiBiFA6vLkqJ8kk7MsniLgrU6VrtiWripZFMmain', 'pump'), false);
});

test('a missing mint is never allowed', () => {
  assert.equal(trendingMintAllowed(null, ''), false);
  assert.equal(trendingMintAllowed(undefined, 'pump'), false);
});
