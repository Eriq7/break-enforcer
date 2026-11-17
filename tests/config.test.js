import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chosenRelax } from '../lib/config.js';
import { HttpError } from '../lib/http.js';

test('chosenRelax falls back to the default when the app sends no length', () => {
  assert.equal(chosenRelax(undefined, 2725), 2725);
  assert.equal(chosenRelax(null, 2725), 2725);
});

test('chosenRelax takes any whole number of seconds from 1 minute to 5:59:59', () => {
  assert.equal(chosenRelax(60, 2725), 60);
  assert.equal(chosenRelax(1800, 2725), 1800);
  assert.equal(chosenRelax(6 * 3600 - 1, 2725), 21599);
});

test('chosenRelax refuses lengths outside the range or not whole seconds', () => {
  for (const bad of [0, 59, 21600, 90.5, '1800', -60, Infinity]) {
    assert.throws(() => chosenRelax(bad, 2725), (e) => e instanceof HttpError && e.status === 400 && e.code === 'bad_length');
  }
});
