// Everything the app shows: the running session (if any), the latest result and what it cost,
// the reference photos with their descriptions, the saved card.
import { route } from '../lib/http.js';
import { db, must, requireUser, rpc } from '../lib/db.js';
import { signedUrls } from '../lib/photos.js';
import { MAX_REFERENCES, timing } from '../lib/config.js';
import { payments } from '../lib/stripe.js';

export default route(['GET'], async (req) => {
  const user = await requireUser(req);
  // So an overdue session shows up as failed right away, without waiting for the minute cron.
  await rpc('be_finalize_sessions');
  const { mode } = payments();

  // Two chains side by side: photos then their links, and sessions then the latest one's attempts and charges.
  const photosChain = db().from('reference_photos').select('id, description, storage_path, created_at').eq('user_id', user.id).order('created_at')
    .then(async (r) => {
      const references = must(r, 'references');
      return { references, urls: await signedUrls(references.map((p) => p.storage_path)) };
    });
  const sessionsChain = db().from('sessions').select('*').eq('user_id', user.id).order('started_at', { ascending: false }).limit(10)
    .then(async (r) => {
      const sessions = must(r, 'sessions');
      const latest = sessions[0] || null;
      if (!latest) return { sessions, attempts: [], charges: [] };
      const [a, c] = await Promise.all([
        db().from('photo_attempts').select('id, reference_id, submitted_at, verdict, reason').eq('session_id', latest.id).order('submitted_at'),
        db().from('charges').select('kind, amount, currency, status, void_due_at, voided_at').eq('session_id', latest.id),
      ]);
      return { sessions, attempts: must(a, 'attempts'), charges: must(c, 'charges') };
    });
  const [{ references, urls }, { sessions, attempts, charges }, telegram, cards] = await Promise.all([
    photosChain,
    sessionsChain,
    db().from('telegram_links').select('user_id').eq('user_id', user.id).then((t) => must(t, 'telegram')),
    db().from('cards').select('payment_method_id, brand, last4, funding, exp_month, exp_year')
      .eq('user_id', user.id).eq('livemode', mode === 'live').then((c) => must(c, 'cards')),
  ]);

  const latest = sessions[0] || null;
  const card = cards.find((c) => c.payment_method_id) || null;

  return {
    server_now: new Date().toISOString(),
    timing: timing(),
    email: user.email,
    references: references.map((r) => ({
      id: r.id,
      description: r.description || 'Check-in photo',
      created_at: r.created_at,
      url: urls[r.storage_path] || null,
    })),
    max_references: MAX_REFERENCES,
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
