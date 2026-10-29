// A check-in photo from the in-app camera. There is no upload-from-album path to this endpoint
// in the app; the photo arrives as a frame grabbed from the live camera.
import { HttpError, route } from '../lib/http.js';
import { db, must, requireUser, rpc } from '../lib/db.js';
import { attemptPath, decodeJpeg, download, upload } from '../lib/photos.js';
import { compare } from '../lib/vision.js';
import { timing } from '../lib/config.js';
import { isUuid } from '../lib/ids.js';

export default route(['POST'], async (req) => {
  const user = await requireUser(req);
  const { session_id: sessionId, reference_id: referenceId, image } = req.body || {};
  if (!isUuid(sessionId)) throw new HttpError(400, 'bad_request', 'Missing break id');
  if (!isUuid(referenceId)) throw new HttpError(400, 'bad_request', 'Pick the photo of where you are');
  const photo = decodeJpeg(image);
  const path = attemptPath(user.id, sessionId);

  // Recording the attempt first is what stops the clock, before the slow upload and AI call.
  const attempt = await rpc('be_record_checkin', {
    p_user_id: user.id,
    p_session_id: sessionId,
    p_reference_id: referenceId,
    p_storage_path: path,
    p_retake_seconds: timing().retake,
  });

  let result;
  try {
    await upload(path, photo);
    result = await compare([await loadReference(referenceId)], photo);
  } catch (e) {
    console.error('photo check failed:', e.message);
    result = {
      verdict: 'error',
      reason: e instanceof HttpError ? e.message : "The AI check failed. Retake the photo. If it keeps failing, this break won't count against you.",
      model: null,
      raw: null,
    };
  }

  const session = await rpc('be_record_verdict', {
    p_attempt_id: attempt.id,
    p_verdict: result.verdict,
    p_reason: result.reason,
    p_model: result.model,
    p_result: result.raw,
  });
  return { verdict: result.verdict, reason: result.reason, session, server_now: new Date().toISOString() };
});

// Only the photo the user picked. be_record_checkin has already checked it is this user's.
async function loadReference(referenceId) {
  const row = must(await db().from('reference_photos').select('storage_path').eq('id', referenceId).single(), 'reference');
  return download(row.storage_path);
}
