// Stripe for the server. STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY must be the same mode:
// sk_test_ / pk_test_ while trying it out with Stripe's test cards, sk_live_ / pk_live_ for real.
// The mode is recorded on every break, so a failure is charged in the mode it started in.
import Stripe from 'stripe';
import { HttpError, env } from './http.js';

let cached;

export function payments() {
  if (!cached) {
    const secret = env('STRIPE_SECRET_KEY');
    const publishableKey = env('STRIPE_PUBLISHABLE_KEY');
    const mode = keyMode(secret, 'sk');
    if (!mode || keyMode(publishableKey, 'pk') !== mode) {
      throw new HttpError(500, 'stripe_keys', "The server's Stripe keys don't match. Both must be test keys or both live keys.");
    }
    cached = { stripe: new Stripe(secret, { maxNetworkRetries: 2 }), mode, publishableKey };
  }
  return cached;
}

// 'test', 'live', or null for something that isn't a Stripe key of that kind.
export function keyMode(key, kind) {
  if (key.startsWith(kind + '_live_')) return 'live';
  if (key.startsWith(kind + '_test_')) return 'test';
  return null;
}
