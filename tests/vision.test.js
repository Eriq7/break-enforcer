import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, checkReference, compare, decide, readCheck, readVerdict } from '../lib/vision.js';

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
  seen_in_both: ['silver laptop', 'light wood desk', 'cream wall'],
  differences: [],
  same_scene: 2,
  points: [],
};

test('the same thing passes, and so does probably the same thing', () => {
  assert.equal(decide(good), true);
  assert.equal(decide({ ...good, same_scene: 1 }), true);
  assert.equal(readVerdict(answer(good)).verdict, 'pass');
});

test('a pass says whether it was clear or only just', () => {
  assert.equal(readVerdict(answer(good)).clear, true);
  const borderline = readVerdict(answer({ ...good, same_scene: 1 }));
  assert.deepEqual([borderline.verdict, borderline.clear], ['pass', false]);
});

test('only a different thing or place is rejected', () => {
  assert.equal(decide({ ...good, same_scene: 0 }), false);
  assert.equal(readVerdict(answer({ ...good, same_scene: 0 })).verdict, 'fail');
});

test('a fail comes back as at most 3 short points, stored one per line', () => {
  const r = readVerdict(answer({ ...good, same_scene: 0, points: [' Dark desk here.', 'No window', 'Step back', 'Fourth'] }));
  assert.deepEqual(r.points, ['Dark desk here', 'No window', 'Step back']);
  assert.equal(r.reason, 'Dark desk here\nNo window\nStep back');
});

test('a fail with no points still tells the user what to do, and a pass has none', () => {
  assert.equal(readVerdict(answer({ ...good, same_scene: 0, points: [] })).points.length, 2);
  assert.deepEqual(readVerdict(answer({ ...good, points: ['ignored'] })).points, []);
});

test('an answer in the old strict format is an error, not a silent fail', () => {
  // What failed Eric on 2026-10-31 for a clear photo of the same laptop.
  const old = { occlusion: 'none', matched_landmarks: [], generic_only_match: true, place_score: 1, screen_or_print: true };
  assert.throws(() => readVerdict(answer(old)));
});

test('the reference check reads the warning and its reason', () => {
  const r = readCheck(answer({ shows: 'an orange', simple: true, reason: 'An orange can be anywhere.' }));
  assert.deepEqual([r.simple, r.reason], [true, 'An orange can be anywhere.']);
  assert.equal(readCheck(answer({ shows: 'exit doors', simple: false, reason: '' })).simple, false);
  assert.throws(() => readCheck(answer({ shows: 'x' })));
});

test('the reference check sends just the one photo', async () => {
  process.env.OPENAI_API_KEY = 'k';
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => answer({ shows: 'desk', simple: false, reason: '' }) };
  };
  assert.equal((await checkReference(jpeg(1), { fetchImpl })).simple, false);
  assert.equal(sent.messages[1].content.filter((c) => c.type === 'image_url').length, 1);
  assert.equal(sent.response_format.json_schema.strict, true);
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
    return { ok: true, status: 200, json: async () => answer({ ...good, same_scene: 0, points: ['No window'] }) };
  };
  const r = await compare([jpeg(1)], jpeg(2), { fetchImpl });
  assert.equal(sent.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(sent.init.headers.authorization, 'Bearer test-key');
  assert.deepEqual([r.verdict, r.reason, r.model], ['fail', 'No window', 'gpt-test']);
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
