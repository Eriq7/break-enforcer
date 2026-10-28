import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkUrl, newLinkCode, startCode } from '../lib/telegram.js';

test('link codes fit in a Telegram start link and differ every time', () => {
  const a = newLinkCode();
  assert.match(a, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(a, newLinkCode());
  assert.equal(linkUrl('be_bot', a), `https://t.me/be_bot?start=${a}`);
});

test('only "/start <code>" gives a code', () => {
  assert.equal(startCode('/start abc_DEF-123'), 'abc_DEF-123');
  assert.equal(startCode('/start@be_bot abc'), 'abc');
  assert.equal(startCode('/start'), null);
  assert.equal(startCode('hello'), null);
  assert.equal(startCode('/start a b'), null);
  assert.equal(startCode(undefined), null);
});
