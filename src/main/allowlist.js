'use strict';

/**
 * Domain allowlist matching.
 *
 * An entry like "google.com" matches google.com and any subdomain
 * (mail.google.com), but NOT notgoogle.com. "www." is ignored on both
 * sides so users don't have to think about it.
 */

/** Turn whatever the user typed into a bare hostname, or '' if unusable. */
function normalizeEntry(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';

  // Only http(s) may carry a scheme. Anything else (javascript:, data:,
  // file:, ms-settings:) is not a website and must not become an entry.
  // A scheme only counts when followed by "://" — otherwise "localhost:3000"
  // and "user:pw@host" would be misread as schemes.
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//);
  if (scheme) {
    if (scheme[1] !== 'http' && scheme[1] !== 'https') return '';
    s = s.slice(scheme[0].length);
  }

  s = s.replace(/^[^/@]*@/, '');                // credentials
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.split(':')[0];                          // port
  s = s.replace(/^www\./, '');
  s = s.replace(/^\.+|\.+$/g, '');

  if (!s) return '';
  if (!/^[a-z0-9.-]+$/.test(s)) return '';
  if (s.includes('..')) return '';
  // A real host has a dot (example.com) unless it's a local name.
  if (!s.includes('.') && s !== 'localhost') return '';
  return s;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function matchesEntry(host, entry) {
  if (!host || !entry) return false;
  return host === entry || host.endsWith('.' + entry);
}

function isHostAllowed(host, entries) {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, '');
  return entries.some((e) => matchesEntry(h, e));
}

/**
 * Sub-frames needed for allowed sites to actually function: sign-in, captcha,
 * payments. Blocking these breaks real logins without blocking any content the
 * user could browse to, so they're permitted for embedded frames only.
 */
const INFRA_SUBFRAME = [
  'accounts.google.com',
  'gstatic.com',
  'recaptcha.net',
  'hcaptcha.com',
  'cloudflare.com',
  'challenges.cloudflare.com',
  'duosecurity.com',
  'okta.com',
  'auth0.com',
  'login.microsoftonline.com',
  'stripe.com',
  'stripecdn.com',
  'paypal.com',
];

/**
 * Resource types that are page *assets* rather than page *content*.
 *
 * Almost every real site serves these from a separate CDN domain
 * (instagram.com -> static.cdninstagram.com, tiktok.com -> tiktokcdn-us.com,
 * x.com -> abs.twimg.com). Blocking them leaves an allowlisted site rendering
 * a blank screen, which is worse than useless: the user allowed the site, so
 * they expect it to work.
 *
 * Allowing these when the TOP-LEVEL PAGE is already allowed costs nothing in
 * terms of the product's promise. You still cannot navigate to a blocked
 * domain — this only lets a page you already chose finish drawing itself.
 *
 * Deliberately excluded: `mainFrame` and `subFrame`, because those are how
 * you'd actually *browse* somewhere. An iframe of youtube.com inside an
 * allowed page is content, not an asset.
 */
const ASSET_TYPES = new Set([
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'xhr',
  'fetch',
  'ping',
  'cspReport',
  'websocket',
  'other',
]);

function isAssetType(resourceType) {
  return ASSET_TYPES.has(resourceType);
}

/** URLs that are part of the app itself and must never be blocked. */
function isInternalUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('file://') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome-extension://') ||
    url === 'about:blank' ||
    url.startsWith('data:')
  );
}

/** Schemes we refuse to hand off to the OS or load at all. */
function isDangerousScheme(url) {
  return /^(javascript|vbscript|blob|filesystem|ms-[a-z-]+|shell|search-ms):/i.test(
    String(url || '')
  );
}

module.exports = {
  normalizeEntry,
  hostOf,
  isHostAllowed,
  isInternalUrl,
  isDangerousScheme,
  isAssetType,
  INFRA_SUBFRAME,
  ASSET_TYPES,
};
