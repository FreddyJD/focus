'use strict';

/**
 * Security test: a remote web page must NOT be able to reach focusApi.
 *
 * If this fails, any website could call pause() or allowBlockedSite() and
 * switch off the blocker from inside a page.
 *
 *   npm run test:security
 */

const http = require('node:http');
const path = require('node:path');
const { app, session, BrowserWindow } = require('electron');

const results = [];
function check(name, pass, extra = '') {
  results.push({ name, pass, extra });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

const TAB_PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'tab.js');
const BLOCKED_PAGE = path.join(__dirname, '..', 'src', 'renderer', 'blocked.html');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>remote page</h1></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ses = session.fromPartition('sec-test-' + Date.now());

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      session: ses,
      preload: TAB_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // --- 1. remote http page must not see the API ---
  await win.webContents.loadURL(`http://127.0.0.1:${port}/`);
  const remoteApi = await win.webContents.executeJavaScript('typeof window.focusApi');
  check('remote page cannot see focusApi', remoteApi === 'undefined', `typeof = ${remoteApi}`);

  const remoteNode = await win.webContents.executeJavaScript('typeof window.require');
  check('remote page has no node require', remoteNode === 'undefined', `typeof = ${remoteNode}`);

  // --- 2. our own blocked page MUST see it, or the UI breaks ---
  await win.webContents.loadFile(BLOCKED_PAGE, { search: '?host=x.com&reason=site' });
  const localApi = await win.webContents.executeJavaScript('typeof window.focusApi');
  check('internal blocked page can see focusApi', localApi === 'object', `typeof = ${localApi}`);

  const hasPause = await win.webContents.executeJavaScript(
    'window.focusApi && typeof window.focusApi.pause'
  );
  check('blocked page can pause the session', hasPause === 'function', `typeof = ${hasPause}`);

  // --- 3. the API must not leak back after navigating to a remote page ---
  await win.webContents.loadURL(`http://127.0.0.1:${port}/`);
  const afterApi = await win.webContents.executeJavaScript('typeof window.focusApi');
  check('API does not leak after navigating back to remote', afterApi === 'undefined',
    `typeof = ${afterApi}`);

  server.close();
  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
