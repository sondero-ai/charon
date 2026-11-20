/**
 * Every number the operator can change from Telegram is bounded here. This is a
 * money control surface: an unvalidated typo can disable a risk filter or size a
 * position with the whole wallet, and JSON.stringify turns NaN into null, which
 * silently flips comparisons the wrong way.
 */
const MAX_POSITION_SOL = Number(process.env.LIVE_MAX_POSITION_SOL || 5);

const RULES = {
  // strategy sizing and exits
  position_size_sol: { min: 0.001, max: MAX_POSITION_SOL },
  max_open_positions: { min: 1, max: 20, integer: true },
  tp_percent: { min: 1, max: 10_000 },
  sl_percent: { min: -99, max: -1 },
  trailing_percent: { min: 1, max: 99 },
  partial_tp_at_percent: { min: 0, max: 10_000 },
  partial_tp_sell_percent: { min: 0, max: 99 },
  max_hold_ms: { min: 0, max: 7 * 24 * 60 * 60 * 1000, integer: true },
  llm_min_confidence: { min: 0, max: 100, integer: true },

  // strategy filters
  min_source_count: { min: 1, max: 3, integer: true },
  min_fee_claim_sol: { min: 0, max: 10_000 },
  min_mcap_usd: { min: 0, max: 1_000_000_000 },
  max_mcap_usd: { min: 0, max: 1_000_000_000 },
  min_holders: { min: 0, max: 1_000_000, integer: true },
  max_top20_holder_percent: { min: 1, max: 100, off: 100 },
  min_saved_wallet_holders: { min: 0, max: 1_000, integer: true },
  max_ath_distance_pct: { min: -100, max: 0, off: 0 },
  token_age_max_ms: { min: 0, max: 30 * 24 * 60 * 60 * 1000, integer: true },
  min_gmgn_total_fee_sol: { min: 0, max: 1_000_000 },
  min_graduated_volume_usd: { min: 0, max: 1_000_000_000 },
  trending_min_volume_usd: { min: 0, max: 1_000_000_000 },
  trending_min_swaps: { min: 0, max: 10_000_000, integer: true },
  trending_max_rug_ratio: { min: 0, max: 1 },
  trending_max_bundler_rate: { min: 0, max: 1 },
  max_rugcheck_score: { min: 0, max: 100, off: 0 },
  rugcheck_max_dangers: { min: 0, max: 50, integer: true, off: 0 },
  min_lp_locked_pct: { min: 0, max: 100, off: 0 },
  rugcheck_reject_rugged: { min: 0, max: 1, integer: true, off: 0 },
  max_trades_per_trader_5m: { min: 0, max: 500, off: 0 },
  min_avg_trade_usd_5m: { min: 0, max: 1_000_000, off: 0 },
  max_sell_buy_ratio_5m: { min: 0, max: 1000, off: 0 },
  max_price_drop_5m_pct: { min: -100, max: 0, off: 0 },

  // global settings reachable from /setfilter and the numeric input flow
  dry_run_buy_sol: { min: 0.001, max: MAX_POSITION_SOL },
  default_tp_percent: { min: 1, max: 10_000 },
  default_sl_percent: { min: -99, max: -1 },
  default_trailing_percent: { min: 1, max: 99 },
  llm_candidate_pick_count: { min: 1, max: 50, integer: true },
  llm_candidate_max_age_ms: { min: 60_000, max: 24 * 60 * 60 * 1000, integer: true },
  trending_limit: { min: 1, max: 200, integer: true },
  gmgn_request_delay_ms: { min: 0, max: 60_000, integer: true },
  gmgn_max_retries: { min: 0, max: 10, integer: true },
};

const GLOBAL_ONLY = new Set([
  'dry_run_buy_sol',
  'default_tp_percent',
  'default_sl_percent',
  'default_trailing_percent',
  'llm_candidate_pick_count',
  'llm_candidate_max_age_ms',
  'trending_limit',
  'gmgn_request_delay_ms',
  'gmgn_max_retries',
]);

export const STRATEGY_BOOLEAN_KEYS = new Set([
  'trailing_enabled',
  'partial_tp',
  'use_llm',
  'require_fee_claim',
]);

export const STRATEGY_ENUM_KEYS = {
  entry_mode: ['immediate', 'wait_for_dip'],
};

export const STRATEGY_NUMERIC_KEYS = new Set(
  Object.keys(RULES).filter(key => !GLOBAL_ONLY.has(key)),
);

export function numericRule(key) {
  return RULES[key] || null;
}

export function explainNumericRule(key) {
  const rule = RULES[key];
  if (!rule) return null;
  const kind = rule.integer ? 'whole number' : 'number';
  return `${key}: ${kind} between ${rule.min} and ${rule.max}${rule.off == null ? '' : ` (or "off" = ${rule.off})`}`;
}

/** Validates and normalizes one operator-supplied number. */
export function normalizeNumericSetting(key, raw) {
  const rule = RULES[key];
  if (!rule) return { ok: false, error: `"${key}" is not a tunable number.` };
  const text = String(raw ?? '').trim().toLowerCase();
  let value;
  if (['off', 'none', 'disable', ''].includes(text)) {
    value = rule.off ?? rule.min;
  } else {
    value = Number(text.replace(/[$,%_\s]/g, '').replace(/,/g, ''));
    if (!Number.isFinite(value)) {
      return { ok: false, error: `${key} must be a number${rule.off == null ? '' : ' or "off"'}.` };
    }
  }
  if (rule.integer && !Number.isInteger(value)) {
    return { ok: false, error: `${key} must be a whole number.` };
  }
  if (value < rule.min || value > rule.max) {
    return { ok: false, error: `${key} must be between ${rule.min} and ${rule.max}${rule.off == null ? '' : `, or "off"`}.` };
  }
  return { ok: true, value };
}

export function parseBooleanSetting(raw) {
  return /^(true|1|yes|on)$/i.test(String(raw ?? '').trim());
}

export function validateStrategySetting(key, raw) {
  if (STRATEGY_NUMERIC_KEYS.has(key)) return normalizeNumericSetting(key, raw);
  if (STRATEGY_BOOLEAN_KEYS.has(key)) return { ok: true, value: parseBooleanSetting(raw) };
  if (STRATEGY_ENUM_KEYS[key]) {
    const value = String(raw ?? '').trim();
    if (!STRATEGY_ENUM_KEYS[key].includes(value)) {
      return { ok: false, error: `${key} must be one of: ${STRATEGY_ENUM_KEYS[key].join(', ')}.` };
    }
    return { ok: true, value };
  }
  return { ok: false, error: `"${key}" is not a configurable strategy key.` };
}
