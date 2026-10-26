// Everything the app shows: the running session (if any), the latest result, reference photos.
import { route } from '../lib/http.js';
import { db, must, requireUser, rpc } from '../lib/db.js';
import { signedUrls } from '../lib/photos.js';
import { timing } from '../lib/config.js';

export default route(['GET'], async (req) => {
  const user = await requireUser(req);
  // So an overdue session shows up as failed right away, without waiting for the minute cron.
  await rpc('be_finalize_sessions');

  const [references, sessions] = await Promise.all([
    db().from('reference_photos').select('id, storage_path, created_at').eq('user_id', user.id).order('created_at'),
    db().from('sessions').select('*').eq('user_id', user.id).order('started_at', { ascending: false }).limit(10),
  ]).then(([r, s]) => [must(r, 'references'), must(s, 'sessions')]);

  const latest = sessions[0] || null;
  const attempts = latest
    ? must(
        await db().from('photo_attempts').select('id, submitted_at, verdict, reason').eq('session_id', latest.id).order('submitted_at'),
        'attempts',
      )
    : [];
  const urls = await signedUrls(references.map((r) => r.storage_path));

  return {
    server_now: new Date().toISOString(),
    timing: timing(),
    email: user.email,
    references: references.map((r) => ({ id: r.id, created_at: r.created_at, url: urls[r.storage_path] || null })),
    active: latest?.status === 'active' ? latest : null,
    latest,
    attempts,
    history: sessions,
  };
});
