'use strict';

/**
 * Probe: what does an allowlisted site actually request?
 *
 *   npx electron tools/probe-site.js instagram.com
 *
 * Loads the site with the CURRENT allowlist rules and reports every request
 * that would be cancelled, grouped by host and resource type. This is how we
 * find out why a whitelisted site renders blank instead of guessing at CDNs.
 */

const { app, BrowserWindow, session } = require('electron');
const {
  hostOf,
  isHostAllowed,
  isInternalUrl,
  isAssetType,
  INFRA_SUBFRAME,
} = require('../src/main/allowlist');

const target = (process.argv[2] || 'instagram.com').replace(/^https?:\/\//, '');
const allowed = [target];

const blocked = new Map(); // host -> Map(type -> count)
const permitted = new Map();

function note(map, host, type) {
  if (!map.has(host)) map.set(host, new Map());
  const t = map.get(host);
  t.set(type, (t.get(type) || 0) + 1);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const ses = session.fromPartition('probe-' + Date.now());

  ses.webRequest.onBeforeRequest((details, callback) => {
    const { url, resourceType } = details;
    if (isInternalUrl(url)) return callback({});

    const host = hostOf(url);
    const isSubframe = resourceType !== 'mainFrame';
    const isAsset = isAssetType(resourceType);

    let pageUrl = '';
    if (isAsset) {
      try {
        if (details.frame && details.frame.url) pageUrl = details.frame.url;
      } catch {}
      if (!pageUrl && details.referrer) pageUrl = details.referrer;
    }

    // Mirrors the production rule in src/main/index.js.
    let ok = isHostAllowed(host, allowed);
    if (!ok && isAsset && pageUrl && isHostAllowed(hostOf(pageUrl), allowed)) ok = true;
    if (!ok && isSubframe) ok = isHostAllowed(host, INFRA_SUBFRAME);

    if (ok) {
      note(permitted, host, resourceType);
      return callback({});
    }
    note(blocked, host, resourceType);
    return callback({ cancel: true });
  });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    // The filter lives on this session, so the window must actually use it —
    // otherwise every request goes through the default session unfiltered and
    // the probe silently measures nothing.
    webPreferences: { session: ses },
  });

  try {
    await win.webContents.loadURL(`https://${target}`);
  } catch (err) {
    console.log('main frame load error:', err.message);
  }

  // Let late scripts fire.
  await new Promise((r) => setTimeout(r, 6000));

  const text = await win.webContents
    .executeJavaScript('document.body ? document.body.innerText.trim().length : 0')
    .catch(() => -1);
  const nodes = await win.webContents
    .executeJavaScript('document.querySelectorAll("*").length')
    .catch(() => -1);

  console.log(`\n=== ${target} ===`);
  console.log(`visible text length: ${text}   DOM nodes: ${nodes}`);

  const sum = (m) => [...m.values()].reduce((a, t) => a + [...t.values()].reduce((x, y) => x + y, 0), 0);
  console.log(`allowed requests: ${sum(permitted)}   BLOCKED: ${sum(blocked)}`);

  console.log('\n--- blocked hosts (what breaks the page) ---');
  const rows = [...blocked.entries()]
    .map(([host, types]) => ({
      host,
      total: [...types.values()].reduce((a, b) => a + b, 0),
      types: [...types.entries()].map(([t, c]) => `${t}:${c}`).join(' '),
    }))
    .sort((a, b) => b.total - a.total);

  for (const r of rows.slice(0, 25)) {
    console.log(`${String(r.total).padStart(4)}  ${r.host.padEnd(34)} ${r.types}`);
  }

  app.exit(0);
});
