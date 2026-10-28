// Add (POST { spot_id, image }) or delete (DELETE ?id=) a reference photo. Both are refused while a session runs.
import { HttpError, queryParam, route } from '../lib/http.js';
import { db, requireUser, rpc } from '../lib/db.js';
import { decodeJpeg, referencePath, remove, upload } from '../lib/photos.js';
import { isUuid } from '../lib/ids.js';

export default route(['POST', 'DELETE'], async (req) => {
  const user = await requireUser(req);

  if (req.method === 'POST') {
    const spotId = req.body?.spot_id;
    if (!isUuid(spotId)) throw new HttpError(400, 'bad_request', 'Missing spot id');
    const photo = decodeJpeg(req.body?.image);
    const path = referencePath(user.id);
    // The row goes in first: that is where the session lock and the photo limit are checked.
    const ref = await rpc('be_add_reference', { p_user_id: user.id, p_spot_id: spotId, p_storage_path: path });
    try {
      await upload(path, photo);
    } catch (e) {
      await db().from('reference_photos').delete().eq('id', ref.id);
      throw e;
    }
    return { id: ref.id };
  }

  const id = queryParam(req, 'id');
  if (!isUuid(id)) throw new HttpError(400, 'bad_request', 'Missing photo id');
  const path = await rpc('be_delete_reference', { p_user_id: user.id, p_reference_id: id });
  await remove(path).catch((e) => console.error('left a file behind:', path, e.message));
  return { ok: true };
});
