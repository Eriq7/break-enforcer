// Telegram reminders, the parts the server needs. The reminder itself is sent by the database
// (be_send_reminders, every minute), so the server never holds the bot token.
import { randomBytes } from 'node:crypto';

// For the t.me/<bot>?start=<code> link. Telegram allows A-Z, a-z, 0-9, _ and -, up to 64 characters.
export function newLinkCode() {
  return randomBytes(24).toString('base64url');
}

export function linkUrl(bot, code) {
  return `https://t.me/${bot}?start=${code}`;
}

// The code in "/start <code>", or null for any other message.
export function startCode(text) {
  const m = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{1,64})$/.exec(String(text || '').trim());
  return m ? m[1] : null;
}
