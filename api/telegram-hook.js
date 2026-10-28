// Telegram calls this for each message sent to the bot (registered by scripts/telegram-setup.js).
// The one message it acts on is "/start <code>" from the app's link, which ties that chat to the
// user. The reply goes back in the response, which Telegram allows for webhooks, so this needs no
// bot token. Anyone can call this URL, but without a valid code it changes nothing.
import { route } from '../lib/http.js';
import { rpc } from '../lib/db.js';
import { startCode } from '../lib/telegram.js';

export default route(['POST'], async (req) => {
  const message = req.body?.message;
  const chat = message?.chat;
  if (!chat || chat.type !== 'private') return {};
  const code = startCode(message.text);
  const userId = code ? await rpc('be_telegram_link', { p_code: code, p_chat_id: chat.id }) : null;
  return {
    method: 'sendMessage',
    chat_id: chat.id,
    text: userId
      ? "Connected. I'll message you here 5 minutes before each break ends."
      : 'To get reminders, open Break Enforcer, tap Connect next to Telegram, then tap Start here. The link works for 15 minutes.',
  };
});
