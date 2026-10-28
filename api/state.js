// Everything the app shows: the running session (if any), the latest result and what it cost,
// check-in spots and their photos, the saved card.
import { route } from '../lib/http.js';
import { db, must, requireUser, rpc } from '../lib/db.js';
import { signedUrls } from '../lib/photos.js';
import { timing } from '../lib/config.js';
import { payments } from '../lib/stripe.js';

export default route(['GET'], async (req) => {
  const user = await requireUser(req);
  // So an overdue session shows up as failed right away, without waiting for the minute cron.
  await rpc('be_finalize_sessions');
  const { mode } = payments();

  const [spots, references, sessions, telegram, cards] = await Promise.all([
    db().from('spots').select('id, name, created_at').eq('user_id', user.id).order('created_at'),
    db().from('reference_photos').select('id, spot_id, storage_path, created_at').eq('user_id', user.id).order('created_at'),
    db().from('sessions').select('*').eq('user_id', user.id).order('started_at', { ascending: false }).limit(10),
    db().from('telegram_links').select('user_id').eq('user_id', user.id),
    db().from('cards').select('payment_method_id, brand, last4, funding, exp_month, exp_year')
      .eq('user_id', user.id).eq('livemode', mode === 'live'),
  ]).then(([p, r, s, t, c]) => [must(p, 'spots'), must(r, 'references'), must(s, 'sessions'), must(t, 'telegram'), must(c, 'cards')]);

  const latest = sessions[0] || null;
  const [attempts, charges] = latest
    ? await Promise.all([
        db().from('photo_attempts').select('id, spot_id, submitted_at, verdict, reason').eq('session_id', latest.id).order('submitted_at'),
        db().from('charges').select('kind, amount, currency, status, void_due_at, voided_at').eq('session_id', latest.id),
      ]).then(([a, c]) => [must(a, 'attempts'), must(c, 'charges')])
    : [[], []];
  const urls = await signedUrls(references.map((r) => r.storage_path));
  const card = cards.find((c) => c.payment_method_id) || null;

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
    telegram: telegram.length > 0,
    payments_mode: mode,
    card: card && { brand: card.brand, last4: card.last4, funding: card.funding, exp_month: card.exp_month, exp_year: card.exp_year },
    active: latest?.status === 'active' ? latest : null,
    latest,
    attempts,
    charges,
    history: sessions,
  };
});
