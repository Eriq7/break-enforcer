// A practice check-in. The photo goes through the same AI check as a real one (compare() in
// lib/vision.js, the same camera and overlay in the app), against one of the user's photos, but
// it is not tied to a break: nothing is saved, no clock runs and the card is never touched.
// It lets a user try a new photo before a break and real money depend on it.
// POST { reference_id, image } → { verdict: 'pass' | 'fail', clear, points }
import { HttpError, route } from '../lib/http.js';
import { db, must, requireUser } from '../lib/db.js';
import { decodeJpeg, download } from '../lib/photos.js';
import { compare } from '../lib/vision.js';
import { isUuid } from '../lib/ids.js';

export default route(['POST'], async (req) => {
  const user = await requireUser(req);
  const { reference_id: referenceId, image } = req.body || {};
  if (!isUuid(referenceId)) throw new HttpError(400, 'bad_request', 'Pick the photo to test');
  const photo = decodeJpeg(image);
  const row = must(
    await db().from('reference_photos').select('storage_path').eq('id', referenceId).eq('user_id', user.id).maybeSingle(),
    'reference',
  );
  if (!row) throw new HttpError(404, 'reference_not_found', 'Photo not found. It may have been deleted.');

  let result;
  try {
    result = await compare([await download(row.storage_path)], photo);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error('test check failed:', e.message);
    throw new HttpError(502, 'ai_failed', "The AI couldn't check this photo. Try again.");
  }
  return { verdict: result.verdict, clear: result.clear, points: result.points };
});
