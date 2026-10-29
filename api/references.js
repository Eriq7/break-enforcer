// Reference photos, each with a short description of where it is.
// POST { image, description }: add one. Refused while a session runs.
// PATCH { id, description }: change the description. Allowed any time; the AI never sees it.
// DELETE ?id=: delete one. Refused while a session runs.
import { HttpError, queryParam, route } from '../lib/http.js';
import { db, requireUser, rpc } from '../lib/db.js';
import { decodeJpeg, referencePath, remove, upload } from '../lib/photos.js';
import { isUuid } from '../lib/ids.js';

export default route(['POST', 'PATCH', 'DELETE'], async (req) => {
  const user = await requireUser(req);

  if (req.method === 'POST') {
    const description = readDescription(req.body);
    const photo = decodeJpeg(req.body?.image);
    const path = referencePath(user.id);
    // The row goes in first: that is where the session lock and the photo limit are checked.
    const ref = await rpc('be_add_reference_photo', { p_user_id: user.id, p_storage_path: path, p_description: description });
    try {
      await upload(path, photo);
    } catch (e) {
      await db().from('reference_photos').delete().eq('id', ref.id);
      throw e;
    }
    return { id: ref.id };
  }

  if (req.method === 'PATCH') {
    const id = req.body?.id;
    if (!isUuid(id)) throw new HttpError(400, 'bad_request', 'Missing photo id');
    const ref = await rpc('be_describe_reference', { p_user_id: user.id, p_reference_id: id, p_description: readDescription(req.body) });
    return { id: ref.id, description: ref.description };
  }

  const id = queryParam(req, 'id');
  if (!isUuid(id)) throw new HttpError(400, 'bad_request', 'Missing photo id');
  const path = await rpc('be_delete_reference', { p_user_id: user.id, p_reference_id: id });
  await remove(path).catch((e) => console.error('left a file behind:', path, e.message));
  return { ok: true };
});

function readDescription(body) {
  const text = typeof body?.description === 'string' ? body.description.trim() : '';
  if (!text) throw new HttpError(400, 'bad_description', 'Say where this is, like "7th floor room"');
  if (text.length > 60) throw new HttpError(400, 'bad_description', 'Keep it under 60 characters');
  return text;
}
