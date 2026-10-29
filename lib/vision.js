// Asks an OpenAI vision model whether a check-in photo shows the same scene as the reference
// photo the user picked. What kills this tool is a wrong rejection, not cheating:
// Eric walked down three floors and still got fined. So the prompt leans towards passing
// whenever it is plausibly the same place.
import { HttpError, env } from './http.js';

const DEFAULT_MODEL = 'gpt-6.1-sol';
const TIMEOUT_MS = 50_000;

// Prompt shape follows published work on matching places with vision models: judge only fixed
// landmarks, list the evidence before the scores (fields are generated in schema order), keep
// scores on a 0-2 scale, and let the code, not the model, make the final call.
const SYSTEM = `You check photos for a self-discipline app. To end a relax session on time, the user must walk to a fixed spot, usually in the building they live in, and photograph the same scene, from roughly the same viewpoint, as the REFERENCE photo(s). Their home is often in the same building, so it can have similar windows, blinds, walls and flooring. Decide whether the CANDIDATE photo was taken at the reference spot.

Work only from permanent, fixed things: built-in furniture, fixtures, artwork, signs and text, doors and windows, and how they are arranged relative to each other. Ignore people, pets, lighting (day vs night, lamps on or off), the weather outside, and small movable objects such as cups, papers, bags and chairs.

Fill the fields in this order:
- occlusion: how much of the CANDIDATE is blocked or unusable (a hand or finger over the lens, the camera pressed against something, black, extreme blur): none, minor or major.
- matched_landmarks: distinctive fixed features you can actually see in both the CANDIDATE and a REFERENCE, each specific enough to identify this place ("red elephant picture above the bookcase", not "a window"). Do not guess or list things you cannot see.
- mismatched_features: fixed features in the CANDIDATE that contradict the REFERENCE (a different window layout, furniture that is not there, a different wall colour).
- generic_only_match: true if the only things in common are generic ones found in many rooms of a building: white blinds, plain walls, ceilings, standard windows, carpet.
- place_score: 2 = clearly the same place, 1 = unsure, 0 = a different place.
- viewpoint_score: 2 = same direction and similar framing as a REFERENCE; 1 = same direction with a small shift, zoom or tilt; 0 = pointing in a clearly different direction, so the main part of the reference scene is missing or pushed off to the side.
- screen_or_print: the CANDIDATE looks like a photo of a screen or of a printed photo (moire, pixel grid, bezel, screen-shaped glare, paper border).
- reason: one or two short sentences in plain English for the user. If anything is wrong, say exactly how to fix it: which landmarks to get in the frame, which way to turn.

Be strict about the place and the viewpoint, but not about pixels: different lighting, a small step to the side and a bit of zoom are normal. The user can retake right away at no cost, so when the CANDIDATE is blocked, unclear or pointing the wrong way, reject it and tell them how to fix it.`;

const SCHEMA = {
  type: 'object',
  properties: {
    occlusion: { type: 'string', enum: ['none', 'minor', 'major'] },
    matched_landmarks: { type: 'array', items: { type: 'string' } },
    mismatched_features: { type: 'array', items: { type: 'string' } },
    generic_only_match: { type: 'boolean' },
    place_score: { type: 'integer', enum: [0, 1, 2] },
    viewpoint_score: { type: 'integer', enum: [0, 1, 2] },
    screen_or_print: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: [
    'occlusion',
    'matched_landmarks',
    'mismatched_features',
    'generic_only_match',
    'place_score',
    'viewpoint_score',
    'screen_or_print',
    'reason',
  ],
  additionalProperties: false,
};

// A pass needs real evidence: at least this many specific landmarks seen in both photos.
// 3 was too tight: a clear photo of the same desk listed exactly 3, one short of a wrong fine.
const MIN_LANDMARKS = 2;

// The decision is made here, from the model's observations, so the rule is visible and testable.
export function decide(v) {
  return (
    v.occlusion !== 'major' &&
    v.place_score === 2 &&
    v.viewpoint_score >= 1 &&
    v.matched_landmarks.length >= MIN_LANDMARKS &&
    !v.generic_only_match &&
    !v.screen_or_print
  );
}

export function buildRequest(references, photo, model) {
  const image = (bytes) => ({
    type: 'image_url',
    image_url: { url: 'data:image/jpeg;base64,' + bytes.toString('base64'), detail: 'high' },
  });
  const content = [];
  references.forEach((bytes, i) => {
    content.push({ type: 'text', text: `REFERENCE ${i + 1} of ${references.length}:` });
    content.push(image(bytes));
  });
  content.push({ type: 'text', text: 'CANDIDATE (the new check-in photo, taken just now):' });
  content.push(image(photo));
  return {
    model,
    // Reasoning models spend part of this budget thinking before they answer.
    max_completion_tokens: 4000,
    response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: SCHEMA } },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content },
    ],
  };
}

export function readVerdict(response) {
  const message = response?.choices?.[0]?.message;
  if (message?.refusal) throw new Error('AI refused: ' + message.refusal);
  let v;
  try {
    v = JSON.parse(message?.content || '');
  } catch {
    throw new Error('AI answer is not JSON');
  }
  const valid =
    v &&
    ['none', 'minor', 'major'].includes(v.occlusion) &&
    Array.isArray(v.matched_landmarks) &&
    Array.isArray(v.mismatched_features) &&
    typeof v.generic_only_match === 'boolean' &&
    [0, 1, 2].includes(v.place_score) &&
    [0, 1, 2].includes(v.viewpoint_score) &&
    typeof v.screen_or_print === 'boolean';
  if (!valid) throw new Error('AI answer has no usable verdict');
  return {
    verdict: decide(v) ? 'pass' : 'fail',
    reason: String(v.reason || '').slice(0, 300),
    raw: v,
  };
}

// references and photo are JPEG Buffers. Returns { verdict: 'pass' | 'fail', reason, model, raw }.
export async function compare(references, photo, { fetchImpl = fetch } = {}) {
  if (references.length === 0) throw new HttpError(409, 'no_reference', 'No check-in photo to compare with');
  const key = env('OPENAI_API_KEY');
  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify(buildRequest(references, photo, model)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body?.error?.code;
    if (res.status === 401) throw new HttpError(500, 'ai_key_invalid', 'The AI key was rejected. Check OPENAI_API_KEY.');
    if (code === 'insufficient_quota') throw new HttpError(500, 'ai_no_credit', 'The OpenAI API account is out of credit. Top it up at platform.openai.com.');
    if (code === 'model_not_found') throw new HttpError(500, 'ai_model_missing', `This key can't use the model ${model}. Change AI_MODEL.`);
    throw new Error(`OpenAI API: ${body?.error?.message || 'HTTP ' + res.status}`);
  }
  return { ...readVerdict(body), model: body.model || model };
}
