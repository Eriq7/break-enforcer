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
  if (!token) throw new HttpError(401, 'not_logged_in', '请先登录');
  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'not_logged_in', '登录过期了，请重新登录');
  return data.user;
}

// Errors the be_* functions raise on purpose, turned into messages for the app.
const RULE_ERRORS = {
  no_reference: [409, '先存至少一张 7 楼参考照，才能开始'],
  already_active: [409, '已经有一轮在进行了'],
  session_not_found: [404, '找不到这一轮'],
  session_closed: [409, '这一轮已经结束了'],
  too_late: [409, '已经过了截止时间，这一轮算失败'],
  retake_over: [409, '重拍时间已经过了'],
  locked_during_session: [409, '放松进行中，参考照锁住了，这一轮结束后才能改'],
  too_many_references: [409, '参考照最多 6 张，先删一张'],
  reference_not_found: [404, '找不到这张参考照'],
  attempt_not_pending: [409, '这张照片已经判过了'],
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
