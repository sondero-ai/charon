import { startCharon } from './src/app.js';

let shuttingDown = false;

async function alertFatal(label, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `💀 <b>Charon crashed</b>\n${label}: ${String(text).slice(0, 500)}`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // the process is already dying; nothing else to do
  }
}

async function fatal(label, error) {
  const detail = error?.stack || error?.message || String(error);
  console.error(`[fatal] ${label}: ${detail}`);
  if (shuttingDown) return;
  shuttingDown = true;
  await alertFatal(label, detail);
  // Exit non-zero so the supervisor restarts a clean process instead of leaving
  // a half-dead one whose monitor loops have stopped.
  process.exit(1);
}

process.on('uncaughtException', (err) => { fatal('uncaughtException', err); });
process.on('unhandledRejection', (err) => { fatal('unhandledRejection', err); });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received`);
    import('./src/db/connection.js')
      .then(({ closeDb }) => closeDb())
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}

startCharon().catch((error) => fatal('startup', error));
