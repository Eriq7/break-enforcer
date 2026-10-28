// The card a failed break is charged to. Saving one moves no money.
// POST: start adding a card. Returns a Stripe SetupIntent for charging later without the user
//       present, which the app hands to Stripe's card form.
// PUT { setup_intent_id }: the form went through; that card becomes the user's card.
import { HttpError, route } from '../lib/http.js';
import { db, must, requireUser, rpc } from '../lib/db.js';
import { payments } from '../lib/stripe.js';

export default route(['POST', 'PUT'], async (req) => {
  const user = await requireUser(req);
  const { stripe, mode, publishableKey } = payments();
  const livemode = mode === 'live';
  const row = must(
    await db().from('cards').select('customer_id').eq('user_id', user.id).eq('livemode', livemode).maybeSingle(),
    'card',
  );

  if (req.method === 'POST') {
    let customer = row?.customer_id;
    if (!customer) {
      const c = await stripe.customers.create(
        { email: user.email, metadata: { user_id: user.id } },
        { idempotencyKey: `be-customer-${user.id}` },
      );
      customer = await rpc('be_save_customer', { p_user_id: user.id, p_livemode: livemode, p_customer_id: c.id });
    }
    const si = await stripe.setupIntents.create({
      customer,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { user_id: user.id },
    });
    return { client_secret: si.client_secret, publishable_key: publishableKey, mode };
  }

  const id = typeof req.body?.setup_intent_id === 'string' ? req.body.setup_intent_id : '';
  if (!/^seti_\w+$/.test(id)) throw new HttpError(400, 'bad_request', 'Missing setup_intent_id');
  const si = await stripe.setupIntents.retrieve(id, { expand: ['payment_method'] });
  if (!row || si.customer !== row.customer_id) throw new HttpError(404, 'card_not_found', 'Card not found. Try adding it again.');
  if (si.status !== 'succeeded' || !si.payment_method?.card) {
    throw new HttpError(409, 'card_not_saved', "The card wasn't saved. Try again.");
  }
  const pm = si.payment_method;
  const old = await rpc('be_save_card', {
    p_user_id: user.id,
    p_livemode: livemode,
    p_customer_id: row.customer_id,
    p_payment_method_id: pm.id,
    p_brand: pm.card.brand,
    p_last4: pm.card.last4,
    p_funding: pm.card.funding,
    p_exp_month: pm.card.exp_month,
    p_exp_year: pm.card.exp_year,
  });
  if (old && old !== pm.id) {
    await stripe.paymentMethods.detach(old).catch((e) => console.error('old card left attached:', e.message));
  }
  return { ok: true };
});
