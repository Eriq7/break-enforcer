// The timing rules are the product: 45:25 to relax, 5:00 to get down to the 7th floor,
// so the first photo is due at 50:25.
const RELAX_SECONDS = 45 * 60 + 25;
const BUFFER_SECONDS = 5 * 60;
// After the first photo the clock is stopped. Retakes are allowed this long,
// so a wrong AI rejection can still be fixed.
const RETAKE_SECONDS = 5 * 60;

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

// Most reference photos one person can keep. Every one of them goes to the AI with each check-in.
export const MAX_REFERENCES = 6;
