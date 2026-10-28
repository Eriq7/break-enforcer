import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEE_CENTS, HOLD_CENTS, chargeBreak, declinedNote, giveUp, releaseHold, voidDueAt } from '../lib/billing.js';

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-10-28T20:00:00Z');

function cardError(code, decline_code, pi = 'pi_declined') {
  return Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code, decline_code, payment_intent: { id: pi } });
}

// A Stripe stand-in: `outcomes` says what each kind of PaymentIntent does. Records every call.
function fakeStripe(outcomes = {}) {
  const calls = [];
  const stripe = {
    calls,
    paymentIntents: {
      async create(params, opts) {
        const kind = params.metadata.kind;
        calls.push({ op: 'create', kind, params, opts });
        const out = outcomes[kind];
        if (out instanceof Error) throw out;
        if (out === 'declined') throw cardError('card_declined', 'insufficient_funds');
        const pi = { id: `pi_${kind}`, created: T0 / 1000, status: kind === 'hold' ? 'requires_capture' : 'succeeded' };
        if (kind === 'hold') {
          pi.latest_charge = { payment_method_details: { card: { capture_before: (T0 + (4 * 24 + 18) * HOUR) / 1000 } } };
        }
        return pi;
      },
      async cancel(id) {
        calls.push({ op: 'cancel', id });
        if (outcomes.cancel instanceof Error) throw outcomes.cancel;
        return { id, status: 'canceled' };
      },
      async retrieve(id) {
        calls.push({ op: 'retrieve', id });
        return { id, status: outcomes.retrieved || 'canceled' };
      },
    },
  };
  return stripe;
}

function harness(outcomes, taskOverrides = {}) {
  const stripe = fakeStripe(outcomes);
  const rows = {};
  const finished = [];
  const deps = {
    stripe,
    mode: 'test',
    record: async (kind, f) => (rows[kind] = { kind, ...f }),
    finish: async (status, note) => finished.push({ status, note }),
  };
  const task = {
    session_id: 'sess-1',
    user_id: 'user-1',
    billing_mode: 'test',
    billing_tries: 1,
    customer_id: 'cus_1',
    payment_method_id: 'pm_1',
    charges: {},
    ...taskOverrides,
  };
  return { stripe, rows, finished, deps, task };
}

test('the hold is voided an hour before capture_before, or at 120 hours if that comes first', () => {
  const shortWindow = T0 + (4 * 24 + 18) * HOUR;
  assert.equal(voidDueAt(T0, shortWindow).getTime(), shortWindow - HOUR);
  assert.equal(voidDueAt(T0, T0 + 7 * 24 * HOUR).getTime(), T0 + 120 * HOUR);
  // No capture_before at all: 96 hours, inside the shortest window seen.
  assert.equal(voidDueAt(T0, null).getTime(), T0 + 96 * HOUR);
});

test('a failed break: the hold first, then the fee, both off-session with idempotency keys', async () => {
  const h = harness({});
  await chargeBreak(h.deps, h.task);
  const [hold, fee] = h.stripe.calls;
  assert.equal(hold.kind, 'hold');
  assert.deepEqual(
    [hold.params.amount, hold.params.capture_method, hold.params.off_session, hold.params.confirm, hold.opts.idempotencyKey],
    [HOLD_CENTS, 'manual', true, true, 'be-hold-sess-1'],
  );
  assert.deepEqual([fee.kind, fee.params.amount, fee.params.capture_method, fee.opts.idempotencyKey], ['fee', FEE_CENTS, 'automatic', 'be-fee-sess-1']);
  assert.equal(h.rows.hold.status, 'held');
  assert.equal(h.rows.hold.void_due_at.getTime(), T0 + (4 * 24 + 17) * HOUR);
  assert.equal(h.rows.fee.status, 'paid');
  assert.deepEqual(h.finished, [{ status: 'charged', note: null }]);
});

test('hold declined: no fee, nothing charged, and the user is told why', async () => {
  const h = harness({ hold: 'declined' });
  await chargeBreak(h.deps, h.task);
  assert.equal(h.stripe.calls.length, 1);
  assert.deepEqual([h.rows.hold.status, h.rows.hold.decline_code, h.rows.hold.payment_intent_id], ['declined', 'insufficient_funds', 'pi_declined']);
  assert.deepEqual(h.finished, [{ status: 'declined', note: 'Your card was declined (not enough money in the account), so nothing was charged this time.' }]);
});

test('fee declined after the hold went through: the hold is released at once', async () => {
  const h = harness({ fee: cardError('card_declined', 'generic_decline') });
  await chargeBreak(h.deps, h.task);
  assert.deepEqual(h.stripe.calls.map((c) => c.op + (c.kind ? ':' + c.kind : '')), ['create:hold', 'create:fee', 'cancel']);
  assert.equal(h.rows.hold.status, 'voided');
  assert.equal(h.rows.fee.status, 'declined');
  assert.equal(h.finished[0].status, 'declined');
});

test('a bank that wants the cardholder present counts as a decline', async () => {
  const h = harness({ hold: cardError('authentication_required', undefined) });
  await chargeBreak(h.deps, h.task);
  assert.equal(h.finished[0].status, 'declined');
  assert.match(h.finished[0].note, /approve each payment yourself/);
});

test('no answer from Stripe: it throws, so the break is tried again later', async () => {
  const h = harness({ fee: Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }) });
  await assert.rejects(chargeBreak(h.deps, h.task), /socket hang up/);
  assert.equal(h.finished.length, 0);
  // The hold placed on this run is visible to giveUp().
  assert.equal(h.task.charges.hold.status, 'held');
});

test('a break cut off after the hold picks up with the fee only', async () => {
  const h = harness({}, { charges: { hold: { kind: 'hold', status: 'held', amount: HOLD_CENTS, payment_intent_id: 'pi_hold' } } });
  await chargeBreak(h.deps, h.task);
  assert.deepEqual(h.stripe.calls.map((c) => c.kind), ['fee']);
  assert.equal(h.finished[0].status, 'charged');
});

test('a break stored as declined, but cut off before it was closed, is closed without new charges', async () => {
  const h = harness({}, { charges: { hold: { kind: 'hold', status: 'declined', decline_code: 'expired_card' } } });
  await chargeBreak(h.deps, h.task);
  assert.equal(h.stripe.calls.length, 0);
  assert.equal(h.finished[0].note, declinedNote('expired_card'));
});

test('a break from the other Stripe mode, or with no card, is not charged', async () => {
  const live = harness({}, { billing_mode: 'live' });
  await chargeBreak(live.deps, live.task);
  assert.equal(live.stripe.calls.length, 0);
  assert.equal(live.finished[0].status, 'error');

  const noCard = harness({}, { payment_method_id: null });
  await chargeBreak(noCard.deps, noCard.task);
  assert.equal(noCard.stripe.calls.length, 0);
  assert.equal(noCard.finished[0].status, 'error');
});

test('giving up releases a hold whose fee never went through', async () => {
  const h = harness({}, { charges: { hold: { kind: 'hold', status: 'held', amount: HOLD_CENTS, payment_intent_id: 'pi_hold' } } });
  await giveUp(h.deps, h.task);
  assert.deepEqual(h.stripe.calls.map((c) => c.op), ['cancel']);
  assert.equal(h.rows.hold.status, 'voided');
  assert.equal(h.finished[0].status, 'error');

  const both = harness({}, {
    charges: {
      hold: { kind: 'hold', status: 'held', amount: HOLD_CENTS, payment_intent_id: 'pi_hold' },
      fee: { kind: 'fee', status: 'paid' },
    },
  });
  await giveUp(both.deps, both.task);
  assert.equal(both.stripe.calls.length, 0);
  assert.equal(both.finished[0].status, 'charged');
});

test('releasing a hold Stripe already canceled counts as released; other errors do not', async () => {
  const gone = fakeStripe({ cancel: Object.assign(new Error('already canceled'), { code: 'payment_intent_unexpected_state' }) });
  await releaseHold(gone, 'pi_hold');
  assert.deepEqual(gone.calls.map((c) => c.op), ['cancel', 'retrieve']);

  const captured = fakeStripe({ cancel: Object.assign(new Error('captured'), { code: 'payment_intent_unexpected_state' }), retrieved: 'succeeded' });
  await assert.rejects(releaseHold(captured, 'pi_hold'), /captured/);

  const down = fakeStripe({ cancel: new Error('timeout') });
  await assert.rejects(releaseHold(down, 'pi_hold'), /timeout/);
});
