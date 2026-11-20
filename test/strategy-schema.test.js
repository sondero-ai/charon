import test from 'node:test';
import assert from 'node:assert/strict';

const { validateStrategySetting, normalizeNumericSetting, STRATEGY_NUMERIC_KEYS } = await import('../src/strategySchema.js');

test('position size is capped so a typo cannot size the whole wallet', () => {
  assert.equal(validateStrategySetting('position_size_sol', '100').ok, false);
  assert.deepEqual(validateStrategySetting('position_size_sol', '0.25'), { ok: true, value: 0.25 });
});

test('stop loss must be negative and take profit positive', () => {
  assert.equal(validateStrategySetting('sl_percent', '50').ok, false);
  assert.deepEqual(validateStrategySetting('sl_percent', '-30'), { ok: true, value: -30 });
  assert.equal(validateStrategySetting('tp_percent', '-10').ok, false);
  assert.deepEqual(validateStrategySetting('tp_percent', '75'), { ok: true, value: 75 });
});

test('NaN input is rejected instead of being stored as null', () => {
  const result = validateStrategySetting('tp_percent', 'abc');
  assert.equal(result.ok, false);
  assert.match(result.error, /must be a number/);
});

test('"off" resolves to the documented per-key value, not 0', () => {
  assert.deepEqual(validateStrategySetting('max_top20_holder_percent', 'off'), { ok: true, value: 100 });
  assert.deepEqual(validateStrategySetting('max_ath_distance_pct', 'off'), { ok: true, value: 0 });
});

test('whole-number keys reject fractions', () => {
  assert.equal(validateStrategySetting('min_source_count', '2.5').ok, false);
  assert.deepEqual(validateStrategySetting('min_source_count', '2'), { ok: true, value: 2 });
});

test('entry_mode is an enum and unknown keys are refused', () => {
  assert.equal(validateStrategySetting('entry_mode', 'garbage').ok, false);
  assert.deepEqual(validateStrategySetting('entry_mode', 'wait_for_dip'), { ok: true, value: 'wait_for_dip' });
  assert.equal(validateStrategySetting('not_a_key', '1').ok, false);
});

test('booleans accept the documented spellings', () => {
  assert.deepEqual(validateStrategySetting('trailing_enabled', 'yes'), { ok: true, value: true });
  assert.deepEqual(validateStrategySetting('partial_tp', '0'), { ok: true, value: false });
});

test('global settings share the same bounds', () => {
  assert.equal(normalizeNumericSetting('llm_min_confidence', '101').ok, false);
  assert.equal(normalizeNumericSetting('dry_run_buy_sol', '0').ok, false);
  assert.equal(STRATEGY_NUMERIC_KEYS.has('dry_run_buy_sol'), false);
});

test('rugcheck knobs are bounded and default to observe mode', () => {
  assert.deepEqual(validateStrategySetting('max_rugcheck_score', 'off'), { ok: true, value: 0 });
  assert.equal(validateStrategySetting('max_rugcheck_score', '150').ok, false);
  assert.equal(validateStrategySetting('rugcheck_max_dangers', '2.5').ok, false);
  assert.deepEqual(validateStrategySetting('rugcheck_reject_rugged', '1'), { ok: true, value: 1 });
  assert.equal(validateStrategySetting('rugcheck_reject_rugged', '2').ok, false);
  assert.equal(validateStrategySetting('min_lp_locked_pct', '-1').ok, false);
});
