// Starts a relax session. The database stamps the start time, so the phone's clock doesn't matter.
// The app sends the length picked on the dial; without one it is the default 45:25.
// Needs a saved card: the break records the server's Stripe mode, and a failure is charged in it.
import { route } from '../lib/http.js';
import { requireUser, rpc } from '../lib/db.js';
import { chosenRelax, timing } from '../lib/config.js';
import { payments } from '../lib/stripe.js';

export default route(['POST'], async (req) => {
  const user = await requireUser(req);
  const t = timing();
  const session = await rpc('be_start_session', {
    p_user_id: user.id,
    p_relax_seconds: chosenRelax(req.body?.relax_seconds, t.relax),
    p_buffer_seconds: t.buffer,
    p_billing_mode: payments().mode,
  });
  return { session, server_now: new Date().toISOString() };
});
