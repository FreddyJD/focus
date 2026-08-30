'use strict';

/**
 * Integration test: proves the network filter really blocks.
 *
 * Runs inside a real Electron process against a local HTTP server that
 * impersonates both allowed and blocked hosts, so no internet access is
 * needed and results are deterministic.
 *
 *   npm run test:integration
 */

const http = require('node:http');
const { app, session, BrowserWindow } = require('electron');

const results = [];
function check(name, pass, extra = '') {
  results.push({ name, pass, extra });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

// Stand-in for real session state.
let enforcing = true;
const allowed = ['allowed.test'];

const {
  hostOf,
  isHostAllowed,
  isInternalUrl,
  isDangerousScheme,
  isAssetType,
  INFRA_SUBFRAME,
} = require('../src/main/allowlist');

function isUrlAllowed(url, { isSubframe = false, isAsset = false, pageUrl = '' } = {}) {
  if (isInternalUrl(url)) return true;
  if (isDangerousScheme(url)) return false;
  if (!enforcing) return true;
  const host = hostOf(url);
  if (!host) return false;
  if (isHostAllowed(host, allowed)) return true;
  if (isAsset && pageUrl && isHostAllowed(hostOf(pageUrl), allowed)) return true;
  if (isSubframe && isHostAllowed(host, INFRA_SUBFRAME)) return true;
  return false;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>served</h1></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ses = session.fromPartition('test-focus-' + Date.now());

  // Route every test hostname to the local server, so we are testing
  // hostname policy rather than DNS.
  await ses.setProxy({ proxyRules: `http=127.0.0.1:${port}` });

  let reachedNetwork = 0;

  ses.webRequest.onBeforeRequest((details, callback) => {
    const { url, resourceType } = details;
    if (isInternalUrl(url)) return callback({});
    if (!enforcing) return callback({});

    const isAsset = isAssetType(resourceType);
    let pageUrl = '';
    if (isAsset) {
      try {
        if (details.frame && details.frame.url) pageUrl = details.frame.url;
      } catch {}
      if (!pageUrl && details.referrer) pageUrl = details.referrer;
    }

    if (isUrlAllowed(url, { isSubframe: resourceType !== 'mainFrame', isAsset, pageUrl })) {
      return callback({});
    }
    return callback({ cancel: true }); // fail closed
  });

  ses.webRequest.onCompleted((details) => {
    if (hostOf(details.url) === 'blocked.test' && enforcing) reachedNetwork += 1;
  });

  const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });

  async function visit(url) {
    const timeout = new Promise((res) =>
      setTimeout(() => res({ error: 'TIMEOUT', blocked: false }), 8000)
    );
    const load = win.webContents.loadURL(url).then(
      () => ({ url: win.webContents.getURL(), blocked: false }),
      (err) => ({
        error: err.message,
        blocked: /ERR_BLOCKED_BY_CLIENT|ERR_FAILED|ERR_ABORTED/.test(err.message),
      })
    );
    return Promise.race([load, timeout]);
  }

  let r;

  r = await visit('http://allowed.test/');
  check('allowed host loads', r.url === 'http://allowed.test/', r.error || r.url);

  r = await visit('http://blocked.test/');
  check('blocked host is refused', r.blocked === true, r.error || r.url);

  check('blocked host never reached the network', reachedNetwork === 0, `hits=${reachedNetwork}`);

  r = await visit('http://notallowed.test/');
  check('lookalike host blocked', r.blocked === true, r.error || r.url);

  r = await visit('http://sub.allowed.test/');
  check('subdomain of allowed host loads', r.url === 'http://sub.allowed.test/', r.error || r.url);

  r = await visit('http://allowed.test.evil.test/');
  check('suffix-attack host blocked', r.blocked === true, r.error || r.url);

  enforcing = false;
  r = await visit('http://blocked.test/');
  check('pause lifts blocking', r.url === 'http://blocked.test/', r.error || r.url);
  enforcing = true;

  r = await visit('http://blocked.test/');
  check('resume restores blocking', r.blocked === true, r.error || r.url);

  r = await visit('http://allowed.test/');
  check('allowed host still loads at the end', r.url === 'http://allowed.test/', r.error || r.url);

  // --- the asset exception must not become a navigation bypass ---
  // A CDN that an allowed page may pull scripts from must still be blocked
  // when you try to browse to it directly.
  r = await visit('http://cdn.blocked.test/');
  check(
    'a CDN is still blocked as a top-level page',
    r.blocked === true,
    r.error || r.url
  );

  server.close();

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
