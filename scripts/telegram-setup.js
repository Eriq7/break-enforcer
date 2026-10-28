// One-time setup after creating the bot with @BotFather. Reads TELEGRAM_BOT_TOKEN from .env,
// points the bot's webhook at the live app, and stores the token in Supabase Vault, where the
// reminder job reads it. Prints the bot's username, never the token.
// Run: npm run telegram:setup
import { rpc } from '../lib/db.js';

const APP_URL = 'https://break-enforcer.vercel.app';
const token = process.env.TELEGRAM_BOT_TOKEN;

async function telegram(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw new Error(`Telegram ${method}: ${body?.description || 'HTTP ' + res.status}`);
  return body.result;
}

try {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is empty in .env');
  const me = await telegram('getMe');
  await telegram('setWebhook', { url: `${APP_URL}/api/telegram-hook`, allowed_updates: ['message'], drop_pending_updates: true });
  await rpc('be_set_telegram_bot', { p_token: token, p_username: me.username });
  console.log(`Done. Bot @${me.username}: webhook set, token stored in Supabase Vault.`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
