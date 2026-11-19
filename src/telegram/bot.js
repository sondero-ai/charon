import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

// TELEGRAM_POLLING=false keeps the client construction but never calls getUpdates.
// Used by the test suite and by a read-only smoke boot.
const pollingEnabled = process.env.TELEGRAM_POLLING !== 'false';

export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: pollingEnabled });
