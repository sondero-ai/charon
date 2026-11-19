# Architecture

## Runtime shape

```
                       ┌──────────────────────────┐
   signal server  ───► │ src/signals/serverClient │──┐
   (server mode)       └──────────────────────────┘  │
                                                     │
   Pump.fun WS  ─────► ┌──────────────────────────┐  ├─► processCandidateFromSignals()
   graduated API ────► │ src/signals/{feeClaim,   │  │      (src/pipeline/orchestrator.js)
   trending API  ────► │ graduated,trending}      │──┘
   (standalone mode)   └──────────────────────────┘
                                                     │
                    ┌────────────────────────────────▼─────────────────┐
                    │ buildCandidate → filterCandidate (strategy gates)│
                    │ upsert into candidates                           │
                    └────────────────────────────────┬─────────────────┘
                                                     │
                                    ┌────────────────▼────────────────┐
                                    │ src/pipeline/llm.js             │
                                    │ decideCandidateBatch (LLM)      │
                                    └────────────────┬────────────────┘
                                                     │  verdict BUY + confidence >= strategy threshold
                                    ┌────────────────▼────────────────┐
                                    │ src/execution/router.js         │
                                    │ dry_run | confirm | live        │
                                    └────────────────┬────────────────┘
                                                     │
                     ┌───────────────────────────────▼──────────────────────┐
                     │ src/execution/positions.js  monitorPositions()       │
                     │ every POSITION_CHECK_MS: TP / SL / trailing /        │
                     │ max hold / partial TP / NO_MARKET_DATA               │
                     └──────────────────────────────────────────────────────┘
```

Everything is a single Node process. There is no queue, no worker, no HTTP
server. Signal ingestion, Telegram polling and position monitoring all run as
timers inside the same event loop, which is why the monitor loop is single-flight.

## Entry point

`index.js` installs `uncaughtException` / `unhandledRejection` handlers (log, best
effort Telegram alert, exit non-zero so PM2 restarts cleanly), handles
`SIGTERM`/`SIGINT` by closing the SQLite handle, then calls `startCharon()`.

`src/app.js → startCharon()`:

1. `validateConfig()` — required env, throws before anything else runs.
2. `initDb()` — WAL, `busy_timeout`, tables, column migrations, indexes, seed
   settings and the four built-in strategies.
3. `initLiveExecution()` — loads the wallet keypair if `SOLANA_PRIVATE_KEY` is set.
4. `setupTelegram()` — registers command list and handlers. If
   `TELEGRAM_POLLING=false`, the client exists but never calls `getUpdates`.
5. Chooses the ingestion mode:
   - **Server mode** — used whenever `SIGNAL_SERVER_URL` is set. Polls
     `/api/signals` every `SIGNAL_POLL_MS`, plus the dip-alert monitor when the
     strategy is `wait_for_dip`.
   - **Standalone mode** — only when the signal URL is empty. Polls Pump.fun
     graduated coins and Jupiter trending directly, opens the fee-claim
     WebSocket, and subscribes to PumpPortal's migration feed
     (`src/signals/migrationWatcher.js`). A migration is the standalone
     equivalent of a "graduated" signal: it feeds the `graduated` map and
     triggers a candidate, with one delayed re-check 90 s later because Jupiter's
     asset index lags a fresh migration.
6. Starts the position monitor loop and the six-hourly retention prune.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/config.js` | Parses env once. Owns `minimumEntryLamports()` and `validateConfig()`. |
| `src/strategySchema.js` | Bounds for every operator-tunable number, plus `"off"` semantics. |
| `src/db/connection.js` | SQLite handle, schema, migrations, defaults, strategy seeds. |
| `src/db/positions.js` | Position CRUD, `reserveLivePosition`, `finalizeLivePosition`, `failLivePosition`, `DuplicatePositionError`, `currentPositionSizeSol`. |
| `src/db/intents.js` | Trade intents and the atomic `claimIntent`. |
| `src/db/candidates.js`, `decisions.js`, `settings.js` | Candidate snapshots, decision log, settings and strategy config. |
| `src/signals/serverClient.js` | Signal-server poll loop, server-mode strategy gates, dip alerts. |
| `src/signals/feeClaim.js`, `graduated.js`, `trending.js` | Standalone pollers. |
| `src/signals/priceMonitor.js` | `price_alerts` for `wait_for_dip`. |
| `src/enrichment/*` | Jupiter asset/holders/chart, GMGN token info, saved-wallet exposure, X narrative. |
| `src/pipeline/candidateBuilder.js` | Normalizes a signal into a candidate and applies the hard filters. |
| `src/pipeline/llm.js` | Prompt construction, model call, decision normalization. |
| `src/pipeline/orchestrator.js` | Batch screening, decision logging, mode routing, failure reporting. |
| `src/execution/router.js` | `executeLiveBuy`, `executeLiveSell`, `executeConfirmedIntent`, `rejectIntent`. |
| `src/execution/positions.js` | Position refresh, `evaluateExitReason`, partial TP, monitor loop. |
| `src/liveExecutor.js` | Jupiter Ultra order/execute, fill confirmation, token safety, wallet balance. |
| `src/telegram/*` | Bot client, auth, armed mode switch, commands, callbacks, menus. |
| `src/learning/*` | Post-run learning report and lessons. |

## Buy lifecycle (live)

Order matters. Each step is a guard.

1. `canOpenMorePositions()` — global cap.
2. `refreshCandidateForExecution()` — re-runs the strategy gates on fresh data;
   a failed re-check marks the intent `rejected_stale`.
3. `liveWalletBalanceLamports()` compared against `minimumEntryLamports(size)`.
4. `assertTokenSafety(mint)` — parses the mint account; refuses active mint
   authority, active freeze authority, or Token-2022.
5. `reserveLivePosition()` — inserts `status='pending_open'` with size, entry
   price/mcap, TP/SL and a snapshot. Duplicate mint throws.
6. `executeJupiterSwap()` — `/order`, sign locally, `/execute`.
7. `confirmSwapFill(signature)` — reads the landed transaction for the real token
   delta, fee and SOL delta; retries up to six times over ~9 seconds.
8. `finalizeLivePosition()` — flips to `open`, stores signature, token balance,
   actual spend and fee, writes the buy trade row.
9. On any failure: `failLivePosition()` marks `entry_failed` and frees the mint.
   If the failure happened after signing (`err.phase === 'execute'`), the intent is
   `execution_unknown` instead of `execution_failed`.

## Position monitor

`monitorPositions()` is single-flight: a slow sell cannot overlap the next tick.

For each open position, `refreshPosition()`:

1. Fetches Jupiter asset data. PnL comes from the mcap ratio, then the price
   ratio, then wallet PnL — never from a stale fallback.
2. If all sources are missing, increments `missing_data_cycles` instead of
   returning early.
3. `evaluateExitReason()` decides, in order: `MAX_HOLD` → `NO_MARKET_DATA` (after
   the grace cycles) → `SL` → `TP` → `TRAILING_TP`.
4. Runs partial TP (`PARTIAL_TP`) when the strategy enables it and profit is real.
5. Executes the exit. A failed sell increments `close_attempts` and leaves the
   position open; a successful sell writes the exit signature, `realized_sol` and
   the final PnL derived from all fills.

## Database

One file, WAL mode, `busy_timeout = 5000 ms`. The path is anchored to the repo
root unless `DB_PATH` is absolute or `:memory:`.

| Table | Purpose |
| --- | --- |
| `settings` | Global runtime settings (trading mode, sizing defaults, caps). |
| `strategies` | Strategy configs keyed by id: `sniper`, `dip_buy`, `smart_money`, `degen`. |
| `candidates` | Candidate snapshots with filter results; pruned after `DB_RETENTION_DAYS` unless referenced. |
| `llm_decisions`, `llm_batches` | Raw LLM output and batch grouping. |
| `decision_logs` | Audit trail: action, verdict, guardrails, execution JSON. Pruned. |
| `dry_run_positions` | The position table for every mode (`execution_mode` distinguishes). |
| `dry_run_trades` | Buy/sell fills per position, including partials. |
| `tp_sl_rules` | Per-position rule snapshot. |
| `trade_intents` | `confirm` mode intents and execution outcome. |
| `signal_events` | Raw ingested signals. Pruned. |
| `price_alerts` | Dip targets for `wait_for_dip`. |
| `saved_wallets`, `alerts`, `learning_runs`, `learning_lessons` | Wallet watchlist, sent Telegram alerts, learning output. |

Position statuses: `pending_open` → `open` → `closed`, or `pending_open` →
`entry_failed`.

Intent statuses: `pending_confirmation` → `executing` → `executed_live`, or
`rejected`, `rejected_stale`, `rejected_insufficient_balance`,
`execution_failed`, `execution_unknown`.

Exit reasons: `TP`, `SL`, `TRAILING_TP`, `MAX_HOLD`, `NO_MARKET_DATA`,
`PARTIAL_TP`, `MANUAL`, `ENTRY_FAILED`.

## External dependencies

| Service | Used for | Notes |
| --- | --- | --- |
| Signal server (`api.thecharon.xyz/api`) | Signal ingestion in server mode | Key from the maintainer; without it server mode is empty. |
| Jupiter (`api.jup.ag/swap/v2`) | Ultra quotes, swaps, asset/holders/chart data | `JUPITER_API_KEY` required for execution. |
| Helius / custom RPC | Balance, token accounts, mint account, transaction lookup | Free tier throttles; live trading wants a paid plan. |
| GMGN | Token info and trending enrichment | Rate limited: keep `GMGN_REQUEST_DELAY_MS >= 2500`. |
| LLM endpoint (OpenAI-compatible) | Candidate screening | `ENABLE_LLM=false` falls back to rule-based decisions. |
| Telegram Bot API | Interface | Long polling; no webhook. |

## Extension points

- **New strategy** — seed it in `src/db/connection.js`, add its config keys to
  `src/strategySchema.js`, expose it in `src/telegram/menus.js`. See
  [development.md](development.md#adding-a-strategy).
- **New filter** — add the check in `filterCandidate()` and surface the failure
  string; the LLM and the decision log read `candidate.filters.failures`.
- **New exchange** — only `src/execution/router.js` and `src/liveExecutor.js`
  know about Jupiter; everything above them is venue-agnostic.
