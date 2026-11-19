# Charon — Code Review Audit

- **Target**: `yunus-0x/charon` @ `3e7b0cf` (branch `main`, clean tree, `git pull` → already up to date)
- **Date**: 2026-11-19 (WIB)
- **Scope**: full read of `src/**` (37 files, 5,063 LOC) + `index.js`, `package.json`, `.env.example`, `README.md`
- **Method**: static review, four lenses — correctness, security, data integrity, ops. No runtime execution (no `.env`, no `charon.sqlite`, no PM2 process on this box: nothing deployed yet).
- **Baseline evidence**: `node --check` on all 38 JS files → exit 0. There is **no test suite** (`npm run check` is a syntax gate over 4 files only).
- **Not verified**: live swap behaviour against Jupiter Ultra, real signal-server payload shape, Telegram delivery under rate limits. Needs a funded throwaway wallet to probe.

## Verdict

Do **not** point this at a funded wallet yet. The execution layer is the weak half: it spends real SOL before it writes the position row, decides stop-loss using market data that can be null, and exposes every money-moving control to any Telegram user. Screening/LLM half is in noticeably better shape.

- 5 critical, 6 high, 9 medium, 4 low.

---

## Critical

### C1. No Telegram authorization check — anyone can drive the wallet
**Evidence**: `src/telegram/commands.js:33` (`handleMessage`) and `src/telegram/callbacks.js:29` (`handleCallback`) never compare `msg.chat.id` / `msg.from.id` against `TELEGRAM_CHAT_ID`. Grep for `msg.from|authorized|chatId !==` across `src/` returns nothing. `README.md:58` claims "Only messages from this chat are processed" — that is not implemented.

**Impact**: add the bot to any group and every member can tap `Live` (`menus.js:142`), run `/stratset sniper position_size_sol 100` (`commands.js:54`), or press Buy/Sell on any candidate (`callbacks.js:94`, `callbacks.js:123`). With `SOLANA_PRIVATE_KEY` loaded, that is a direct path to the whole balance. Priority-ordered first fix.

**Fix**: gate both entry points on `String(msg.chat.id) === TELEGRAM_CHAT_ID` plus an operator user-id allowlist (`OPERATOR_USER_IDS`). Reject silently with a log line. Do the same for `callback_query`.

### C2. Live mode is one unconfirmed tap; manual buy does not confirm at all
**Evidence**: `menus.js:140-142` renders Dry Run / Confirm / Live as sibling inline buttons → `callbacks.js:83` → `updateSettingFromButton` → `setSetting('trading_mode', 'live')`. No dialog, no typed arm step. Then `callbacks.js:104-105` calls `executeLiveBuy` immediately on a single `buy:` tap.

**Impact**: irreversible mode escalation by a stray tap, then instant spend on the next tap. Compounds with C1. Even solo, there is no "are you sure" anywhere near the signing key.

**Fix**: two-step arm — `set:trading_mode:live` only opens a confirm message; the actual switch requires a second distinct callback id (`set:mode:live:confirmed`) that expires in 30s. Manual buy in live mode should create a `trade_intents` row like the automated path.

### C3. Duplicate or untracked live buy: the dedupe check runs *after* the swap
**Evidence**: `src/execution/router.js:25-33` — `executeJupiterSwap(...)` then `createLivePosition(...)`. `src/db/positions.js:93-97` inside `createLivePosition` looks for an existing `open` row for the same mint and **returns its id silently**. Same ordering in `executeConfirmedIntent` (`router.js:87-95`).

**Impact**: if a position for that mint is already open, the swap spends SOL and the token amount is dropped on the floor — the old row keeps its original size and `token_amount_raw`, the new tokens are never monitored, never sold. If the insert throws instead, there is no row at all, and `orchestrator.js:189-209` reports `execution_failed` for a swap that already landed on-chain. Silent, unrecoverable fund loss.

**Fix**: insert a `status='pending_open'` row (unique partial index on `mint` for `status IN ('open','pending_open')`) **before** calling Jupiter; fill `entry_signature`/`token_amount_raw` on success, mark `failed` on error. Put `size_sol` and a `client_order_id` on the row first so reconciliation is possible.

### C4. Confirmed intent can execute twice
**Evidence**: `router.js:58-63` reads `intent.status !== 'pending_confirmation'` and returns early, then performs the swap; the status is only flipped to `executed_live` at `router.js:96`, after the network round trip.

**Impact**: two quick taps on Confirm (Telegram double-send, or a retry after a slow reply) both pass the guard and both swap. Double real position for one intent.

**Fix**: atomic claim before any network call — `UPDATE trade_intents SET status='executing', updated_at_ms=? WHERE id=? AND status='pending_confirmation'`, bail when `changes === 0`. Release to `pending_confirmation` on failure.

### C5. Stop-loss is silently disarmed whenever market data is missing
**Evidence**: `src/execution/positions.js:114-116` returns `null` and exits the function when `mcap` or `entry_mcap` is not a finite positive number. All exit logic lives below that line. `pnlPercent` is derived purely from the mcap ratio (`positions.js:119`), never from on-chain holdings.

**Impact**: a dead or rugged token is exactly the case where Jupiter `datapi` stops returning `mcap`/`fdv`. That is when SL, trailing, partial TP and MAX_HOLD all stop being evaluated and the position stays `open` forever at ~zero value. This is the single most dangerous logic hole for a trench bot: no exit evaluation is not the same as "no exit needed".

**Fix**: never skip the decision on missing data. Fall back in order: `asset.usdPrice` ratio → last known high-water → a live sellable-value quote (`/order` with `amount = token balance`) → after N consecutive unquotable cycles (3 is reasonable) force an exit attempt and escalate to Telegram. Log the skip with the mint so it is auditable.

---

## High

### H1. Position monitor cycles overlap — no single-flight lock
`app.js:62` runs `setInterval(monitorPositions, 10_000)`; one cycle does wallet PnL + one `getAsset` per position + possibly a full sell (30s Jupiter timeout). `sellInProgress` (`positions.js:108`) only guards the sell itself, not the high-water update (`positions.js:175`), the close write, or the trade insert.

**Impact**: overlapping cycles race on the same row; a second cycle can recompute from stale row data after the first closed it, producing duplicate trade rows or a lost exit reason. Exit latency is unbounded when a cycle overruns.

**Fix**: module-level `let running = false` guard around `monitorPositions`, and skip the tick if still running. Persist per-position `last_checked_at` so a slow cycle is visible.

### H2. Partial TP marks done before selling, swallows the error, and misreports PnL
`positions.js:140-141` sets `partial_tp_done = 1` *before* the sell; the sell is inside `try/catch` that only logs (`positions.js:158-160`). The final close (`positions.js:193`) then computes `finalPnlSol = receivedSol - position.size_sol` using the **full** original size, ignoring SOL already received from the partial fill; the partial trade row records no proceeds (`positions.js:150-155`).

**Impact**: (a) one failed partial sell permanently disables partial TP for that position; (b) realized PnL is wrong for `smart_money`, the only seeded strategy that ships `partial_tp: true`.

**Fix**: sell first, set the flag only on success, retry with backoff; add `realized_sol` to `dry_run_positions` and compute final PnL as `(received_from_all_sells - size_sol)`.

### H3. `/stratset` accepts any value with no validation or bounds
`commands.js:54-77`: `Number(value)` with no NaN check, no range clamp, no sign check. `sl_percent 50` (positive → instant stop), `tp_percent -50`, `position_size_sol 100` all accepted in one message. NaN is stored as JSON `null` (`settings.js:64`) which then behaves unpredictably downstream: `null > 0` is false (`candidateBuilder.js:56`, `:98`) so a filter silently disables itself, while `null < 100` is **true** (`:79`) so `maxHolder > null` rejects almost every candidate.

**Impact**: a typo quietly disables a risk gate or sets position size to the entire wallet. In live mode this is one command away from a full-size entry.

**Fix**: per-key validator table (type, min, max, sign), reject NaN with the rejection reason, enforce `sl_percent < 0 < tp_percent`, cap `position_size_sol` with a new `LIVE_MAX_POSITION_SOL` env guard, and echo the normalized effective value back to chat.

### H4. Two knobs the operator can tune that do nothing
- `strat.llm_min_confidence` is only read by display code (`menus.js:124, 212, 248`) and the preset cycle. The real gate is global: `numSetting('llm_min_confidence', 75)` at `orchestrator.js:90` and `:116`. The seeded `sniper` strategy advertises `50` (`connection.js:280`) while the gate enforces 75.
- `JUPITER_SLIPPAGE_BPS` is imported at `liveExecutor.js:6` and never referenced; absent from `.env.example`; `README.md:133` says Ultra handles slippage itself.

**Impact**: the single worst class of bug in a money bot — UI and behaviour disagree, and the operator has no way to notice. Tuning the confidence slider produces zero behavioural change.

**Fix**: one source of truth. Either `strat.llm_min_confidence ?? numSetting(...)` in the gate, or delete the strategy key and its UI. Delete the unused import and the phantom env var.

### H5. Reserve check ignores ATA rent, tx fee, and slippage
`router.js:22` and `:83` gate only on `amount + LIVE_MIN_SOL_RESERVE_LAMPORTS` (default 0.02). The ATA creation rent (~0.00204 SOL), priority/tip fee, and the slippage-induced shortfall are not accounted for. `size_sol` stored on the position is the intent, not the amount actually spent.

**Impact**: with a thin wallet, the buy passes the guard and then fails on-chain; worse, after a buy the wallet can be left without enough SOL to pay the fee for the eventual **sell**, producing an unexitable position.

**Fix**: require `amount + reserve + 0.01` headroom; store actual lamports spent from the swap response; alert when live balance drops below reserve.

### H6. Position amounts and PnL are derived from intent and estimates, not the chain
`db/positions.js:114` inserts `token_amount_est = null` for every live position (the value in the `VALUES` list is a literal `null`), so the sell fallback `position.token_amount_raw || position.token_amount_est` (`router.js:49`) always resolves to nothing. `token_amount_raw` itself comes from `swap.outputAmount` which falls back to `order.outAmount` — a Jupiter **estimate**, not the fill (`liveExecutor.js:124`). Nothing ever calls `getTransaction` to confirm the fill. `estimateTokenAmountFromSol` (`jupiter.js:94`) exists but is never called.

**Impact**: a live position without `token_amount_raw` cannot be sold at all. Selling an over-estimated amount produces a failed or partial sell. Reported PnL can be fiction when `outputAmount` came from the estimate.

**Fix**: after execute, `getTransaction(signature)` → read actual token delta, SOL delta and fee; store them. Sell using `fetchLiveTokenBalance(mint)` amount, not the stored estimate. Delete or wire `estimateTokenAmountFromSol`.

---

## Medium

### M1. Trade intent shows a different size than it will spend
`intents.js:6` uses `numSetting('dry_run_buy_sol', 0.1)` and `send.js:86` prints it, while execution uses `strat.position_size_sol` (`router.js:20`, `:81`). The confirmation message can advertise 0.1 SOL and spend 0.5. **Fix**: one `currentPositionSizeSol()` helper used by both.

### M2. `confirm` mode silently downgrades a manual buy to dry-run
`callbacks.js:104`: only `live` invokes the swap; everything else — including `confirm` — falls through to `createDryRunPosition`. The automated path does open an intent for `confirm` (`orchestrator.js:170-185`), so the two paths disagree. Operator believes they entered; nothing on-chain. **Fix**: in `confirm` mode, create and send an intent from the manual-buy handler too.

### M3. `rejectIntent` does not check state
`router.js:115-119` updates any intent id, overwriting `executed_live` back to `rejected` and destroying the audit trail. **Fix**: `WHERE id=? AND status='pending_confirmation'`.

### M4. Pre-execution refresh can pass the gate on stale holder data
`positions.js:38`: `selectedHolders = holders?.holders?.length ? holders : candidate.holders` — when Jupiter returns an empty holder list (typical for a dying token) the old snapshot is reused, so `max_top20_holder_percent` is evaluated on data from minutes ago, exactly when it matters most. **Fix**: treat an empty holder response at execution time as a hard failure, not a fallback.

### M5. DB path is cwd-relative, WAL without `busy_timeout`, no graceful close
`connection.js:4` opens `DB_PATH` at module load; default `./charon.sqlite` (`config.js:6`) resolves against the process cwd, so `pm2 start` from a different directory silently creates a second empty database. `journal_mode=WAL` is set but not `busy_timeout`; `index.js` has no `SIGTERM`/`SIGINT` handler, so a PM2 restart can leave an uncheckpointed WAL. **Fix**: resolve the path against `import.meta.dirname` or an absolute env value, `pragma('busy_timeout = 5000')`, `db.close()` on SIGTERM.

### M6. No `unhandledRejection` / `uncaughtException` handler
Nothing in `index.js` or `src/`. `app.js:38` (`cleanupAlerts`) and `app.js:62` run inside `setInterval`; a synchronous throw from a DB error there becomes an `uncaughtException`, and Node exits. Async work is mostly wrapped by `makeFailureTracker` (`utils.js:146`), so the rejection class is covered — the synchronous class is not. **Impact**: the trading process dies with only a PM2 log line; open positions stop being monitored, and with C5 in play nothing would notice. **Fix**: handlers that log, alert Telegram, and exit non-zero deliberately so PM2 restarts.

### M7. One malformed signal aborts the whole poll
`serverClient.js:95` iterates `signal.sources` with no default, inside the outer `try` that wraps the entire loop. A single signal missing `sources` throws and skips every remaining signal in that cycle. **Fix**: per-signal `try/catch`, `signal.sources || []`.

### M8. No mint/freeze authority or token-2022 check before signing
Grep for `mintAuthority|freezeAuthority|getMint` across `src/` returns nothing. The bot trusts the server signal plus Jupiter asset metadata. A token with an active freeze authority can be frozen after entry — unsellable, unrecoverable, and nothing in the position monitor detects it. **Fix**: `getMint` before entry; reject when `mintAuthority` or `freezeAuthority` is set, and reject Token-2022 mints carrying transfer-hook/extension data.

### M9. `decision_logs` and `candidate_json` grow without retention
`decisions.js:68-115` writes the full candidate, every row of the batch, chart windows and holder lists per event; one signal per 30s at full JSON size is easily tens of MB/day. Only `price_alerts` has cleanup (`priceMonitor.js:114-118`). **Fix**: daily prune (30d retention) for `decision_logs`, `signal_events`, `candidates`; the box is 40G.

---

## Low

- **L1** `functions`/exports with zero call sites: `sendCandidateAlert` (`send.js:20`), `candidatesByIds` (`candidates.js:65`), `getAlertStats` (`priceMonitor.js:43`), `decideCandidate` (`llm.js:152`), `estimateTokenAmountFromSol` (`jupiter.js:94`). Dead code in a security-sensitive module invites future misuse; remove or wire.
- **L2** `liveExecutor.js:16-21` accepts both base58 and JSON-array keys with no length/format validation before `Keypair.fromSecretKey`; a malformed value produces a stack trace at startup that may echo key material length. Validate the decoded length is 64 bytes, never log the input.
- **L3** `config.js:21-22` embed the Helius key inside the RPC URL, and several catch blocks log raw `err.message` (`liveExecutor.js:50`, `jupiter.js:75`) going to PM2 logs. Not a confirmed leak — web3.js usually reports the RPC error text rather than the endpoint — but one `ECONNREFUSED`/timeout message that echoes the URL puts the key on disk. Add an error scrubber that strips `api-key=`, or use the header-based Helius auth.
- **L4** `partial_tp` DB writes (`positions.js:141` and `:149`, plus the trade insert at `:150`) are three separate statements with no transaction; a crash between them leaves the flag set with a stale amount. Wrap in `db.transaction`.

---

## Suggested fix order

1. **C1 + C2** — auth gate and mode arming. Nothing else matters until the wallet is not publicly reachable.
2. **C4 + C3** — atomic intent claim, then reserve-before-swap. These are the two ways to buy twice or lose a fill.
3. **C5 + H1** — exit evaluation that cannot be skipped, and a monitor that cannot overlap.
4. **H3 + H4** — validated control surface and removal of the knobs that lie.
5. **H6 + H5** — reconcile against the chain; size from the balance, not the intent.
6. **H2, M1-M9, L1-L4** — accounting correctness and hygiene.

## How to verify each fix (needs a throwaway wallet, never the treasury)

- C3: hold an open position on mint X, force a second `executeLiveBuy` for X → expect no swap, expect a logged refusal.
- C4: fire `intent:confirm` twice within 1s → expect exactly one `trade_intents.status='executed_live'` row and one signature.
- C5: open a position on a token whose Jupiter `mcap` returns null (rug it on a test mint) → expect an exit attempt or an alert, never a silent skip.
- H1: set `POSITION_CHECK_MS=1000` with 3 positions → expect no overlapping cycle in the logs.

---

## Fix log (branch `hardening/audit-2026-11`, pushed to `sondero-ai/charon`)

| Finding | Commit | What changed |
| --- | --- | --- |
| C1 | 275d677 | `telegram/auth.js`; every message and callback validated against `TELEGRAM_CHAT_ID` + optional `OPERATOR_USER_IDS` |
| C2 | 275d677 | `telegram/modeSwitch.js`; confirm/live require a second tap bound to chat+user, 60s TTL; `/setfilter` refuses |
| C3 | a9a0b0e | `reserveLivePosition` writes `pending_open` before signing; unique partial index; `DuplicatePositionError` |
| C4 | a9a0b0e | `claimIntent` conditional UPDATE claims before any network call |
| C5 | 1c64073 | `evaluateExitReason` + `missing_data_cycles`; `NO_MARKET_DATA` force exit after 3 cycles |
| H1 | 1c64073 | `monitorRunning` single-flight guard in `monitorPositions` |
| H2 | 1c64073 | partial TP sells first, flag after fill, `realized_sol` accumulates, PnL uses all fills |
| H3 | 8eced03 | `strategySchema.js` per-key rules wired into `/stratset`, `/setfilter`, numeric input |
| H4 | 8eced03 / bdc7db1 | gate reads `strat.llm_min_confidence`; `JUPITER_SLIPPAGE_BPS` deleted |
| H5 | a9a0b0e | `minimumEntryLamports` = size + reserve + ATA rent + fee buffer |
| H6 | a9a0b0e | `confirmSwapFill` reads `getTransaction`; sells sweep the live token balance |
| M1 | a9a0b0e | `currentPositionSizeSol()` shared by intents and execution |
| M2 | 1c64073 | manual buy in confirm mode creates a real intent |
| M3 | a9a0b0e | `rejectIntent` state-guarded |
| M4 | not changed | still falls back to the old holder snapshot; needs a product decision on stale-data policy |
| M5 | bdc7db1 | DB path anchored to project root, `busy_timeout`, `closeDb` on SIGTERM |
| M6 | bdc7db1 | `uncaughtException` / `unhandledRejection` handlers, Telegram alert, exit 1 |
| M7 | bdc7db1 | `safeTrigger`, guarded dip alerts, BigInt coercion |
| M8 | bdc7db1 | `assertTokenSafety` refuses mint/freeze authority and Token-2022 |
| M9 | bdc7db1 | `pruneOldRows` every 6h, `DB_RETENTION_DAYS` |
| L1 | bdc7db1 | five dead exports removed |
| L2 | a9a0b0e | 64-byte key validation |
| L3 | bdc7db1 | `scrubMessage` on logged error text |
| L4 | 1c64073 | partial TP DB writes wrapped in one transaction |

Verification: `npm test` 30/30 passing, `npm run check` exit 0, `node --check` clean on all 40 files, and a boot smoke (dummy env, `TELEGRAM_POLLING=false`) that started, pruned, and exited 0 on SIGTERM.

Still open: M4 (stale holder fallback), and nothing has been exercised against real Jupiter or a funded wallet.
