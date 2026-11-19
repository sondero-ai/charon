# Development

## Setup

```bash
git clone git@github.com:sondero-ai/charon.git
cd charon
npm install
npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3   # npm 12 blocks install scripts
npm test
```

Requirements: Node.js >= 20.11, no build step, no transpiler, ESM only.

## Test suite

```bash
npm test                 # node --test test/*.test.js
npm run check            # syntax only: index.js, app.js, config.js, liveExecutor.js
```

Three suites, 30 assertions, no network and no wallet:

| File | Covers |
| --- | --- |
| `test/execution-integrity.test.js` | `reserveLivePosition` / `finalizeLivePosition` / `failLivePosition`, duplicate refusal at application and SQL level, atomic intent claim, the whole exit decision table. |
| `test/strategy-schema.test.js` | Bounds, sign rules, integer rules, `"off"` mapping, unknown keys. |
| `test/telegram-auth.test.js` | Foreign chat rejection, mode arming and single-use tokens, `/stratset` rejection path, `/setfilter` refusal. Runs through the real `handleMessage` / `handleCallback` with a stubbed bot. |

Tests set `DB_PATH` to a throwaway file and `TELEGRAM_POLLING=false` before
importing anything, because `src/config.js` reads env at module load and
`src/db/connection.js` resolves the database path once.

They must also neutralize any value a local `.env` would inject: dotenv does not
override variables that are already set, but it does fill in the ones a test
forgets to pin. `OPERATOR_USER_IDS` is the known trap — a real id there makes
every authorized-callback test fail with a rejection.

Every test file needs a unique `DB_PATH`; `node --test` runs files in separate
processes but sharing one file would cross-contaminate.

## Style

- English everywhere: code, comments, log lines, docs.
- No `class` unless state genuinely travels with behaviour; plain functions and
  module-level maps are preferred.
- Money at the boundary is an integer (lamports, raw token units). Convert for
  display only.
- A failure that leaves chain state unknown must be distinguishable from a
  failure that did nothing. Use `err.phase`.
- Log lines are prefixed by subsystem: `[server]`, `[position]`, `[live]`,
  `[auth]`, `[maintenance]`, `[bot]`, `[fatal]`.

## Adding a strategy

1. Seed it in `src/db/connection.js` next to the existing four:

```js
stratInsert.run('scalper', 'Scalper', 0, JSON.stringify({
  entry_mode: 'immediate',
  min_source_count: 1,
  // ... every key the filters read
}), ts);
```

2. Add any new numeric key to `RULES` in `src/strategySchema.js`, otherwise it
   cannot be set from Telegram.
3. Add the id to the whitelist in `/strategy` (`src/telegram/commands.js`) and to
   the strategy menu if it needs a button.
4. Run `npm test`; the schema test will catch a rule that lost its bounds.

## Adding a filter

1. Implement the check in `filterCandidate()` (`src/pipeline/candidateBuilder.js`).
2. Push a human-readable failure string into `candidate.filters.failures`; the
   LLM prompt and `decision_logs` both read it.
3. Add the threshold to the strategy seed and to `src/strategySchema.js`.
4. Surface it in `filtersText()` so the operator can see what is enforced.

## Changing execution

Read [trading-safety.md](trading-safety.md) first. The invariants at the bottom of
that document are load-bearing: reserve-before-swap, one claim per intent, exits
always evaluate, never close without a fill.

When touching the buy path, the sequence in `executeLiveBuy` and
`executeConfirmedIntent` must stay symmetric. When touching the exit path, keep
`evaluateExitReason` pure — it is the only part of the exit logic that can be unit
tested without a network.

## Adding an enrichment source

Enrichment modules return plain objects and must never throw:

```js
export async function fetchSomething(mint) {
  try { return await axios.get(...); }
  catch (err) { console.log(`[source] ${mint.slice(0, 8)}... ${err.message}`); return null; }
}
```

Wire it into `buildCandidate()` and guard every field with a default. A missing
enrichment must degrade the score, never abort the pipeline.

## Debugging a decision

`decision_logs` is the audit trail. Each row carries the guardrails, the candidate
snapshot, the batch and the execution result:

```bash
sqlite3 charon.sqlite "select id,action,mode,verdict,confidence,substr(reason,1,80) from decision_logs order by id desc limit 20;"
sqlite3 charon.sqlite "select guardrails_json from decision_logs where action='entry_not_approved' order by id desc limit 1;" | python3 -m json.tool
```

Use `TELEGRAM_POLLING=false` for a read-only boot when you want to inspect startup
without consuming updates.
