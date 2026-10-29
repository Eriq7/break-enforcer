// Server-side Supabase access. Uses the secret key, which bypasses row level security,
// so it must never reach the browser. The browser only ever gets the publishable key.
import { createClient } from '@supabase/supabase-js';
import { HttpError, env } from './http.js';

let client;

export function db() {
  if (!client) {
    client = createClient(env('SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// The logged-in user, from the access token the app sends as `Authorization: Bearer ...`.
export async function requireUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'not_logged_in', 'Please log in first');
  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'not_logged_in', 'Your login expired. Please log in again.');
  return data.user;
}

// Errors the be_* functions raise on purpose, turned into messages for the app.
const RULE_ERRORS = {
  no_reference: [409, 'Add a check-in photo in Settings before you start'],
  already_active: [409, 'A break is already running'],
  session_not_found: [404, 'Break not found'],
  session_closed: [409, 'This break has already ended'],
  too_late: [409, 'Past the deadline. This break counts as failed.'],
  retake_over: [409, 'Retake time is over'],
  locked_during_session: [409, "You can't add or delete check-in photos during a break. Change them after it ends."],
  too_many_references: [409, 'You can keep up to 12 check-in photos. Delete one first.'],
  bad_description: [400, 'Say where this is, in up to 60 characters'],
  reference_not_found: [404, 'Photo not found. It may have been deleted.'],
  attempt_not_pending: [409, 'This photo has already been checked'],
  telegram_not_set_up: [503, "Telegram reminders aren't set up on the server yet"],
  no_card: [409, 'Add a card in Settings before you start'],
  card_locked: [409, "You can't change your card during a break, or while a missed one is being charged."],
  card_not_found: [404, 'Card not found. Try adding it again.'],
};

export async function rpc(name, args = {}) {
  const { data, error } = await db().rpc(name, args);
  if (error) {
    const known = RULE_ERRORS[error.message];
    if (known) throw new HttpError(known[0], error.message, known[1]);
    throw new Error(`${name}: ${error.message}`);
  }
  return data;
}

// supabase-js returns errors instead of throwing them.
export function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}
