// Past breaks for Settings → Recent → View more. /api/state only carries the latest few.
// GET ?range=month | 3months | all
import { HttpError, queryParam, route } from '../lib/http.js';
import { db, must, requireUser } from '../lib/db.js';

const MONTHS = { month: 1, '3months': 3, all: null };
// Two breaks a day for over a year. Only a guard against an endless list.
const MAX_ROWS = 1000;

export default route(['GET'], async (req) => {
  const user = await requireUser(req);
  const range = queryParam(req, 'range');
  if (!Object.hasOwn(MONTHS, range)) throw new HttpError(400, 'bad_request', 'Pick past month, past 3 months or all');
  let query = db().from('sessions').select('id, started_at, status, fail_reason')
    .eq('user_id', user.id).order('started_at', { ascending: false }).limit(MAX_ROWS);
  if (MONTHS[range]) {
    const since = new Date();
    since.setMonth(since.getMonth() - MONTHS[range]);
    query = query.gte('started_at', since.toISOString());
  }
  return { history: must(await query, 'history') };
});
