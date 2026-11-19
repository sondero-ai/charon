# Charon docs

Charon is a Telegram agent that screens Pump.fun / Solana memecoin signals, asks
an LLM to pick one candidate, executes the buy through `dry_run`, `confirm` or
`live`, and monitors the position until an exit rule fires.

Start here, then follow the link that matches what you are doing.

| Document | Read it when |
| --- | --- |
| [architecture.md](architecture.md) | You need the module map, data flow, or database schema |
| [configuration.md](configuration.md) | You are filling `.env` or tuning a strategy |
| [operations.md](operations.md) | You are deploying, restarting, backing up, or upgrading |
| [trading-safety.md](trading-safety.md) | You are touching execution, exits, or sizing |
| [telegram.md](telegram.md) | You are using or changing the bot interface |
| [development.md](development.md) | You are adding a strategy, filter, or test |
| [troubleshooting.md](troubleshooting.md) | Something logged an error and you need the cause |
| [audits/2026-11-19-code-review.md](audits/2026-11-19-code-review.md) | You want the hardening history and its rationale |

## The 60-second version

1. `npm install`, copy `.env.example` to `.env`, fill the five required values.
2. `npm start`. With `TRADING_MODE=dry_run` nothing touches the chain.
3. The bot polls the signal server every `SIGNAL_POLL_MS`, gates candidates with
   the active strategy, screens them with an LLM, and stores decisions in SQLite.
4. A buy goes through `src/execution/router.js`. Open positions are re-checked
   every `POSITION_CHECK_MS` by `src/execution/positions.js`.
5. Every money-moving action is guarded: authorized chat only, armed mode switch,
   reserve-before-swap, chain-verified fill, and exits that cannot be skipped.
   The full list is in [trading-safety.md](trading-safety.md).

## Hard facts

- Runtime: Node.js >= 20.11 (ESM, `import.meta.dirname`), SQLite via `better-sqlite3`.
- No build step, no transpiler. `node index.js` runs the source directly.
- State: one SQLite file (`charon.sqlite` by default), resolved against the repo
  root, not the process working directory.
- Tests: `npm test` (30 assertions). `npm run check` is only a syntax gate.
- Modes: `dry_run` (default) → `confirm` (one tap per trade) → `live` (spends).
  Escalating to `confirm`/`live` requires an armed confirmation in Telegram.
