import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, route } from '../lib/http.js';
import { decodeJpeg } from '../lib/photos.js';

function fakeRes() {
  const res = { headers: {}, setHeader: (k, v) => (res.headers[k] = v), end: (b) => (res.body = JSON.parse(b)) };
  return res;
}

test('route sends the handler result as JSON', async () => {
  const res = fakeRes();
  await route(['GET'], async () => ({ ok: 1 }))({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: 1 });
});

test('route passes HttpError messages through and hides other errors', async () => {
  const known = fakeRes();
  await route(['POST'], async () => { throw new HttpError(409, 'already_active', '已经有一轮在进行了'); })({ method: 'POST' }, known);
  assert.deepEqual([known.statusCode, known.body.error, known.body.message], [409, 'already_active', '已经有一轮在进行了']);

  const unknown = fakeRes();
  const log = console.error;
  console.error = () => {};
  await route(['POST'], async () => { throw new Error('secret internals'); })({ method: 'POST' }, unknown);
  console.error = log;
  assert.equal(unknown.statusCode, 500);
  assert.doesNotMatch(unknown.body.message, /secret/);
});

test('route rejects other methods', async () => {
  const res = fakeRes();
  await route(['POST'], async () => assert.fail('should not run'))({ method: 'GET' }, res);
  assert.equal(res.statusCode, 405);
});

test('decodeJpeg accepts JPEG and refuses anything else', () => {
  assert.equal(decodeJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')).length, 4);
  assert.throws(() => decodeJpeg(Buffer.from('<svg/>').toString('base64')), /格式/);
  assert.throws(() => decodeJpeg(''), /没收到/);
  assert.throws(() => decodeJpeg(undefined), /没收到/);
});
