# Operations

## Requirements

- Linux, Node.js >= 20.11 (`import.meta.dirname`), npm.
- ~250 MB RAM at rest; SQLite is small but logs and JSON snapshots grow.
- Outbound HTTPS to Telegram, Jupiter, the signal server, GMGN, your RPC.
- `better-sqlite3` needs a native build. With npm 12, install scripts are blocked
  by default:

```bash
npm install
npm install-scripts approve better-sqlite3          # bufferutil/utf-8-validate optional
npm rebuild better-sqlite3
```

If you skip the approval the module fails with `Could not locate the bindings file`.

## Install

```bash
git clone git@github.com:sondero-ai/charon.git charon
cd charon
npm install
npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3
cp .env.example .env
chmod 600 .env
$EDITOR .env
npm test          # 30 assertions, no network, no wallet
```

`.env` holds the bot token, RPC key and (in live mode) the wallet key. Keep it
`600`, root or service-user owned, never in git.

## First boot

```bash
npm start
```

Expected lines:

```
[live] wallet loaded <pubkey>        # only when SOLANA_PRIVATE_KEY is set
[bot] Charon started (server mode: ...)   # or (standalone mode)
[maintenance] pruned {...}
```

If the process exits immediately, read the error: `validateConfig()` names the
missing variable. A config error also triggers a Telegram alert and exit code 1.

`SIGNAL_SERVER_URL` unset means it defaults to `http://localhost:3456` and you
will see `[server] connect ECONNREFUSED 127.0.0.1:3456` on every poll. Set the
URL explicitly, even if you intend standalone mode, set it to an empty value in
a wrapper script.

## Running under PM2

```bash
cd /path/to/charon
pm2 start index.js --name charon --time
pm2 save
pm2 startup            # once, to survive reboot
pm2 logs charon --lines 100
```

PM2 restarts on crash, which is what the fatal handler expects: it exits non-zero
so the supervisor starts a clean process. `index.js` closes SQLite on SIGTERM, so
`pm2 restart charon` is safe.

## Running under systemd (alternative)

```ini
[Unit]
Description=Charon trading agent
After=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/.hermes/workspace/charon
EnvironmentFile=/home/ubuntu/.hermes/workspace/charon/.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
Environment=TZ=Asia/Jakarta
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now charon
journalctl -u charon -f
```

Keep the env file outside the repo if the service user differs, and `chmod 600`.

## Health checks

```bash
pm2 status charon
pm2 logs charon --lines 50 --nostream

# last position activity
sqlite3 charon.sqlite "select id,status,exit_reason,round(pnl_percent,2),datetime(opened_at_ms/1000,'unixepoch','localtime') from dry_run_positions order by id desc limit 5;"

# open positions and whether the monitor is current
sqlite3 charon.sqlite "select id,mint,round(size_sol,3),missing_data_cycles,datetime(last_checked_at_ms/1000,'unixepoch','localtime') from dry_run_positions where status in ('open','pending_open');"

# stuck intents
sqlite3 charon.sqlite "select id,status,error from trade_intents where status not in ('executed_live','rejected') order by id desc limit 10;"
```

Signals that something is wrong:

- `last_checked_at_ms` older than two monitor intervals.
- A position stuck in `pending_open` (crash between reserve and finalize).
- `execution_unknown` intents.
- `[position] ... exit ... blocked` repeating.
- `missing_data_cycles` climbing.

## Backup and restore

The database is the only state. Back it up with SQLite, not `cp` (WAL).

```bash
sqlite3 charon.sqlite ".backup '/backup/charon-$(date +%F).sqlite'"
```

Restore: stop the bot, replace `charon.sqlite`, delete stale `-wal`/`-shm`, start.

Pruning runs on boot and every six hours: `decision_logs`, `signal_events`,
`learning_runs` and unreferenced candidates older than `DB_RETENTION_DAYS`.
Positions, trades, intents, settings and strategies are never pruned.

## Upgrade

```bash
cd /path/to/charon
git pull
npm install            # only if package.json moved
npm test
pm2 restart charon
pm2 logs charon --lines 30 --nostream
```

Schema migrations are additive (`ensureColumn`) and run at boot, so a downgrade is
not supported but an upgrade is safe. The unique position index is created with a
`try/catch`: if an old database already holds duplicate open positions the index
is skipped with a log line and the application guard still applies. Clean those
rows before relying on the index.

## Restart semantics

- `SIGTERM` → close SQLite → exit 0.
- Crash / unhandled rejection → log, alert on Telegram, exit 1 → supervisor
  restarts.
- While the process is down, signals are missed and positions are not monitored.
  Keep the supervisor aggressive (`Restart=always`, `RestartSec=5`).

## Checklist before going live

- [ ] `npm test` green.
- [ ] `.env` mode `600`, wallet key present only if you intend to trade.
- [ ] `TRADING_MODE` in the DB matches what you think (check via `/menu → Agent`).
- [ ] `LIVE_MIN_SOL_RESERVE` ≥ 0.02 SOL, `LIVE_MAX_POSITION_SOL` set to your cap.
- [ ] Paid RPC if you expect more than a handful of positions.
- [ ] `GMGN_REQUEST_DELAY_MS` ≥ 2500.
- [ ] Backup of `charon.sqlite` taken.
- [ ] One `confirm` mode trade executed end to end, including the exit.
