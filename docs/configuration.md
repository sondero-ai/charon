# Configuration

Two layers, and the order matters:

1. **Process env (`.env`)** — read once at startup by `src/config.js`.
2. **SQLite settings and strategies** — seeded from env on the *first* boot only,
   then owned by the database.

After the first run, changing `TRADING_MODE`, `MAX_OPEN_POSITIONS`,
`LLM_CANDIDATE_PICK_COUNT` or `MIN_FEE_CLAIM_SOL` in `.env` does nothing: those
rows already exist and `INSERT OR IGNORE` will not overwrite them. Change them in
Telegram (or with `sqlite3`), not in `.env`.

## Required

| Variable | Why |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot account. Separate from any personal assistant bot. |
| `TELEGRAM_CHAT_ID` | The only chat allowed to read alerts and send commands. |
| `HELIUS_API_KEY` | Or supply both `SOLANA_RPC_URL` and `SOLANA_WS_URL`. |
| `GMGN_API_KEY` | Unless `GMGN_ENABLED=false`. |
| `SIGNAL_SERVER_KEY` | From the maintainer. Without it server mode receives nothing. |

`validateConfig()` throws on any missing requirement. It runs inside
`startCharon()`, so the error goes through the fatal handler: log, Telegram
alert, exit code 1.

## Process env reference

### Telegram

| Variable | Default | Notes |
| --- | --- | --- |
| `TELEGRAM_TOPIC_ID` | unset | Forum topic id for alerts and replies. |
| `OPERATOR_USER_IDS` | empty | Comma-separated user ids allowed to command the bot *inside* `TELEGRAM_CHAT_ID`. Empty means any member of that chat. |
| `TELEGRAM_POLLING` | `true` | `false` constructs the client without `getUpdates`. Used by tests and smoke boots. |

### Signals

| Variable | Default | Notes |
| --- | --- | --- |
| `SIGNAL_SERVER_URL` | `http://localhost:3456` | Setting this enables **server mode**. Leave it empty for standalone pollers. |
| `SIGNAL_SERVER_KEY` | empty | Sent as `x-api-key`. |
| `SIGNAL_POLL_MS` | `30000` | Poll interval. |
| `GRADUATED_POLL_MS` | `30000` | Standalone only. |
| `GRADUATED_LOOKBACK_MS` | `7200000` | Standalone only. |
| `TRENDING_POLL_MS` | `60000` | Standalone only. |
| `TRENDING_LOOKBACK_MS` | `600000` | Standalone only. |
| `TRENDING_ENABLED`, `TRENDING_SOURCE`, `TRENDING_ALLOW_DEGEN`, `TRENDING_INTERVAL`, `TRENDING_LIMIT`, `TRENDING_ORDER_BY`, `TRENDING_MIN_VOLUME_USD`, `TRENDING_MIN_SWAPS`, `TRENDING_MAX_RUG_RATIO`, `TRENDING_MAX_BUNDLER_RATE` | see `.env.example` | Seed the `settings` table. |
| `PUMPPORTAL_WS_URL` | `wss://pumpportal.fun/api/data` | Standalone migration feed (no key required). |
| `MIGRATION_RECHECK_MS` | `90000` | Delayed re-check of a fresh migration, after Jupiter's index has priced it. |
| `GRADUATED_SOURCE` | `geckoterminal` | `pumpfun` only works from an IP that clears pump.fun's Cloudflare challenge. GeckoTerminal's new-pools feed filtered to PumpSwap is the working default. |
| `GRADUATED_GECKO_PAGES` | `2` | Pages of 20 new pools per poll; free tier allows 30 calls/min. |

### RPC and enrichment

| Variable | Default | Notes |
| --- | --- | --- |
| `SOLANA_RPC_URL` / `SOLANA_WS_URL` | Helius URL built from `HELIUS_API_KEY` | A key in the URL is scrubbed from logged errors. |
| `GMGN_ENABLED` | `true` | `false` skips GMGN entirely and falls back to Jupiter data. |
| `GMGN_REQUEST_DELAY_MS` | `2500` | Do not go below 2500; the GMGN key gets banned. |
| `GMGN_MAX_RETRIES` | `2` | Honours `Retry-After`. |
| `GMGN_CACHE_TTL_MS` | `300000` | Token-info cache. |
| `RUGCHECK_ENABLED` | `true` | Keyless risk data (rug history, LP lock, danger flags). A failed lookup means "unknown", never "safe". |
| `RUGCHECK_TIMEOUT_MS` | `8000` | Per-request timeout. |
| `RUGCHECK_CACHE_TTL_MS` | `300000` | Success cache. Failures are cached for `RUGCHECK_FAILURE_TTL_MS` (60 s). |
| `RUGCHECK_REQUEST_DELAY_MS` | `1200` | Pacing between requests. |

### Execution

| Variable | Default | Notes |
| --- | --- | --- |
| `TRADING_MODE` | `dry_run` | First boot only. Later changes go through Telegram with an armed confirmation. |
| `SOLANA_PRIVATE_KEY` | empty | Base58 or JSON array. Must decode to 64 bytes. |
| `JUPITER_API_KEY` | empty | Required for `confirm` and `live`. |
| `JUPITER_SWAP_BASE_URL` | `https://api.jup.ag/swap/v2` | Ultra order/execute. |
| `LIVE_MIN_SOL_RESERVE` | `0.02` | SOL that must remain after a buy so the sell is affordable. |
| `LIVE_MAX_POSITION_SOL` | `5` | Hard ceiling for `position_size_sol`, enforced by the schema. |
| `MISSING_DATA_EXIT_CYCLES` | `3` | Monitor cycles without market data before a forced exit. |
| `POSITION_CHECK_MS` | `10000` | Monitor interval. |

Entry budget, with defaults:

```
minimumEntryLamports(size) = size + 0.02 SOL reserve + 0.00203928 SOL ATA rent + 0.003 SOL fee buffer
size 0.1 SOL  ->  need 0.12503928 SOL
```

### LLM

| Variable | Default | Notes |
| --- | --- | --- |
| `ENABLE_LLM` | `true` | `false` uses rule-based decisions. |
| `LLM_BASE_URL` | `https://api.minimax.io/v1` | Any OpenAI-compatible endpoint. |
| `LLM_API_KEY` | empty | |
| `LLM_MODEL` | `MiniMax-M2.7` | |
| `LLM_TIMEOUT_MS` | `60000` | |
| `LLM_CANDIDATE_PICK_COUNT` | `10` | Seeded into `settings`; how many recent candidates are screened per batch. |
| `LLM_CANDIDATE_MAX_AGE_MS` | `600000` | Candidate freshness window. |

### Storage

| Variable | Default | Notes |
| --- | --- | --- |
| `DB_PATH` | `./charon.sqlite` | Relative paths resolve against the **repo root**, not the process cwd. `:memory:` is supported for tests. |
| `DB_RETENTION_DAYS` | `30` | Prune window for decision logs, signal events, unreferenced candidates. Positions are never pruned. |

## Global settings (SQLite `settings`)

| Key | Default | Bound |
| --- | --- | --- |
| `trading_mode` | `dry_run` | `dry_run` \| `confirm` \| `live` (arming required for the last two) |
| `agent_enabled` | `true` | boolean |
| `max_open_positions` | `3` | 1–20 |
| `dry_run_buy_sol` | `0.1` | 0.001–`LIVE_MAX_POSITION_SOL` |
| `llm_min_confidence` | `75` | 0–100, fallback only: the strategy value wins |
| `llm_candidate_pick_count` | `10` | 1–50 |
| `llm_candidate_max_age_ms` | `600000` | 60 s – 24 h |
| `default_tp_percent` | `50` | 1–10000 |
| `default_sl_percent` | `-25` | −99…−1 |
| `default_trailing_percent` | `20` | 1–99 |

All bounds live in `src/strategySchema.js`. A key without a rule cannot be set
from Telegram.

## Strategy keys

Four strategies ship seeded. Only `sniper` is enabled by default.

| Key | sniper | dip_buy | smart_money | degen | Bound |
| --- | --- | --- | --- | --- | --- |
| `entry_mode` | immediate | wait_for_dip | immediate | immediate | `immediate`/`wait_for_dip` |
| `min_source_count` | 2 | 1 | 2 | 1 | 1–3 |
| `require_fee_claim` | true | false | false | false | bool |
| `token_age_max_ms` | 3600000 | 86400000 | 86400000 | 3600000 | 0 – 30 d |
| `min_mcap_usd` | 7000 | 25000 | 10000 | 5000 | 0 – 1e9 |
| `max_mcap_usd` | 200000 | 500000 | 1000000 | 100000 | 0 – 1e9 (`0` = off) |
| `min_fee_claim_sol` | 0.5 | 0 | 0 | 0 | 0 – 10000 |
| `min_gmgn_total_fee_sol` | 10 | 0 | 0 | 0 | 0 – 1e6 |
| `min_holders` | 0 | 0 | 1000 | 0 | 0 – 1e6 |
| `max_top20_holder_percent` | 100 | 100 | 50 | 100 | 1–100 (`off` = 100) |
| `min_saved_wallet_holders` | 0 | 0 | 0 | 0 | 0 – 1000 |
| `max_ath_distance_pct` | 0 | −40 | 0 | 0 | −100 – 0 (`off` = 0) |
| `trending_min_volume_usd` | 0 | 0 | 5000 | 0 | 0 – 1e9 |
| `trending_min_swaps` | 0 | 0 | 100 | 0 | 0 – 1e7 |
| `trending_max_rug_ratio` | 0.3 | 0.3 | 0.2 | 0.5 | 0–1 |
| `trending_max_bundler_rate` | 0.5 | 0.5 | 0.3 | 0.7 | 0–1 |
| `max_rugcheck_score` | 0 | 0 | 0 | 0 | 0–100 (`0` = off) |
| `rugcheck_max_dangers` | 0 | 0 | 0 | 0 | 0–50 (`0` = off) |
| `min_lp_locked_pct` | 0 | 0 | 0 | 0 | 0–100 (`0` = off) |
| `rugcheck_reject_rugged` | 0 | 0 | 0 | 0 | 0/1 (`0` = off) |
| `position_size_sol` | 0.1 | 0.05 | 0.1 | 0.05 | 0.001 – `LIVE_MAX_POSITION_SOL` |
| `max_open_positions` | 3 | 3 | 3 | 5 | 1–20 |
| `tp_percent` | 50 | 30 | 100 | 30 | 1 – 10000 |
| `sl_percent` | −25 | −20 | −25 | −15 | −99 – −1 |
| `trailing_enabled` | true | true | false | true | bool |
| `trailing_percent` | 20 | 15 | 0 | 10 | 1–99 |
| `partial_tp` | false | false | true | false | bool |
| `partial_tp_at_percent` | 0 | 0 | 100 | 0 | 0 – 10000 |
| `partial_tp_sell_percent` | 0 | 0 | 50 | 0 | 0–99 |
| `max_hold_ms` | 0 | 0 | 0 | 0 | 0 – 7 d (`0` = off) |
| `use_llm` | true | true | true | false | bool |
| `llm_min_confidence` | 50 | 50 | 70 | 0 | 0–100 |

Set them with `/stratset <id> <key> <value>` or the Strategy menu. `off` is
accepted for percentage/cap keys and maps to the documented per-key value, never
to zero.

## Example `.env` (dry run)

```env
TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_TOPIC_ID=34162
OPERATOR_USER_IDS=1642988059

SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=...
SIGNAL_POLL_MS=30000

HELIUS_API_KEY=...
GMGN_ENABLED=false

DB_PATH=./charon.sqlite
DB_RETENTION_DAYS=30
TRADING_MODE=dry_run

ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1
LLM_API_KEY=...
LLM_MODEL=MiniMax-M2.7
```

Add `SOLANA_PRIVATE_KEY`, `JUPITER_API_KEY` and `LIVE_MIN_SOL_RESERVE` only when
you move to `confirm`/`live`, and keep the wallet minimal.
