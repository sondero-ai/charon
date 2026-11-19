import { bot } from './bot.js';
import { setSetting } from '../db/settings.js';
import { agentText, agentKeyboard } from './menus.js';

const ARM_TTL_MS = 60_000;
const pendingArms = new Map();

function armKey(chatId, userId) {
  return `${chatId}:${userId ?? 'anon'}`;
}

export function pruneExpiredArms(atMs = Date.now()) {
  for (const [key, arm] of pendingArms) {
    if (atMs - arm.at > ARM_TTL_MS) pendingArms.delete(key);
  }
}

/**
 * Escalating into confirm/live is irreversible once a swap lands, so it takes a
 * second deliberate tap bound to the same chat+user and expiring in 60s.
 */
export async function requestModeArm({ chatId, userId, mode }) {
  if (!['confirm', 'live'].includes(mode)) {
    return bot.sendMessage(chatId, `Unknown mode "${mode}". Use dry_run, confirm, or live.`);
  }
  pruneExpiredArms();
  pendingArms.set(armKey(chatId, userId), { mode, at: Date.now() });
  const warning = mode === 'live'
    ? 'Live mode signs and sends real Jupiter swaps with your wallet key.'
    : 'Confirm mode will ask for one extra tap before every real swap.';
  return bot.sendMessage(chatId, [
    `⚠️ <b>Switch to ${mode.toUpperCase()}?</b>`,
    '',
    warning,
    'This confirmation expires in 60 seconds.',
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: `Yes, enable ${mode}`, callback_data: `modeconfirm:${mode}` }],
        [{ text: 'Cancel', callback_data: 'menu:agent' }],
      ],
    },
  });
}

export function consumeModeArm({ chatId, userId, mode }) {
  pruneExpiredArms();
  const key = armKey(chatId, userId);
  const arm = pendingArms.get(key);
  if (!arm || arm.mode !== mode) return false;
  pendingArms.delete(key);
  return true;
}

export async function confirmModeArm({ chatId, userId, mode, query }) {
  if (!consumeModeArm({ chatId, userId, mode })) {
    const stale = 'That confirmation expired or was never requested. Tap the mode again.';
    if (query?.message) {
      return bot.sendMessage(chatId, stale);
    }
    return null;
  }
  setSetting('trading_mode', mode);
  const text = `${agentText()}\n\n✅ Mode set to <b>${mode}</b>.`;
  if (query?.message?.message_id) {
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...agentKeyboard(),
      });
    } catch (err) {
      if (!/message is not modified/i.test(err.message)) throw err;
      return null;
    }
  }
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...agentKeyboard() });
}
