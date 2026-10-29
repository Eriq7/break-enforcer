// The timing rules are the product: 45:25 to relax, 5:00 to get down to the 7th floor,
// so the first photo is due at 50:25.
const RELAX_SECONDS = 45 * 60 + 25;
const BUFFER_SECONDS = 5 * 60;
// After the first photo the clock is stopped. Retakes are allowed this long,
// so a wrong AI rejection can still be fixed. Kept short because any photo stops the clock:
// a shot of the couch at 50:20 buys this much time to get downstairs (Eric, 2026-10-28: 2:30).
const RETAKE_SECONDS = 2 * 60 + 30;

// TEST_RELAX_SECONDS / TEST_BUFFER_SECONDS shorten a session for local testing.
// Ignored on the production deployment, so a leftover setting can't weaken the real rules.
export function timing() {
  const testing = process.env.VERCEL_ENV !== 'production';
  const override = (name, fallback) => {
    const n = Number(process.env[name]);
    return testing && Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    relax: override('TEST_RELAX_SECONDS', RELAX_SECONDS),
    buffer: override('TEST_BUFFER_SECONDS', BUFFER_SECONDS),
    retake: RETAKE_SECONDS,
  };
}

// Most reference photos one person can keep (be_max_references in the database). Only the one
// picked at check-in goes to the AI.
export const MAX_REFERENCES = 12;
