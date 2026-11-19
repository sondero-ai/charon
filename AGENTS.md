# AGENTS.md — Charon

Operational notes for agents and humans working in **this repository**.
For product documentation, start at [`docs/README.md`](docs/README.md).
Box-specific deployment state (paths, bot tokens, thread ids, live wallet) lives
in the Hermes profile runbook, not here.

## What this is

Telegram trench agent for Pump.fun / Solana memecoins. It ingests signals from a
private signal server (or its own pollers), gates them through a strategy, asks an
LLM to pick one candidate, then routes the buy through `dry_run`, `confirm`, or
`live` execution and monitors the position until TP/SL/trailing/max-hold.
Node.js, ESM, no build step, SQLite for state.

## Commands

```bash
npm install     # Node >= 20.11 (uses import.meta.dirname)
npm test        # node --test, 3 files, 30 assertions
npm run check   # syntax gate over the 4 entry files
npm start       # node index.js
```

`npm test` is the real gate. `npm run check` only parses a subset of files.

## Layout

```
index.js              process entry: fatal handlers, signal shutdown
src/app.js            startCharon(): config validation, DB init, mode selection, loops
src/config.js         env parsing, minimumEntryLamports(), validateConfig()
src/strategySchema.js bounds for every operator-tunable number
src/db/               connection + migrations, one module per aggregate
src/signals/          signal server client, Pump.fun pollers, price alerts
src/enrichment/       Jupiter, GMGN, saved wallets, X narrative
src/pipeline/         candidate builder, LLM screening, orchestrator
src/execution/        router (buy/sell), position monitor and exit rules
src/telegram/         bot client, commands, callbacks, menus, auth, mode arming
test/                 node:test suites for the money paths
docs/                 product documentation (see docs/README.md)
```

## Invariants — do not break these

1. **Reserve before swap.** A live entry writes a `pending_open` position row
   *before* a transaction is signed. The unique partial index on
   `(mint) WHERE status IN ('open','pending_open')` is the duplicate guard.
   Never reintroduce a "swap first, store later" path.
2. **One claim per intent.** `claimIntent()` uses
   `UPDATE ... WHERE status='pending_confirmation'` and must run before any
   network call.
3. **Exits always evaluate.** A missing `mcap`/`price` is a data outage, not a
   reason to skip the decision. `evaluateExitReason()` escalates to
   `NO_MARKET_DATA` after `MISSING_DATA_EXIT_CYCLES`.
4. **Never mark a position closed** unless the sell landed or it is a dry-run row.
5. **Everything in `src/strategySchema.js` has bounds.** New numeric settings need
   a rule there or they cannot be set from Telegram.
6. **Auth before handlers.** `handleMessage`/`handleCallback` validate
   `TELEGRAM_CHAT_ID` (plus optional `OPERATOR_USER_IDS`) first.
7. **confirm/live require arming.** A single tap or a slash command must not
   escalate the trading mode.

## Conventions

- English in all code, comments, logs and docs.
- ESM only, no transpiler, no test framework beyond `node:test`.
- Money math in lamports (`BigInt`/integers) at the boundary; human units only for display.
- Errors that mean "state unknown" must be distinguishable from "failed"
  (`err.phase === 'execute'`).
- `npm test` must pass before any commit that touches `src/execution/`,
  `src/db/`, or `src/strategySchema.js`.
