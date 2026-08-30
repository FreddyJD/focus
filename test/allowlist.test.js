'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeEntry,
  hostOf,
  isHostAllowed,
  isDangerousScheme,
} = require('../src/main/allowlist');

test('normalizeEntry: extracts host from real input', () => {
  assert.equal(normalizeEntry('https://www.Google.com/search?q=1'), 'google.com');
  assert.equal(normalizeEntry('  GitHub.com  '), 'github.com');
  assert.equal(normalizeEntry('http://user:pw@evil.com'), 'evil.com');
  assert.equal(normalizeEntry('user:pw@evil.com'), 'evil.com');
  assert.equal(normalizeEntry('localhost:3000'), 'localhost');
  assert.equal(normalizeEntry('sub.deep.example.co.uk'), 'sub.deep.example.co.uk');
  assert.equal(normalizeEntry('news.ycombinator.com/news'), 'news.ycombinator.com');
});

test('normalizeEntry: rejects non-web and malformed input', () => {
  for (const bad of [
    'javascript:alert(1)',
    'file:///C:/x',
    'ms-settings:',
    'data:text/html,x',
    'vbscript:x',
    'notahost',
    'a..b.com',
    '',
    '   ',
    '...',
    'ho st.com',
  ]) {
    assert.equal(normalizeEntry(bad), '', `should reject: ${bad}`);
  }
});

test('isHostAllowed: subdomains yes, lookalikes no', () => {
  const list = ['google.com', 'github.com'];
  const allowed = (u) => isHostAllowed(hostOf(u), list);

  assert.equal(allowed('https://google.com'), true);
  assert.equal(allowed('https://www.google.com'), true);
  assert.equal(allowed('https://mail.google.com/inbox'), true);
  assert.equal(allowed('https://GOOGLE.com'), true);

  // The attacks that a naive `includes()` check would let through.
  assert.equal(allowed('https://notgoogle.com'), false);
  assert.equal(allowed('https://google.com.evil.com'), false);
  assert.equal(allowed('https://evil.com/?x=google.com'), false);
  assert.equal(allowed('https://evil.com#google.com'), false);
  assert.equal(allowed('https://youtube.com'), false);
  assert.equal(allowed('not a url'), false);
});

test('empty allowlist blocks everything', () => {
  assert.equal(isHostAllowed('google.com', []), false);
});

test('isDangerousScheme', () => {
  assert.equal(isDangerousScheme('javascript:alert(1)'), true);
  assert.equal(isDangerousScheme('ms-settings:privacy'), true);
  assert.equal(isDangerousScheme('https://ok.com'), false);
});
