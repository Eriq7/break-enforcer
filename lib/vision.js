// Two jobs for an OpenAI vision model:
// - compare(): at check-in, does the new photo show the same thing as the reference photo the
//   user picked? That is the whole test. It is deliberately lenient: a wrong rejection costs
//   the user $45.25 for doing everything right, so "probably the same" passes.
// - checkReference(): when a reference photo is saved, is it so plain (one orange, a blank wall)
//   that a match could be faked from anywhere? Only a warning: the user can keep it anyway.
import { HttpError, env } from './http.js';

const DEFAULT_MODEL = 'gpt-6.1-sol';
const COMPARE_TIMEOUT_MS = 50_000;
// Saving a reference waits on this, and a failed check just saves without a warning.
const CHECK_TIMEOUT_MS = 25_000;

// Evidence comes before the score (fields are generated in schema order), and the code, not the
// model, makes the final call.
const COMPARE_SYSTEM = `You check photos for a self-discipline app. When a break ends, the user has to go to a spot they chose and photograph it again. The REFERENCE photo is what they photographed when they set that spot up. Decide whether the CANDIDATE photo, taken just now, shows the same thing as the REFERENCE.

That is the only question. Anything in the photo counts as evidence, including movable objects: if the REFERENCE is a laptop on a desk, the same laptop on the same desk is a match. Do not ask for landmarks, permanent fixtures or a distinctive scene: the user already chose this reference, and a plain one is their choice. Screens, monitors and TVs that are part of the scene are normal, whatever they show.

Be lenient. These differences are normal and must not lower the score: lighting (day or night, lamps on or off), what a screen is showing, a somewhat different angle, a step to the side, zoom or crop, tilt, blur or noise, small things added, removed or moved around, people or pets in the frame.

Fill the fields in this order:
- seen_in_both: the things you can see in both photos ("silver laptop", "light wood desk", "cream wall"). Only things you actually see.
- differences: things showing the CANDIDATE is a different thing or place (a different kind of object, a different colour or model, a clearly different room). Leave out the normal differences listed above.
- same_scene: 2 = clearly the same thing; 1 = probably the same, any differences are the normal kind; 0 = a different thing or place, or the CANDIDATE is so blocked, dark or blurry that its main subject cannot be seen.
- reason: one or two short sentences in plain English for the user. If same_scene is 0, say what to get in the frame.`;

const COMPARE_SCHEMA = {
  type: 'object',
  properties: {
    seen_in_both: { type: 'array', items: { type: 'string' } },
    differences: { type: 'array', items: { type: 'string' } },
    same_scene: { type: 'integer', enum: [0, 1, 2] },
    reason: { type: 'string' },
  },
  required: ['seen_in_both', 'differences', 'same_scene', 'reason'],
  additionalProperties: false,
};

const CHECK_SYSTEM = `You help set up a self-discipline app. The user is saving a REFERENCE photo of a spot they must walk to at the end of every break and photograph again; an AI then checks that the new photo shows the same thing. Decide whether this REFERENCE is too easy to fake: whether a matching photo could be taken without going to that spot.

Too easy (simple = true): the photo is mainly one small or common object that could be carried anywhere or found in many places (a piece of fruit, a cup, a phone, a laptop, a book), or a plain surface (a blank wall, ceiling, floor, sky, a dark or blurry frame).
Fine (simple = false): the photo shows a place with things that would be hard to find or recreate elsewhere: a room layout, artwork, signs or text, a particular door or window view, furniture with other things around it.

Fill the fields in this order:
- shows: a few words on what the photo shows.
- simple: true or false, as above.
- reason: if simple, one short sentence in plain English for the user saying why it is easy to fake and what would make it harder, for example "Step back so the doorway and the sign beside it are in the frame." If not simple, an empty string.`;

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    shows: { type: 'string' },
    simple: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['shows', 'simple', 'reason'],
  additionalProperties: false,
};

// The decision is made here, from the model's answer, so the rule is visible and testable.
export function decide(v) {
  return v.same_scene >= 1;
}

const image = (bytes) => ({
  type: 'image_url',
  image_url: { url: 'data:image/jpeg;base64,' + bytes.toString('base64'), detail: 'high' },
});

function request(model, system, schemaName, schema, content) {
  return {
    model,
    // Reasoning models spend part of this budget thinking before they answer.
    max_completion_tokens: 4000,
    response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  };
}

export function buildRequest(references, photo, model) {
  const content = [];
  references.forEach((bytes, i) => {
    content.push({ type: 'text', text: `REFERENCE ${i + 1} of ${references.length}:` });
    content.push(image(bytes));
  });
  content.push({ type: 'text', text: 'CANDIDATE (the new check-in photo, taken just now):' });
  content.push(image(photo));
  return request(model, COMPARE_SYSTEM, 'verdict', COMPARE_SCHEMA, content);
}

export function buildCheckRequest(photo, model) {
  return request(model, CHECK_SYSTEM, 'reference_check', CHECK_SCHEMA, [{ type: 'text', text: 'REFERENCE:' }, image(photo)]);
}

function readJson(response) {
  const message = response?.choices?.[0]?.message;
  if (message?.refusal) throw new Error('AI refused: ' + message.refusal);
  try {
    return JSON.parse(message?.content || '');
  } catch {
    throw new Error('AI answer is not JSON');
  }
}

export function readVerdict(response) {
  const v = readJson(response);
  const valid = v && Array.isArray(v.seen_in_both) && Array.isArray(v.differences) && [0, 1, 2].includes(v.same_scene);
  if (!valid) throw new Error('AI answer has no usable verdict');
  return {
    verdict: decide(v) ? 'pass' : 'fail',
    reason: String(v.reason || '').slice(0, 300),
    raw: v,
  };
}

export function readCheck(response) {
  const v = readJson(response);
  if (!v || typeof v.simple !== 'boolean') throw new Error('AI answer has no usable check');
  return { simple: v.simple, reason: String(v.reason || '').slice(0, 300), raw: v };
}

async function ask(body, timeoutMs, fetchImpl) {
  const key = env('OPENAI_API_KEY');
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const code = json?.error?.code;
    if (res.status === 401) throw new HttpError(500, 'ai_key_invalid', 'The AI key was rejected. Check OPENAI_API_KEY.');
    if (code === 'insufficient_quota') throw new HttpError(500, 'ai_no_credit', 'The OpenAI API account is out of credit. Top it up at platform.openai.com.');
    if (code === 'model_not_found') throw new HttpError(500, 'ai_model_missing', `This key can't use the model ${body.model}. Change AI_MODEL.`);
    throw new Error(`OpenAI API: ${json?.error?.message || 'HTTP ' + res.status}`);
  }
  return json;
}

const model = () => process.env.AI_MODEL || DEFAULT_MODEL;

// references and photo are JPEG Buffers. Returns { verdict: 'pass' | 'fail', reason, model, raw }.
export async function compare(references, photo, { fetchImpl = fetch } = {}) {
  if (references.length === 0) throw new HttpError(409, 'no_reference', 'No check-in photo to compare with');
  const m = model();
  const body = await ask(buildRequest(references, photo, m), COMPARE_TIMEOUT_MS, fetchImpl);
  return { ...readVerdict(body), model: body.model || m };
}

// photo is a JPEG Buffer. Returns { simple, reason, raw }.
export async function checkReference(photo, { fetchImpl = fetch } = {}) {
  return readCheck(await ask(buildCheckRequest(photo, model()), CHECK_TIMEOUT_MS, fetchImpl));
}
