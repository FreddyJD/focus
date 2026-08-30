'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  hostOf,
  isHostAllowed,
  isAssetType,
  ASSET_TYPES,
} = require('../src/main/allowlist');

/**
 * Off-domain assets.
 *
 * Real sites serve scripts and styles from separate CDN domains, so an
 * allowlist that only matches the page host renders them blank:
 *   instagram.com -> static.cdninstagram.com  (12 scripts)
 *   tiktok.com    -> tiktokcdn-us.com         (61 scripts)
 *   x.com         -> abs.twimg.com            (fonts, css, js)
 *
 * The rule: an ALLOWED page may pull assets from anywhere. A blocked page may
 * not, and no asset rule may ever let you navigate somewhere new.
 */

// Mirrors isUrlAllowed() in src/main/index.js.
function allowed(url, { resourceType = 'mainFrame', pageUrl = '', sites = [] } = {}) {
  const host = hostOf(url);
  if (!host) return false;
  if (isHostAllowed(host, sites)) return true;

  const isAsset = isAssetType(resourceType);
  if (isAsset && pageUrl && isHostAllowed(hostOf(pageUrl), sites)) return true;

  return false;
}

const SITES = ['instagram.com', 'tiktok.com'];

test('an allowed page can load its assets from any CDN', () => {
  const cases = [
    ['https://static.cdninstagram.com/rsrc.php/x.js', 'script', 'https://instagram.com/'],
    ['https://lf16-tiktok-web.tiktokcdn-us.com/obj/a.js', 'script', 'https://tiktok.com/'],
    ['https://abs.twimg.com/font.woff2', 'font', 'https://tiktok.com/'],
    ['https://scontent.cdninstagram.com/pic.jpg', 'image', 'https://instagram.com/explore'],
    ['https://unknown-cdn.example/style.css', 'stylesheet', 'https://instagram.com/'],
  ];
  for (const [url, type, page] of cases) {
    assert.equal(
      allowed(url, { resourceType: type, pageUrl: page, sites: SITES }),
      true,
      `${type} from ${url} should load for ${page}`
    );
  }
});

test('a BLOCKED page cannot load assets from anywhere', () => {
  // The whole point: reddit is not on the list, so nothing it asks for loads.
  assert.equal(
    allowed('https://static.cdninstagram.com/x.js', {
      resourceType: 'script',
      pageUrl: 'https://reddit.com/',
      sites: SITES,
    }),
    false
  );
  assert.equal(
    allowed('https://reddit-cdn.com/app.js', {
      resourceType: 'script',
      pageUrl: 'https://reddit.com/',
      sites: SITES,
    }),
    false
  );
});

test('assets never become a way to NAVIGATE somewhere blocked', () => {
  // A top-level page load is not an asset, so the CDN exception cannot apply.
  assert.equal(
    allowed('https://tiktokcdn-us.com/', {
      resourceType: 'mainFrame',
      pageUrl: 'https://tiktok.com/',
      sites: SITES,
    }),
    false,
    'mainFrame must never be treated as an asset'
  );

  // An iframe is content, not an asset — embedding youtube stays blocked.
  assert.equal(
    allowed('https://youtube.com/embed/abc', {
      resourceType: 'subFrame',
      pageUrl: 'https://instagram.com/',
      sites: SITES,
    }),
    false,
    'subFrame must never be treated as an asset'
  );
});

test('mainFrame and subFrame are excluded from the asset types', () => {
  assert.equal(isAssetType('mainFrame'), false);
  assert.equal(isAssetType('subFrame'), false);
  assert.equal(ASSET_TYPES.has('mainFrame'), false);
  assert.equal(ASSET_TYPES.has('subFrame'), false);
});

test('the usual asset types are covered', () => {
  for (const t of ['script', 'stylesheet', 'image', 'font', 'media', 'xhr', 'fetch']) {
    assert.equal(isAssetType(t), true, `${t} should count as an asset`);
  }
});

test('no page context means no exception', () => {
  // Without a known initiating page we fall back to strict host matching.
  assert.equal(
    allowed('https://static.cdninstagram.com/x.js', {
      resourceType: 'script',
      pageUrl: '',
      sites: SITES,
    }),
    false
  );
});

test('an empty allowlist still blocks everything', () => {
  assert.equal(
    allowed('https://static.cdninstagram.com/x.js', {
      resourceType: 'script',
      pageUrl: 'https://instagram.com/',
      sites: [],
    }),
    false
  );
});
