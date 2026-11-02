// Stops the clock at the moment the user presses the shutter. The database stamps the time, so the
// phone's clock can't be used to claim an earlier shot. The photo itself follows through /api/photo.
import { HttpError, route } from '../lib/http.js';
import { requireUser, rpc } from '../lib/db.js';
import { timing } from '../lib/config.js';
import { isUuid } from '../lib/ids.js';

export default route(['POST'], async (req) => {
  const user = await requireUser(req);
  const sessionId = req.body?.session_id;
  if (!isUuid(sessionId)) throw new HttpError(400, 'bad_request', 'Missing break id');
  const session = await rpc('be_stop_clock', {
    p_user_id: user.id,
    p_session_id: sessionId,
    p_retake_seconds: timing().retake,
  });
  return { session, server_now: new Date().toISOString() };
});
