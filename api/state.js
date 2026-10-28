// Everything the app shows: the running session (if any), the latest result, check-in spots and their photos.
import { route } from '../lib/http.js';
import { db, must, requireUser, rpc } from '../lib/db.js';
import { signedUrls } from '../lib/photos.js';
import { timing } from '../lib/config.js';

export default route(['GET'], async (req) => {
  const user = await requireUser(req);
  // So an overdue session shows up as failed right away, without waiting for the minute cron.
  await rpc('be_finalize_sessions');

  const [spots, references, sessions] = await Promise.all([
    db().from('spots').select('id, name, created_at').eq('user_id', user.id).order('created_at'),
    db().from('reference_photos').select('id, spot_id, storage_path, created_at').eq('user_id', user.id).order('created_at'),
    db().from('sessions').select('*').eq('user_id', user.id).order('started_at', { ascending: false }).limit(10),
  ]).then(([p, r, s]) => [must(p, 'spots'), must(r, 'references'), must(s, 'sessions')]);

  const latest = sessions[0] || null;
  const attempts = latest
    ? must(
        await db().from('photo_attempts').select('id, spot_id, submitted_at, verdict, reason').eq('session_id', latest.id).order('submitted_at'),
        'attempts',
      )
    : [];
  const urls = await signedUrls(references.map((r) => r.storage_path));

  return {
    server_now: new Date().toISOString(),
    timing: timing(),
    email: user.email,
    spots: spots.map((p) => ({
      ...p,
      references: references
        .filter((r) => r.spot_id === p.id)
        .map((r) => ({ id: r.id, created_at: r.created_at, url: urls[r.storage_path] || null })),
    })),
    active: latest?.status === 'active' ? latest : null,
    latest,
    attempts,
    history: sessions,
  };
});
