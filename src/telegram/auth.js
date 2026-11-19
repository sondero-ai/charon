import { OPERATOR_USER_IDS, TELEGRAM_CHAT_ID } from '../config.js';

const operatorIds = new Set(
  String(OPERATOR_USER_IDS || '')
    .split(/[\s,]+/)
    .map(value => value.trim())
    .filter(Boolean),
);

const homeChatId = String(TELEGRAM_CHAT_ID || '').trim();

export function operatorAllowlistSize() {
  return operatorIds.size;
}

/**
 * Every money-moving command and button must originate from the configured chat.
 * TELEGRAM_CHAT_ID is the only accepted origin; there is no wildcard.
 */
export function isAuthorizedChat(chatId) {
  if (chatId == null || !homeChatId) return false;
  return String(chatId) === homeChatId;
}

/**
 * Optional second factor: when OPERATOR_USER_IDS is set, only those user ids may
 * drive the bot even inside the home chat. Empty list keeps chat-scoped access.
 */
export function isAuthorizedUser(userId) {
  if (!operatorIds.size) return true;
  if (userId == null) return false;
  return operatorIds.has(String(userId));
}

export function rejectUnauthorized({ kind, chatId, userId, detail = '' }) {
  console.log(`[auth] rejected ${kind} chat=${chatId ?? '-'} user=${userId ?? '-'} ${detail}`.trim());
}
