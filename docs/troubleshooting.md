# Troubleshooting

## Startup

**`Error: Could not locate the bindings file`**
`better-sqlite3` was installed without its native build. npm 12 blocks install
scripts by default:

```bash
npm install-scripts approve better-sqlite3
npm rebuild better-sqlite3
```

**`Error: TELEGRAM_BOT_TOKEN is required.` (or another variable)**
`validateConfig()` failed. The bot also sends this to Telegram before exiting with
code 1. Fix `.env`, restart.

**`Error: HELIUS_API_KEY is required unless SOLANA_RPC_URL and SOLANA_WS_URL are set.`**
Set `HELIUS_API_KEY`, or both URLs explicitly.

**`[telegram] commands ETELEGRAM: 401 Unauthorized`**
The bot token is wrong or was revoked. Only appears with a fake token in smoke
tests too — that is expected there.

**Process starts then exits within a second**
Read the first stack trace. If it is a config error, the fatal handler already
alerted the chat. If it is a native binding error, see the first item.

## Signals

**`[server] connect ECONNREFUSED 127.0.0.1:3456`**
`SIGNAL_SERVER_URL` is unset and defaults to a local dev server. Set it to the real
server (`https://api.thecharon.xyz/api`). To run the standalone pollers instead,
set `SIGNAL_SERVER_URL=` (empty) explicitly.

**`[server] 401` or `403`**
`SIGNAL_SERVER_KEY` missing or wrong. Server mode has no fallback; the pipeline
stays empty without it.

**`[server] N signals, 0 triggered` every cycle**
The strategy gates are rejecting everything. Open `/filters` and compare with the
candidate cards. Usual suspects: `min_source_count = 2` with single-source flow,
`require_fee_claim = true`, or `min_mcap_usd` above the current meta.

**Nothing at all in the chat**
Check, in this order: `agent_enabled`, the trading mode (`/menu → Agent`), open
position count versus `max_open_positions`, `use_llm` with an empty
`LLM_API_KEY`, and the strategy `llm_min_confidence` versus the verdicts in
`decision_logs`.

## Enrichment

**GMGN returning 429 or a banned key**
`GMGN_REQUEST_DELAY_MS` must be >= 2500 (default). Lowering it is the fastest way
to get the key blocked. `GMGN_ENABLED=false` falls back to Jupiter data and is a
valid permanent configuration.

**Jupiter 429 on `/order`**
There is no automatic retry on the swap path: the attempt fails and is recorded as
`execution_failed` (nothing was signed). Retry manually. Enrichment reads are
cached; if `fetchJupiterAsset` returns null the position falls into the missing
data path.

**Helius free tier throttling**
Position monitoring and fill confirmation need reliable RPC. Free tier will
time out under load, which surfaces as `[live] fill lookup ...` or a position whose
`last_checked_at_ms` stops advancing. Use a paid plan for anything beyond dry run.

## Execution

**`Refused: an open position for this mint already exists`**
Working as designed: the duplicate guard fired before signing. Close the existing
position or let it exit.

**`execution_unknown` intent**
The transaction was signed, then `/execute` timed out or 5xx'd. It may have
landed. Check the wallet and the token account before retrying. Do not retry
blindly; you can double your position.

**`Live position has no token amount to sell`**
`token_amount_raw` is null, which means the entry fill was never confirmed. Inspect
the entry signature with `getTransaction`, then either set the real amount or close
the row manually after selling by hand.

**`[position] ... exit SL blocked: ...` repeating**
The sell is failing — usually no liquidity, no SOL for the fee, or a frozen
account. `close_attempts` increments. Top up the wallet or exit manually; the
position stays open on purpose.

**Position stuck in `pending_open`**
The process died between reserving and finalizing. Check the swap signature in
`snapshot_json`, confirm on-chain what happened, then either
`UPDATE dry_run_positions SET status='open' ...` with the real amounts or
`failLivePosition` semantics: set `status='entry_failed'`.

**`[db] one-open-position index skipped`**
An old database already holds two open positions for one mint. Find them,
close one, restart so the unique index can be created.

## Telegram

**`[auth] rejected message chat=... user=...` on your own commands**
`TELEGRAM_CHAT_ID` does not match the chat you are typing in (group vs supergroup
ids differ, and a forum topic is still the group id). Copy the id from the log
line and update `.env`, then restart.

**Tapping Live does nothing but shows "Switch to LIVE?"**
That is the arming step. Press **Yes, enable live** within 60 seconds, from the
same account.

**"That confirmation expired or was never requested"**
The 60-second arm expired, or another user tapped it. Tap the mode button again.

**`Rejected: <key> must be between ...`**
The new bounds are doing their job. Read the message: it names the allowed range.

**Alerts stop after a restart**
`setupTelegram()` runs at boot. If the bot is alive but silent, check
`agent_enabled` and whether the position/decision loops are logging at all.

## Database

**Two different databases / history disappeared**
Fixed: `DB_PATH` now resolves against the repo root. If you still see two files,
one of them was created by an older build that used the process cwd. Compare
`sqlite3 file.sqlite "select count(*) from dry_run_positions"` and keep the real one.

**Disk growing**
Retention prunes every six hours. If it is still growing, check for a `-wal` file
that never checkpoints (process killed with SIGKILL) and for
`dry_run_trades.payload_json` on very active strategies.

**`[maintenance] pruned {"decision_logs":"skipped: ..."}`**
A column the prune expects is missing, which means the DB predates the current
schema. Run the current build once so `ensureColumn` migrations apply; the other
tables still prune.
