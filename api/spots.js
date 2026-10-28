// Add (POST { name }) or delete (DELETE ?id=) a check-in spot. Both are refused while a session runs.
// Deleting a spot deletes its reference photos too.
import { HttpError, queryParam, route } from '../lib/http.js';
import { requireUser, rpc } from '../lib/db.js';
import { remove } from '../lib/photos.js';
import { isUuid } from '../lib/ids.js';

export default route(['POST', 'DELETE'], async (req) => {
  const user = await requireUser(req);

  if (req.method === 'POST') {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) throw new HttpError(400, 'bad_request', 'Give the spot a name');
    if (name.length > 40) throw new HttpError(400, 'bad_request', 'Keep the name under 40 characters');
    const spot = await rpc('be_add_spot', { p_user_id: user.id, p_name: name });
    return { id: spot.id };
  }

  const id = queryParam(req, 'id');
  if (!isUuid(id)) throw new HttpError(400, 'bad_request', 'Missing spot id');
  const paths = await rpc('be_delete_spot', { p_user_id: user.id, p_spot_id: id });
  await Promise.all(paths.map((p) => remove(p).catch((e) => console.error('left a file behind:', p, e.message))));
  return { ok: true };
});
