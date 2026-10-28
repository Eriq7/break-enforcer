// Charging a failed break, and releasing its hold later. /api/billing runs this when pg_cron
// pokes it (be_kick_billing).
//
// A failed break gets two separate PaymentIntents on the saved card, both off-session:
//   hold  $43.00, manual capture, never captured, voided before Stripe's capture_before
//   fee    $2.25, charged right away, not refunded
// Two PaymentIntents, not one capture plus a refund: a refund takes 5 to 10 business days and
// Stripe keeps its fee. The hold goes first. If the bank refuses either one, nothing is charged
// this time and nothing is owed later, so a hold already placed is voided at once (Eric, 2026-10-28).
// Each PaymentIntent's idempotency key comes from the break, so a retry or a second caller gets
// the same PaymentIntent back instead of a second charge.

export const HOLD_CENTS = 4300;
export const FEE_CENTS = 225;
export const CURRENCY = 'cad';
// The statement shows BREAK* 45:25 MISS.
const DESCRIPTOR_SUFFIX = '45:25 MISS';
// The hold is voided 120 hours in, or an hour before Stripe's capture_before if that comes first.
// Stripe gives a Visa merchant-initiated hold only 4 days 18 hours (experiment 2, 2026-10-25).
const HOLD_HOURS = 120;
const VOID_MARGIN_HOURS = 1;
// No capture_before on the charge: stay inside the shortest window seen so far.
const FALLBACK_HOURS = 96;
// Runs without an answer from Stripe before a break is given up on. A claim lasts 2 minutes,
// so this is about 20 minutes.
export const MAX_TRIES = 10;

const HOUR = 3600 * 1000;

export function voidDueAt(createdMs, captureBeforeMs) {
  const latest = captureBeforeMs ? captureBeforeMs - VOID_MARGIN_HOURS * HOUR : createdMs + FALLBACK_HOURS * HOUR;
  return new Date(Math.min(createdMs + HOLD_HOURS * HOUR, latest));
}

// What the app says when the bank refused.
const DECLINE_REASONS = {
  insufficient_funds: 'not enough money in the account',
  expired_card: 'the card has expired',
  authentication_required: 'your bank wants you to approve each payment yourself',
  incorrect_cvc: 'the card details are out of date',
  card_velocity_exceeded: 'the card hit its spending limit',
  withdrawal_count_limit_exceeded: 'the card hit its spending limit',
};

export function declinedNote(code) {
  const reason = DECLINE_REASONS[code] || 'the bank declined it';
  return `Your card was declined (${reason}), so nothing was charged this time.`;
}

// One PaymentIntent. Returns what to store; a refusal from the bank is a result, not an error.
// Anything else (network, Stripe outage) throws, and the break is tried again later.
async function createIntent(stripe, task, kind) {
  const hold = kind === 'hold';
  const amount = hold ? HOLD_CENTS : FEE_CENTS;
  const params = {
    amount,
    currency: CURRENCY,
    customer: task.customer_id,
    payment_method: task.payment_method_id,
    payment_method_types: ['card'],
    capture_method: hold ? 'manual' : 'automatic',
    confirm: true,
    off_session: true,
    description: hold ? 'Missed break: hold, released within 5 days' : 'Missed break: service fee',
    statement_descriptor_suffix: DESCRIPTOR_SUFFIX,
    metadata: { session_id: task.session_id, user_id: task.user_id, kind },
  };
  if (hold) params.expand = ['latest_charge'];
  let pi;
  try {
    pi = await stripe.paymentIntents.create(params, { idempotencyKey: `be-${kind}-${task.session_id}` });
  } catch (e) {
    if (e.type !== 'StripeCardError') throw e;
    return { amount, payment_intent_id: e.payment_intent?.id || null, status: 'declined', decline_code: e.decline_code || e.code || null };
  }
  if (pi.status !== (hold ? 'requires_capture' : 'succeeded')) {
    return { amount, payment_intent_id: pi.id, status: 'declined', decline_code: pi.status };
  }
  if (!hold) return { amount, payment_intent_id: pi.id, status: 'paid' };
  const seconds = pi.latest_charge?.payment_method_details?.card?.capture_before;
  const captureBefore = seconds ? new Date(seconds * 1000) : null;
  return {
    amount,
    payment_intent_id: pi.id,
    status: 'held',
    capture_before: captureBefore,
    void_due_at: voidDueAt(pi.created * 1000, captureBefore?.getTime()),
  };
}

// Releases a hold. One that Stripe already shows as canceled counts as released.
export async function releaseHold(stripe, paymentIntentId) {
  try {
    await stripe.paymentIntents.cancel(paymentIntentId, { cancellation_reason: 'abandoned' });
  } catch (e) {
    const pi = e.code === 'payment_intent_unexpected_state' ? await stripe.paymentIntents.retrieve(paymentIntentId) : null;
    if (pi?.status !== 'canceled') throw e;
  }
}

// Charges one claimed break. `task` is a row from be_claim_billing plus `charges`, the rows
// already stored for it ({ hold, fee }), so a break that was cut off halfway picks up where it was.
// `record(kind, fields)` stores a charge and returns the row, `finish(status, note)` ends billing
// for the break. task.charges is kept current, so giveUp() sees what this run already did.
export async function chargeBreak({ stripe, mode, record, finish }, task) {
  if (task.billing_mode !== mode) {
    return finish('error', 'Payment settings changed after this break started, so nothing was charged.');
  }
  if (!task.payment_method_id) {
    return finish('error', 'There was no saved card, so nothing was charged.');
  }

  const { charges } = task;
  if (!charges.hold) charges.hold = await record('hold', await createIntent(stripe, task, 'hold'));
  if (charges.hold.status === 'declined') return finish('declined', declinedNote(charges.hold.decline_code));

  if (!charges.fee) charges.fee = await record('fee', await createIntent(stripe, task, 'fee'));
  if (charges.fee.status === 'declined') {
    charges.hold = await undoHold({ stripe, record }, charges.hold);
    return finish('declined', declinedNote(charges.fee.decline_code));
  }
  return finish('charged', null);
}

// Stripe didn't answer in time on too many runs: give up so the break doesn't hang forever.
// All or nothing, so a hold that did go through is released.
export async function giveUp({ stripe, record, finish }, task) {
  const { hold, fee } = task.charges;
  if (hold?.status === 'held' && fee?.status === 'paid') return finish('charged', null);
  if (hold?.status === 'held') await undoHold({ stripe, record }, hold);
  return finish('error', "Couldn't reach the card processor, so nothing was charged.");
}

async function undoHold({ stripe, record }, hold) {
  if (hold.status !== 'held') return hold;
  await releaseHold(stripe, hold.payment_intent_id);
  return record('hold', { amount: hold.amount, payment_intent_id: hold.payment_intent_id, status: 'voided' });
}
