import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, compare, decide, readVerdict } from '../lib/vision.js';

const jpeg = (n) => Buffer.from([0xff, 0xd8, 0xff, n]);
const answer = (v) => ({ model: 'gpt-test', choices: [{ message: { content: JSON.stringify(v) } }] });

test('request sends every reference before the new photo and asks for the verdict schema', () => {
  const req = buildRequest([jpeg(1), jpeg(2)], jpeg(3), 'm');
  const images = req.messages[1].content.filter((c) => c.type === 'image_url').map((c) => c.image_url.url);
  assert.deepEqual(images, [jpeg(1), jpeg(2), jpeg(3)].map((b) => 'data:image/jpeg;base64,' + b.toString('base64')));
  assert.equal(req.response_format.json_schema.strict, true);
  assert.equal(req.model, 'm');
});

const good = {
  occlusion: 'none',
  matched_landmarks: ['red elephant picture', 'bookcase under it', 'grey filing cabinet'],
  mismatched_features: [],
  generic_only_match: false,
  place_score: 2,
  viewpoint_score: 2,
  screen_or_print: false,
  reason: 'ok',
};

test('a clear photo of the same place from the same direction passes', () => {
  assert.equal(decide(good), true);
  assert.equal(decide({ ...good, viewpoint_score: 1, occlusion: 'minor' }), true);
  assert.equal(readVerdict(answer(good)).verdict, 'pass');
});

test('each failed check on its own is enough to reject', () => {
  for (const change of [
    { occlusion: 'major' },
    { place_score: 1 },
    { place_score: 0 },
    { viewpoint_score: 0 },
    { matched_landmarks: ['red elephant picture'] },
    { generic_only_match: true },
    { screen_or_print: true },
  ]) {
    assert.equal(decide({ ...good, ...change }), false, JSON.stringify(change));
  }
});

test('an answer that is not the verdict JSON is an error, not a silent fail', () => {
  assert.throws(() => readVerdict({ choices: [{ message: { content: 'looks fine' } }] }));
  assert.throws(() => readVerdict({ choices: [{ message: { refusal: 'no' } }] }));
});

test('compare calls the API with the key and returns the verdict', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init };
    return { ok: true, status: 200, json: async () => answer({ ...good, reason: 'Same place' }) };
  };
  const r = await compare([jpeg(1)], jpeg(2), { fetchImpl });
  assert.equal(sent.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(sent.init.headers.authorization, 'Bearer test-key');
  assert.deepEqual([r.verdict, r.reason, r.model], ['pass', 'Same place', 'gpt-test']);
});

test('a rejected key says which setting to fix', async () => {
  process.env.OPENAI_API_KEY = 'bad';
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Incorrect API key' } }) });
  await assert.rejects(compare([jpeg(1)], jpeg(2), { fetchImpl }), /OPENAI_API_KEY/);
});

test('an API account with no credit says so', async () => {
  process.env.OPENAI_API_KEY = 'k';
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 'insufficient_quota' } }) });
  await assert.rejects(compare([jpeg(1)], jpeg(2), { fetchImpl }), /out of credit/);
});

test('missing key is reported by name', async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(compare([jpeg(1)], jpeg(2), { fetchImpl: async () => assert.fail('no call') }), /OPENAI_API_KEY/);
});
