// POST: a one-time link that opens Telegram and connects this user's chat for reminders.
import { route } from '../lib/http.js';
import { requireUser, rpc } from '../lib/db.js';
import { linkUrl, newLinkCode } from '../lib/telegram.js';

export default route(['POST'], async (req) => {
  const user = await requireUser(req);
  const code = newLinkCode();
  const bot = await rpc('be_telegram_code', { p_user_id: user.id, p_code: code });
  return { url: linkUrl(bot, code) };
});
