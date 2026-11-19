import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'charon-tg-'));
process.env.DB_PATH = join(dir, 'test.sqlite');
process.env.TELEGRAM_POLLING = 'false';
process.env.TELEGRAM_CHAT_ID = '-100777';
process.env.TELEGRAM_BOT_TOKEN = '123456:AAtestTokenForSuite000000000000000';
process.env.TRADING_MODE = 'dry_run';

const { initDb, closeDb } = await import('../src/db/connection.js');
const { bot } = await import('../src/telegram/bot.js');

const sent = [];
bot.sendMessage = async (chatId, text, extra = {}) => {
  sent.push({ chatId, text, extra });
  return { message_id: sent.length };
};
bot.editMessageText = async (text, options = {}) => {
  sent.push({ chatId: options.chat_id, text, extra: options });
  return { message_id: options.message_id || sent.length };
};
bot.deleteMessage = async () => true;
bot.answerCallbackQuery = async () => true;
bot.sendPhoto = async () => ({ message_id: 1 });

const { handleMessage } = await import('../src/telegram/commands.js');
const { handleCallback } = await import('../src/telegram/callbacks.js');
const { activeStrategy, setting } = await import('../src/db/settings.js');

initDb();
after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const HOME_CHAT = '-100777';
const message = (text, chatId = HOME_CHAT, userId = 42) => ({ text, chat: { id: chatId }, from: { id: userId }, message_id: 1 });
const callback = (data, chatId = HOME_CHAT, userId = 42) => ({ id: 'cb', data, from: { id: userId }, message: { chat: { id: chatId }, message_id: 1 } });
const lastText = () => sent[sent.length - 1]?.text || '';

test('a message from a foreign chat is ignored entirely', async () => {
  sent.length = 0;
  await handleMessage(message('/stratset sniper position_size_sol 1', '-999888'));
  assert.equal(sent.length, 0);
  assert.equal(activeStrategy().position_size_sol, 0.1);
});

test('an out-of-bounds /stratset is rejected with the reason', async () => {
  sent.length = 0;
  await handleMessage(message('/stratset sniper position_size_sol 100'));
  assert.match(lastText(), /^Rejected: position_size_sol must be between/);
  assert.equal(activeStrategy().position_size_sol, 0.1);
});

test('a valid /stratset is applied', async () => {
  sent.length = 0;
  await handleMessage(message('/stratset sniper position_size_sol 0.2'));
  assert.equal(activeStrategy().position_size_sol, 0.2);
});

test('a callback from a foreign chat cannot flip the trading mode', async () => {
  await handleCallback(callback('set:trading_mode:live', '-999888'));
  assert.equal(setting('trading_mode'), 'dry_run');
});

test('tapping Live from the home chat only arms, it does not switch', async () => {
  sent.length = 0;
  await handleCallback(callback('set:trading_mode:live'));
  assert.equal(setting('trading_mode'), 'dry_run');
  assert.match(lastText(), /Switch to LIVE/);
});

test('the armed confirmation switches the mode', async () => {
  await handleCallback(callback('modeconfirm:live'));
  assert.equal(setting('trading_mode'), 'live');
});

test('the arm token is single use', async () => {
  await handleCallback(callback('set:trading_mode:live'));
  await handleCallback(callback('modeconfirm:live'));
  await handleCallback(callback('modeconfirm:live', HOME_CHAT, 42));
  assert.equal(setting('trading_mode'), 'live');
});

test('returning to dry_run needs no confirmation', async () => {
  await handleCallback(callback('set:trading_mode:dry_run'));
  assert.equal(setting('trading_mode'), 'dry_run');
});

test('/setfilter cannot enable live either', async () => {
  sent.length = 0;
  await handleMessage(message('/setfilter trading_mode live'));
  assert.equal(setting('trading_mode'), 'dry_run');
  assert.match(lastText(), /armed confirmation/);
});

test('a different user cannot consume another user’s arm token', async () => {
  await handleCallback(callback('set:trading_mode:live', HOME_CHAT, 42));
  await handleCallback(callback('modeconfirm:live', HOME_CHAT, 99));
  assert.equal(setting('trading_mode'), 'dry_run');
});
