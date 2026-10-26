// Starts a relax session. The database stamps the start time, so the phone's clock doesn't matter.
import { route } from '../lib/http.js';
import { requireUser, rpc } from '../lib/db.js';
import { timing } from '../lib/config.js';

export default route(['POST'], async (req) => {
  const user = await requireUser(req);
  const t = timing();
  const session = await rpc('be_start_session', {
    p_user_id: user.id,
    p_relax_seconds: t.relax,
    p_buffer_seconds: t.buffer,
  });
  return { session, server_now: new Date().toISOString() };
});
