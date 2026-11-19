# Trading safety

Charon spends real SOL in `confirm` and `live`. Every rule below is implemented in
code; the file and function are named so you can verify it.

## The three modes

| Mode | What a BUY does | Wallet needed |
| --- | --- | --- |
| `dry_run` | Writes a simulated position. No network call, no signing. | No |
| `confirm` | Creates a `trade_intents` row and a Telegram message with Confirm/Reject. | Yes |
| `live` | Signs and sends a Jupiter Ultra swap immediately after the gates pass. | Yes |

Escalation to `confirm` or `live` requires an armed confirmation: a second tap
bound to the same chat and user, valid 60 seconds. Returning to `dry_run` is
immediate and needs nothing. A slash command (`/setfilter trading_mode live`)
cannot escalate; it is refused by design.

## What guards a live entry

In order:

1. **Authorized ingress** — `src/telegram/auth.js`. Messages and callbacks from
   any chat other than `TELEGRAM_CHAT_ID` are dropped before a handler runs.
   `OPERATOR_USER_IDS` narrows it further.
2. **Position cap** — `canOpenMorePositions()`.
3. **Fresh re-check** — `refreshCandidateForExecution()` re-runs the strategy
   filters. Stale data means `rejected_stale`, not an entry.
4. **Balance budget** — `minimumEntryLamports()` covers size + reserve + ATA rent
   + fee buffer. It is not just the position size.
5. **Token safety** — `assertTokenSafety()` refuses an active mint authority, an
   active freeze authority, or a Token-2022 mint.
6. **Reserve before swap** — `reserveLivePosition()` writes `pending_open` before
   anything is signed. The unique partial index on
   `(mint) WHERE status IN ('open','pending_open')` makes a duplicate impossible.
7. **One claim per intent** — `claimIntent()` is a conditional `UPDATE`; a double
   tap on Confirm cannot swap twice.
8. **Chain truth** — `confirmSwapFill()` reads the landed transaction for the real
   token delta, fee and SOL delta. Stored size and PnL come from the chain, never
   from Jupiter's `outAmount` estimate.
9. **Bounded size** — `position_size_sol` is validated against
   `LIVE_MAX_POSITION_SOL` (default 5 SOL) before it is ever used.

## Exit rules

`evaluateExitReason()` in `src/execution/positions.js`, evaluated every
`POSITION_CHECK_MS`:

| Reason | Trigger |
| --- | --- |
| `MAX_HOLD` | Position age exceeds the strategy's `max_hold_ms`. |
| `NO_MARKET_DATA` | Market data missing for `MISSING_DATA_EXIT_CYCLES` consecutive cycles (default 3). Force-exit attempt. |
| `SL` | PnL ≤ `sl_percent`. |
| `TP` | PnL ≥ `tp_percent` and trailing is off. |
| `TRAILING_TP` | Armed trailing and the mcap dropped `trailing_percent` from the high-water mark. |
| `PARTIAL_TP` | Profit ≥ `partial_tp_at_percent`; sells `partial_tp_sell_percent`. Not a full exit. |
| `MANUAL` | Operator pressed sell. |

Order matters: max hold always wins, then the missing-data escalation, then stop
loss, then take profit, then trailing.

Two properties that are easy to break and must not be:

- A missing number is an **exit signal after a grace period**, never an excuse to
  skip evaluation. A token that stops reporting is the shape of a rug.
- A position is only marked `closed` after the sell lands (live) or immediately
  in dry run. A failed sell leaves it open and increments `close_attempts`.

## Partial take profit

When a strategy enables `partial_tp`:

1. Charon sells `partial_tp_sell_percent` of the *confirmed* token balance.
2. Only after the fill lands does it set `partial_tp_done = 1`, reduce
   `token_amount_raw`, and add the proceeds to `realized_sol`.
3. If the sell throws, the flag stays unset and the next cycle retries. A failed
   partial sell never disables the rule.
4. The flag write, the balance update and the trade row are one transaction.

If the position has no confirmed token balance yet, partial TP is skipped and
logged rather than guessing an amount.

## PnL accounting

- Entry cost is the SOL actually spent, taken from the landed transaction.
- `realized_sol` accumulates every sell: partial and final.
- Final realised PnL = `realized_sol + final_sell_proceeds − entry_cost`.
- `pnl_percent` for a live close is recomputed from that SOL figure, not from the
  mcap ratio.
- Fees are stored per fill in `entry_fee_lamports` and inside the trade payload;
  report them, do not bury them.

## Failure states you must respect

| State | Meaning | What to do |
| --- | --- | --- |
| `entry_failed` | The swap did not land. The mint is unlocked. | Read `exit_reason`; safe to retry. |
| `execution_failed` | Failed before signing (order rejected, balance, safety). | Nothing on chain. Fix the cause. |
| `execution_unknown` | The transaction was signed but the execute call never answered. It may have landed. | **Check the wallet and the signature before retrying.** Never auto-retry. |
| `rejected_stale` | Gates failed on the fresh check. | Nothing on chain. |
| `rejected_insufficient_balance` | Budget including reserve/rent/fees not met. | Top up or reduce size. |

## What is not protected

Be explicit about the limits:

- **Slippage and routing are Jupiter Ultra's.** There is no local slippage knob;
  a bad route is a bad fill.
- **A token with revoked authorities can still go to zero.** Safety checks only
  remove the freeze/inflate classes.
- **Stale holder data at execution time.** If Jupiter returns an empty holder
  list, `refreshCandidateForExecution` still falls back to the candidate
  snapshot. Treat the top-holder gate as advisory at execution, not guaranteed.
- **Free-tier RPC will throttle.** Position monitoring can miss a tick; the
  single-flight loop prevents overlap, not latency.
- **No reconciliation job.** A position that somehow bypassed the DB (manual
  wallet trade, crashed process between swap and finalize) is not adopted
  automatically. Check the wallet after any crash mid-entry.

## Operating discipline

1. Run `dry_run` until you have seen your own pipeline produce candidates and
   simulate exits. `npm test` proves the code paths, not your config.
2. Move to `confirm` and place a deliberately small `position_size_sol`. Confirm
   one trade end to end, including the sell.
3. Only then `live`, with `LIVE_MIN_SOL_RESERVE` at least 0.02 SOL and a wallet
   holding only what you are willing to lose.
4. Never judge a parameter change from one or two trades. Record candidate count,
   win rate and PnL before and after.
