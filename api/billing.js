// Charges failed breaks and voids holds that are due. pg_cron pokes this every minute while there
// is work (be_kick_billing). It needs no login or secret: it only does work that is already due,
// and claims plus idempotency keys make a second caller harmless.
import { route } from '../lib/http.js';
import { db, must, rpc } from '../lib/db.js';
import { payments } from '../lib/stripe.js';
import { CURRENCY, MAX_TRIES, chargeBreak, giveUp, releaseHold } from '../lib/billing.js';

export default route(['POST'], async () => {
  const { stripe, mode } = payments();
  let charged = 0;
  let voided = 0;

  const tasks = await rpc('be_claim_billing');
  const stored = tasks.length
    ? must(await db().from('charges').select('*').in('session_id', tasks.map((t) => t.session_id)), 'charges')
    : [];
  for (const task of tasks) {
    const mine = stored.filter((c) => c.session_id === task.session_id);
    task.charges = { hold: mine.find((c) => c.kind === 'hold'), fee: mine.find((c) => c.kind === 'fee') };
    const deps = {
      stripe,
      mode,
      record: (kind, f) =>
        rpc('be_record_charge', {
          p_session_id: task.session_id,
          p_kind: kind,
          p_amount: f.amount,
          p_currency: CURRENCY,
          p_payment_intent_id: f.payment_intent_id,
          p_status: f.status,
          p_decline_code: f.decline_code || null,
          p_capture_before: f.capture_before?.toISOString() || null,
          p_void_due_at: f.void_due_at?.toISOString() || null,
        }),
      finish: (status, note) => rpc('be_finish_billing', { p_session_id: task.session_id, p_status: status, p_note: note }),
    };
    try {
      await chargeBreak(deps, task);
      charged++;
    } catch (e) {
      console.error(`billing ${task.session_id} try ${task.billing_tries}:`, e.message);
      if (task.billing_tries >= MAX_TRIES) await giveUp(deps, task).catch((g) => console.error('give up failed:', g.message));
    }
  }

  for (const v of await rpc('be_due_voids')) {
    if (v.livemode !== (mode === 'live')) {
      // A test mode hold holds no real money, so a live server can simply close it. A live hold
      // needs the live key: it waits, loudly, until the server is back on live keys.
      if (!v.livemode) await rpc('be_mark_voided', { p_charge_id: v.charge_id });
      else console.error(`live hold ${v.payment_intent_id} is due but the server has test keys`);
      continue;
    }
    try {
      await releaseHold(stripe, v.payment_intent_id);
      await rpc('be_mark_voided', { p_charge_id: v.charge_id });
      voided++;
    } catch (e) {
      console.error(`void ${v.payment_intent_id}:`, e.message);
    }
  }

  return { charged, voided };
});
