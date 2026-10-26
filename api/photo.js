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
  const { session_id: sessionId, image } = req.body || {};
  if (!isUuid(sessionId)) throw new HttpError(400, 'bad_request', '缺少这一轮的编号');
  const photo = decodeJpeg(image);
  const path = attemptPath(user.id, sessionId);

  // Recording the attempt first is what stops the clock, before the slow upload and AI call.
  const attempt = await rpc('be_record_photo', {
    p_user_id: user.id,
    p_session_id: sessionId,
    p_storage_path: path,
    p_retake_seconds: timing().retake,
  });

  let result;
  try {
    await upload(path, photo);
    result = await compare(await loadReferences(user.id), photo);
  } catch (e) {
    console.error('photo check failed:', e.message);
    result = {
      verdict: 'error',
      reason: e instanceof HttpError ? e.message : 'AI 判定出错了，直接重拍一张',
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

async function loadReferences(userId) {
  const rows = must(
    await db().from('reference_photos').select('storage_path').eq('user_id', userId).order('created_at'),
    'references',
  );
  return Promise.all(rows.map((r) => download(r.storage_path)));
}
