# Telegram interface

One bot, one authorized chat, optional forum topic. Long polling, no webhook.

## Ingress rules

`handleMessage` and `handleCallback` call `isAuthorizedChat()` and
`isAuthorizedUser()` before anything else:

- The chat id must equal `TELEGRAM_CHAT_ID`. Anything else is dropped and logged
  as `[auth] rejected message chat=... user=...`.
- If `OPERATOR_USER_IDS` is set, the sender must be listed. This matters in a
  group: without it, every member can press buttons.

## Commands

| Command | Effect |
| --- | --- |
| `/menu` | Main inline menu. |
| `/strategy [id]` | Show strategies, or switch the active one (`sniper`, `dip_buy`, `smart_money`, `degen`). |
| `/stratset <id> <key> <value>` | Set one strategy value. Validated; out-of-range values are rejected with the reason. |
| `/filters` | Current strategy filters and trending config. |
| `/setfilter <key> <value>` | Set a global filter or setting. Refuses `trading_mode` other than `dry_run` and refuses `llm_min_confidence` (that one lives on the strategy). |
| `/positions` | Open and recent positions. |
| `/candidate <mint>` | Candidate detail by mint. |
| `/pnl` | Saved-wallet PnL summary. |
| `/learn [window]` | Run a learning report (`12h` default). |
| `/lessons` | Active screening lessons. |
| `/wallets` | Saved wallet list. |
| `/walletadd <label> <address>` | Track a wallet for exposure and PnL. |
| `/walletremove <label>` | Stop tracking. |

All command output is HTML-escaped before it reaches the API; token names and LLM
text cannot break the message.

## Menus and buttons

Callback payloads are colon-separated and namespaced:

| Namespace | Meaning |
| --- | --- |
| `menu:<screen>` | Navigate: `main`, `strategy`, `agent`, `filters`, `wallets`, `positions`, `pnl`, `settings`. |
| `set:<key>:<value>` | Change a setting. `set:trading_mode:confirm` and `set:trading_mode:live` only *arm*, they do not switch. |
| `modeconfirm:<mode>` | The second tap that actually switches to `confirm`/`live`. |
| `input:<key>` | Prompt for a numeric value on a global setting. |
| `stratinput:<key>` | Prompt for a numeric value on the active strategy. |
| `toggle:agent` | Turn the agent on/off. |
| `batch:<id>` | Re-open a screening batch. |
| `cand:<id>` / `ign:<id>` | Show or ignore a candidate. |
| `buy:<id>` | Manual buy: honours the current mode exactly (`dry_run` writes a simulated row, `confirm` creates an intent, `live` swaps). |
| `intent:<id>:confirm` / `intent:<id>:reject` | Act on a `confirm`-mode intent. |
| `pos:<id>` | Refresh a position card. |
| `sell:<id>` | Manual full exit. |
| `tp:<id>:<pct>` / `sl:<id>:<pct>` | Adjust TP/SL on an open position. |
| `trail:<id>` | Toggle trailing on an open position. |
| `tpsl` | Show default TP/SL rules. |
| `noop` | Disabled button. |

## Mode switching

```
/menu → Agent → [Confirmed|Live]
        ↓
"Switch to LIVE? This confirmation expires in 60 seconds."
        ↓
[Yes, enable live]  ← second tap, same chat, same user
        ↓
Mode set to live
```

Properties:

- The arm token is single use and expires after 60 seconds.
- It is bound to `chat_id + user_id`; another user cannot consume it.
- Tapping Cancel or navigating away leaves the mode untouched.
- `dry_run` is always one tap, because it only removes capability.

## Financial messages

- Candidate card: signal route, name/symbol, mint link, mcap/liquidity/fees,
  holders, trending block, chart context, LLM verdict and reason.
- Screening batch: trigger candidate, the pick (or `none`), verdict, reason.
- Trade intent: size in SOL, confidence, reason, Confirm/Reject buttons.
- Position card: entry price/mcap, high-water, size, PnL, TP/SL/trailing, entry
  and exit signatures linked to Solscan.
- Exit message: reason, exit mcap, realised PnL percent and SOL, transaction link.

Numbers come from the database and, for live positions, from the landed
transactions. Nothing in a message claims a profit that the ledger does not hold.

## Alert sources

| Prefix in logs | Origin |
| --- | --- |
| `[server]` | Signal server poll cycle |
| `[position]` | Monitor loop |
| `[live]` | Wallet, swaps, fill confirmation |
| `[auth]` | Rejected ingress |
| `[maintenance]` | Retention prune |
| `[bot]`, `[fatal]` | Lifecycle |
