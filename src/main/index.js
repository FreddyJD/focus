'use strict';

const path = require('node:path');
const {
  app,
  BaseWindow,
  WebContentsView,
  session,
  ipcMain,
  dialog,
  shell,
  globalShortcut,
  screen,
  Menu,
} = require('electron');

const { Store } = require('./store');
const { FocusSession } = require('./session');
const {
  normalizeEntry,
  hostOf,
  isHostAllowed,
  isInternalUrl,
  isDangerousScheme,
  isAssetType,
  INFRA_SUBFRAME,
} = require('./allowlist');
const { AppWatcher } = require('./appwatcher');
const { initUpdater } = require('./updater');

const CHROME_HEIGHT = 88; // browser chrome strip at the top
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');
const TAB_PRELOAD = path.join(__dirname, '..', 'preload', 'tab.js');

/** Window/taskbar icon. Packaged builds get it from extraResources. */
const ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, '..', '..', 'build', 'icon.png');
const DEV = process.argv.includes('--dev');

let win = null;              // BaseWindow (fullscreen shell)
let chromeView = null;       // tabs + address bar + timer
let overlayView = null;      // setup / summary overlay
let store = null;
let focus = null;
let watcher = null;
let updater = null;

/** @type {{id:number, view:WebContentsView, title:string, url:string}[]} */
let tabs = [];
let activeTabId = null;
let nextTabId = 1;
let lastBlock = { url: '', host: '', reason: '' };
/** Set only once the user has legitimately confirmed a quit. */
let quitConfirmed = false;
let warnOpen = false;
/** Active while a session is enforcing; keeps the window in front. */
let focusGuard = null;
/** Which overlay page is currently showing, if any. */
let overlayPage = null;
/** True when a session is ending via "End session" rather than the clock. */
let returnToSetup = false;

/**
 * Explain why the app will not close. Deliberately a plain dialog with a single
 * button — it is a wall, not a decision point.
 */
async function warnLocked() {
  if (warnOpen) return;
  warnOpen = true;
  try {
    await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Back to work'],
      defaultId: 0,
      title: 'Session in progress',
      message: 'Focus is locked until you pause.',
      detail:
        'There is no close button on purpose. Pause the session (Ctrl+Shift+P) ' +
        'if you genuinely need to stop — pausing also stops the clock, so it ' +
        'stays honest about how long you actually focused.',
    });
  } finally {
    warnOpen = false;
  }
}

// ---------------------------------------------------------------- allowlist

function allowedSites() {
  return store.get('allowedSites') || [];
}

/**
 * The single source of truth for "can this URL load?".
 * Called from every layer: network, navigation, redirect, popup.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.isSubframe]  embedded frame rather than top-level
 * @param {boolean} [opts.isAsset]     script/style/image/font/xhr for a page
 * @param {string}  [opts.pageUrl]     the page that initiated the request
 */
function isUrlAllowed(url, { isSubframe = false, isAsset = false, pageUrl = '' } = {}) {
  if (isInternalUrl(url)) return true;
  if (isDangerousScheme(url)) return false;
  if (!focus.isEnforcing) return true; // idle or paused: browse freely

  const host = hostOf(url);
  if (!host) return false;
  if (isHostAllowed(host, allowedSites())) return true;

  // An allowed page may load its own assets from anywhere. Real sites serve
  // scripts and styles from separate CDN domains (instagram.com ->
  // static.cdninstagram.com), so without this an allowlisted site renders a
  // blank screen. This never lets the user NAVIGATE anywhere new — only lets
  // a page they already chose finish drawing itself.
  if (isAsset && pageUrl && isHostAllowed(hostOf(pageUrl), allowedSites())) return true;

  if (isSubframe && isHostAllowed(host, INFRA_SUBFRAME)) return true;
  return false;
}

function blockedUrlFor(url, reason = 'site') {
  const host = hostOf(url) || url;
  lastBlock = { url, host, reason };
  const params = new URLSearchParams({ host, url, reason });
  return `file://${path.join(RENDERER, 'blocked.html').replace(/\\/g, '/')}?${params}`;
}

// -------------------------------------------------------- session plumbing

function focusSession() {
  return session.fromPartition('persist:focus-browser');
}

/**
 * Network-level enforcement. This is what makes blocking real: even if a page
 * tries to fetch a blocked domain via XHR, an iframe, or a redirect chain, the
 * request never leaves the machine.
 */
function installNetworkFilter() {
  const ses = focusSession();

  ses.webRequest.onBeforeRequest((details, callback) => {
    const { url, resourceType } = details;

    if (isInternalUrl(url)) return callback({});
    if (!focus.isEnforcing) return callback({});

    const isSubframe = resourceType !== 'mainFrame';
    const isAsset = isAssetType(resourceType);

    // Which page asked for this? Electron gives the initiating frame's URL,
    // which is what decides whether an off-domain asset is legitimate.
    let pageUrl = '';
    if (isAsset) {
      try {
        const frame = details.frame;
        if (frame && frame.url) pageUrl = frame.url;
      } catch {
        // Frame may already be gone; fall back to the referrer.
      }
      if (!pageUrl && details.referrer) pageUrl = details.referrer;
      if (!pageUrl) {
        const wc = details.webContentsId != null
          ? tabs.find((t) => t.view.webContents.id === details.webContentsId)
          : null;
        if (wc) pageUrl = wc.view.webContents.getURL();
      }
    }

    if (isUrlAllowed(url, { isSubframe, isAsset, pageUrl })) return callback({});

    // Always cancel rather than redirect. Chromium refuses an http -> file://
    // redirect (ERR_UNSAFE_REDIRECT), and cancelling fails closed: not a
    // single byte leaves the machine. The blocked page is then rendered by
    // the did-fail-load handler on the tab.
    if (resourceType === 'mainFrame') lastBlock = { url, host: hostOf(url), reason: 'site' };
    return callback({ cancel: true });
  });

  // Deny device permissions outright — a focus browser never needs them.
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const benign = ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write'];
    callback(benign.includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) =>
    ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission)
  );
}

// ------------------------------------------------------------------- tabs

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function contentBounds() {
  const { width, height } = win.getContentBounds();
  return { x: 0, y: CHROME_HEIGHT, width, height: Math.max(0, height - CHROME_HEIGHT) };
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  if (chromeView) chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT });
  const b = contentBounds();
  for (const t of tabs) t.view.setBounds(b);
  if (overlayView) overlayView.setBounds({ x: 0, y: 0, width, height });
}

function createTab(url) {
  const view = new WebContentsView({
    webPreferences: {
      session: focusSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Tabs render untrusted web pages, so they get the restricted preload
      // that only unlocks on our own blocked.html.
      preload: TAB_PRELOAD,
    },
  });

  const tab = { id: nextTabId++, view, title: 'New tab', url: url || '' };
  tabs.push(tab);

  const wc = view.webContents;
  attachShortcuts(wc);

  // Layer 2: navigation guard (catches things the network filter can't, like
  // a same-document push into a blocked host).
  wc.on('will-navigate', (e, nextUrl) => {
    if (!isUrlAllowed(nextUrl)) {
      e.preventDefault();
      wc.loadURL(blockedUrlFor(nextUrl, 'site'));
    }
  });

  wc.on('will-redirect', (e, nextUrl) => {
    if (!isUrlAllowed(nextUrl)) {
      e.preventDefault();
      wc.loadURL(blockedUrlFor(nextUrl, 'redirect'));
    }
  });

  // Layer 3: popups and target=_blank become tabs, never OS browser windows.
  wc.setWindowOpenHandler(({ url: openUrl }) => {
    if (isDangerousScheme(openUrl)) return { action: 'deny' };
    if (!isUrlAllowed(openUrl)) {
      loadInActiveTab(blockedUrlFor(openUrl, 'popup'));
      return { action: 'deny' };
    }
    createTab(openUrl);
    return { action: 'deny' };
  });

  const push = () => {
    tab.url = wc.getURL();
    tab.title = wc.getTitle() || 'New tab';
    sendState();
  };
  wc.on('page-title-updated', push);
  wc.on('did-navigate', push);
  wc.on('did-navigate-in-page', push);
  wc.on('did-start-loading', sendState);
  wc.on('did-stop-loading', push);

  wc.on('did-fail-load', (e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED */) return;

    // -20 is ERR_BLOCKED_BY_CLIENT: our own network filter cancelled it.
    // Anything else is a real network failure and gets error copy instead.
    const wasBlocked = code === -20 || !isUrlAllowed(failedUrl);
    const params = new URLSearchParams({
      host: hostOf(failedUrl) || failedUrl,
      url: failedUrl,
      reason: wasBlocked ? 'site' : 'error',
    });
    if (!wasBlocked) params.set('detail', desc);
    wc.loadURL(`file://${path.join(RENDERER, 'blocked.html').replace(/\\/g, '/')}?${params}`);
  });

  win.contentView.addChildView(view);
  selectTab(tab.id);
  if (url) wc.loadURL(url);
  else wc.loadURL(homeTarget());
  layout();
  return tab;
}

function homeTarget() {
  const home = store.get('homeUrl');
  if (focus.isEnforcing) {
    const sites = allowedSites();
    if (isHostAllowed(hostOf(home), sites)) return home;
    if (sites.length) return `https://${sites[0]}`;
    return `file://${path.join(RENDERER, 'blocked.html').replace(/\\/g, '/')}?${new URLSearchParams(
      { host: 'nothing allowed', url: '', reason: 'empty' }
    )}`;
  }
  return home;
}

function selectTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  activeTabId = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  // Keep chrome and overlay above page content.
  if (chromeView) win.contentView.addChildView(chromeView);
  if (overlayView) win.contentView.addChildView(overlayView);
  layout();
  sendState();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  win.contentView.removeChildView(tab.view);
  try {
    tab.view.webContents.close();
  } catch {}
  if (activeTabId === id) {
    const next = tabs[idx] || tabs[idx - 1];
    if (next) selectTab(next.id);
    else createTab(homeTarget());
  }
  sendState();
}

function loadInActiveTab(url) {
  const tab = activeTab();
  if (tab) tab.view.webContents.loadURL(url);
  else createTab(url);
}

/** Turn whatever the user typed in the address bar into a URL or a search. */
function resolveInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (isDangerousScheme(raw)) return null;

  if (/^https?:\/\//i.test(raw)) return raw;

  const looksLikeHost =
    /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(raw) ||
    /^localhost(:\d+)?(\/.*)?$/i.test(raw);
  if (looksLikeHost) return `https://${raw}`;

  const engine = store.get('homeUrl') || 'https://duckduckgo.com';
  const host = hostOf(engine) || 'duckduckgo.com';
  return `https://${host}/?q=${encodeURIComponent(raw)}`;
}

// ---------------------------------------------------------------- overlay

function showOverlay(page) {
  overlayPage = page;
  if (!overlayView) {
    overlayView = new WebContentsView({
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    overlayView.setBackgroundColor('#00000000');
    win.contentView.addChildView(overlayView);
    attachShortcuts(overlayView.webContents);
  } else {
    win.contentView.addChildView(overlayView); // raise
  }
  overlayView.setVisible(true);
  overlayView.webContents.loadFile(path.join(RENDERER, `${page}.html`));
  layout();
  overlayView.webContents.focus();
}

function hideOverlay() {
  overlayPage = null;
  if (overlayView) overlayView.setVisible(false);
  const tab = activeTab();
  if (tab) tab.view.webContents.focus();
}

// ------------------------------------------------------------------ state

function buildState() {
  const snap = focus.snapshot();
  const tab = activeTab();
  const wc = tab && tab.view.webContents;
  return {
    session: snap,
    config: {
      durationMin: store.get('durationMin'),
      allowedSites: allowedSites(),
      allowedApps: store.get('allowedApps'),
      blockApps: store.get('blockApps'),
      homeUrl: store.get('homeUrl'),
      strictMode: store.get('strictMode'),
    },
    stats: store.stats(),
    lastSession: store.lastSession(),
    update: updater ? updater.state : null,
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.id === activeTabId,
      blocked: t.url.includes('blocked.html'),
    })),
    nav: {
      url: wc ? wc.getURL() : '',
      canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
      loading: wc ? wc.isLoading() : false,
    },
    appAlert: watcher ? watcher.lastAlert : null,
  };
}

let stateTimer = null;
function sendState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const state = buildState();

    const targets = [chromeView, overlayView].filter(Boolean);
    // Our own blocked.html pages listen for state too, so their buttons stay
    // in sync when the session is paused or resumed.
    for (const t of tabs) {
      const url = t.view.webContents.getURL();
      if (url.startsWith('file://') && url.includes('blocked.html')) targets.push(t.view);
    }

    for (const v of targets) {
      if (!v.webContents.isDestroyed()) v.webContents.send('focus:state', state);
    }
  }, 16);
}

// ------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('focus:getState', () => buildState());

  ipcMain.handle('focus:start', (_e, opts = {}) => {
    const minutes = Math.min(480, Math.max(1, Number(opts.durationMin) || store.get('durationMin')));
    store.set({ durationMin: minutes });
    returnToSetup = false;
    focus.start(minutes * 60_000);
    hideOverlay();

    // Re-evaluate every open tab against the allowlist now that we're live.
    for (const t of tabs) {
      const url = t.view.webContents.getURL();
      if (url && !isUrlAllowed(url)) {
        t.view.webContents.loadURL(blockedUrlFor(url, 'session-start'));
      }
    }
    if (store.get('blockApps')) watcher.start();
    sendState();
    return buildState();
  });

  ipcMain.handle('focus:pause', () => {
    focus.pause();
    // Pausing is the one sanctioned exit, so it always surfaces the modal that
    // offers Continue / Quit session.
    showOverlay('paused');
    sendState();
  });
  ipcMain.handle('focus:resume', () => {
    focus.resume();
    hideOverlay();
    sendState();
  });
  ipcMain.handle('focus:togglePause', () => {
    if (focus.status === 'paused') {
      focus.resume();
      hideOverlay();
    } else if (focus.status === 'running') {
      focus.pause();
      showOverlay('paused');
    }
    sendState();
  });
  ipcMain.handle('focus:extend', (_e, ms) => { focus.extend(ms); sendState(); });

  /**
   * Ends the session and returns to the initial screen — it does NOT quit the
   * app. Leaving is a three-step path on purpose:
   *
   *   pause -> End session -> Close
   *
   * Each step is a separate, conscious decision, and landing back on the setup
   * screen makes starting again the easiest thing to do.
   */
  ipcMain.handle('focus:quitSession', () => {
    returnToSetup = true;
    focus.complete(true); // records the session, then lands on setup
    focus.reset(); // back to a clean initial state
    showOverlay('setup');
    sendState();
    return buildState();
  });

  ipcMain.handle('focus:complete', async () => {
    if (store.get('strictMode') && focus.isActive && focus.remainingMs() > 0) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Keep going', 'End session'],
        defaultId: 0,
        cancelId: 0,
        title: 'Strict mode',
        message: 'You turned on strict mode for this session.',
        detail: 'Ending early is exactly the impulse strict mode exists to catch. End anyway?',
      });
      if (response === 0) return buildState();
    }
    focus.complete(true);
    sendState();
    return buildState();
  });

  ipcMain.handle('focus:setConfig', (_e, patch = {}) => {
    const clean = {};
    if ('durationMin' in patch) {
      clean.durationMin = Math.min(480, Math.max(1, Number(patch.durationMin) || 25));
    }
    if ('blockApps' in patch) clean.blockApps = !!patch.blockApps;
    if ('strictMode' in patch) clean.strictMode = !!patch.strictMode;
    if ('homeUrl' in patch) {
      const h = normalizeEntry(patch.homeUrl);
      if (h) clean.homeUrl = `https://${h}`;
    }
    store.set(clean);
    if ('blockApps' in clean) {
      if (clean.blockApps && focus.isEnforcing) watcher.start();
      if (!clean.blockApps) watcher.stop();
    }
    sendState();
    return buildState();
  });

  ipcMain.handle('focus:addSite', (_e, value) => {
    const res = store.addSite(value);
    sendState();
    return res;
  });
  ipcMain.handle('focus:removeSite', (_e, value) => {
    store.removeSite(value);
    sendState();
    return buildState();
  });

  ipcMain.handle('focus:addApp', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Allow an application',
      properties: ['openFile'],
      filters: [{ name: 'Programs', extensions: ['exe'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const out = store.addApp(path.basename(res.filePaths[0]));
    sendState();
    return out;
  });
  ipcMain.handle('focus:removeApp', (_e, value) => {
    store.removeApp(value);
    sendState();
    return buildState();
  });

  ipcMain.handle('focus:navigate', (_e, input) => {
    const url = resolveInput(input);
    if (!url) return { ok: false };
    if (!isUrlAllowed(url)) {
      loadInActiveTab(blockedUrlFor(url, 'site'));
      return { ok: false, blocked: true };
    }
    loadInActiveTab(url);
    return { ok: true };
  });

  ipcMain.handle('focus:newTab', (_e, url) => {
    const target = url ? resolveInput(url) : homeTarget();
    createTab(target && isUrlAllowed(target) ? target : homeTarget());
    return buildState();
  });

  ipcMain.handle('focus:closeTab', (_e, id) => { closeTab(id); return buildState(); });
  ipcMain.handle('focus:selectTab', (_e, id) => { selectTab(id); return buildState(); });

  ipcMain.handle('focus:goBack', () => {
    const t = activeTab();
    if (t && t.view.webContents.navigationHistory.canGoBack()) {
      t.view.webContents.navigationHistory.goBack();
    }
  });
  ipcMain.handle('focus:goForward', () => {
    const t = activeTab();
    if (t && t.view.webContents.navigationHistory.canGoForward()) {
      t.view.webContents.navigationHistory.goForward();
    }
  });
  ipcMain.handle('focus:reload', () => {
    const t = activeTab();
    if (t) t.view.webContents.reload();
  });
  ipcMain.handle('focus:stop', () => {
    const t = activeTab();
    if (t) t.view.webContents.stop();
  });

  ipcMain.handle('focus:getBlockInfo', () => ({
    ...lastBlock,
    isEnforcing: focus.isEnforcing,
    allowedSites: allowedSites(),
  }));

  // Adding a site mid-session is allowed while paused only. Otherwise the
  // block screen becomes a one-click bypass and the whole app is theater.
  ipcMain.handle('focus:allowBlockedSite', (_e, host) => {
    if (focus.isEnforcing) {
      return { ok: false, reason: 'Pause the session first to change your allowlist.' };
    }
    const res = store.addSite(host);
    if (res.ok || res.entry) loadInActiveTab(`https://${res.entry || normalizeEntry(host)}`);
    sendState();
    return res;
  });

  /** Aggregated day-by-day history for the activity charts. */
  ipcMain.handle('focus:getActivity', () => store.activity(365));

  ipcMain.handle('focus:openActivity', () => {
    showOverlay('activity');
    sendState();
    return buildState();
  });

  ipcMain.handle('focus:closeActivity', () => {
    // Return to wherever the user was: the setup screen if idle, the browser
    // if a session is running.
    if (focus.isActive) hideOverlay();
    else showOverlay('setup');
    sendState();
    return buildState();
  });

  ipcMain.handle('focus:minimize', () => {    // No minimize button exists during a session; this stays guarded anyway.
    if (focus.isEnforcing) {
      warnLocked();
      return;
    }
    // A kiosk window cannot minimize cleanly on Windows — it leaves a black
    // screen. Drop out of kiosk first, then restore it on the way back.
    if (win.isKiosk()) {
      win.setKiosk(false);
      win.once('restore', () => {
        win.setKiosk(true);
      });
    }
    win.minimize();
  });

  ipcMain.handle('focus:openSettings', () => {
    showOverlay('setup');
    sendState();
  });

  ipcMain.handle('focus:closeOverlay', () => {
    // The paused modal is not dismissible — Continue or Quit are the only ways
    // out, otherwise pausing would become a silent, permanent unblock.
    if (overlayPage === 'paused') return buildState();
    // Never let the user dismiss the setup screen into a browser with no
    // session and no allowlist — there'd be nothing to look at.
    if (!focus.isActive && !allowedSites().length) return buildState();
    hideOverlay();
    sendState();
    return buildState();
  });

  ipcMain.handle('focus:newSession', () => {
    returnToSetup = false;
    focus.reset();
    showOverlay('setup');
    sendState();
    return buildState();
  });

  /** Install a downloaded update. Only offered when no session is running. */
  ipcMain.handle('focus:installUpdate', () => {
    if (!updater || focus.isActive) return false;
    quitConfirmed = true;
    updater.quitAndInstall();
    return true;
  });

  ipcMain.handle('focus:quit', async () => {
    // Only reachable from the initial screen, where no session is running.
    if (focus.isEnforcing) {
      await warnLocked();
      return;
    }
    quitConfirmed = true;
    stopFocusGuard();
    app.quit();
  });
}

// ------------------------------------------------------------------ window

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  win = new BaseWindow({
    width,
    height,
    x: 0,
    y: 0,
    show: false,
    backgroundColor: '#08090a',
    title: 'Focus',
    icon: ICON,
    // No OS chrome at all. The app draws its own top bar, so a native title
    // bar would just be a second, uglier one.
    frame: false,
    // Kiosk is real fullscreen: covers the taskbar, no way to half-see the
    // desktop behind it. Plain `fullscreen` still leaves Windows UI reachable.
    // Always on, dev included — "fullscreen means fullscreen".
    kiosk: true,
    fullscreenable: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
  });

  chromeView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  win.contentView.addChildView(chromeView);
  chromeView.webContents.loadFile(path.join(RENDERER, 'chrome.html'));

  win.on('resize', layout);
  win.on('resized', layout);
  win.once('ready-to-show', () => win.show());

  attachShortcuts(chromeView.webContents);

  chromeView.webContents.once('did-finish-load', () => {
    win.show();
    win.focus();
    createTab(homeTarget());
    showOverlay('setup');
    sendState();
  });

  // In kiosk mode the taskbar is covered, so a stranded window would leave the
  // machine looking broken. Always release kiosk before the app goes away.
  const releaseKiosk = () => {
    try {
      if (win && !win.isDestroyed() && win.isKiosk()) win.setKiosk(false);
    } catch {}
  };

  // There is deliberately no close button. While the timer is running the
  // window refuses to close (Alt+F4 included) — the way out is to PAUSE, which
  // is a conscious act, not a reflex. Pausing also stops the clock, so quitting
  // mid-session can never be mistaken for finishing one.
  let teardown = false;
  win.on('close', (e) => {
    if (focus && focus.isEnforcing && !quitConfirmed) {
      e.preventDefault();
      warnLocked();
      return;
    }
    if (teardown) return; // second pass: let it through

    // Kiosk must be released BEFORE the window closes, not during. Calling
    // setKiosk(false) inside the close handler mutates window state mid-close,
    // which on Windows aborts the close and leaves a black, un-kiosked window.
    // So: cancel this close, drop kiosk, then close again on the next tick.
    if (win.isKiosk()) {
      e.preventDefault();
      teardown = true;
      win.setKiosk(false);
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 60);
    }
  });

  app.on('before-quit', releaseKiosk);
  process.on('exit', releaseKiosk);
  process.on('uncaughtException', (err) => {
    console.error('[focus] uncaught:', err);
    releaseKiosk();
  });

  // External protocol links (mailto:, etc.) never open silently.
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      if (!isDangerousScheme(url) && !focus.isEnforcing) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

/**
 * Keyboard shortcuts.
 *
 * These are handled per-window rather than with globalShortcut. A global
 * shortcut is registered OS-wide, so Ctrl+W would close a Focus tab while the
 * user was typing in another app entirely. Only Ctrl+Shift+P stays global,
 * because pausing needs to work when Focus is not in front.
 */
function handleShortcut(input) {
  const ctrl = input.control || input.meta;
  const key = (input.key || '').toLowerCase();
  if (input.type !== 'keyDown') return false;

  // NB: Alt+F4 is not handled here. Windows delivers it as a system command
  // (WM_SYSCOMMAND), so it never reaches before-input-event. The window's
  // 'close' handler is what actually refuses it during a session.

  if (ctrl && !input.shift && key === 't') {
    createTab(homeTarget());
    return true;
  }
  if (ctrl && !input.shift && key === 'w') {
    if (activeTabId != null) closeTab(activeTabId);
    return true;
  }
  if (ctrl && !input.shift && key === 'l') {
    if (chromeView) {
      chromeView.webContents.focus();
      chromeView.webContents.send('focus:focusAddressBar');
    }
    return true;
  }
  if (ctrl && !input.shift && key === 'r') {
    const t = activeTab();
    if (t) t.view.webContents.reload();
    return true;
  }
  if (ctrl && input.shift && key === 'p') {
    if (focus.status === 'paused') {
      focus.resume();
      hideOverlay();
    } else if (focus.status === 'running') {
      focus.pause();
      showOverlay('paused');
    }
    sendState();
    return true;
  }
  if (key === 'f11') {
    // Fullscreen is not optional. The only way out is Pause -> Quit session.
    console.log('[focus] F11 ignored — fullscreen is not optional');
    return true;
  }
  // Block Ctrl+Shift+I / F12 so the console can't be used to poke at the app.
  if ((ctrl && input.shift && key === 'i') || key === 'f12') return !DEV;
  return false;
}

function attachShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (handleShortcut(input)) event.preventDefault();
  });
}

/**
 * Keeps the window in front during a session.
 *
 * Reality check, measured rather than assumed: Windows reserves Alt+Tab and
 * refuses to hand it to `globalShortcut` (RegisterHotKey returns false), so it
 * CANNOT be swallowed. Ctrl+Alt+Del and Ctrl+Shift+Esc are kernel-level and
 * likewise unclaimable — deliberately so, and that is a good thing.
 *
 * What actually works is what full-screen games do: notice the window lost
 * focus and take it straight back. The switch still technically happens, but
 * it does not stick, so Alt+Tab stops being a usable way out.
 */
function startFocusGuard() {
  if (focusGuard) return;

  // These ARE claimable, so swallow them outright.
  for (const accel of ['Alt+Escape']) {
    try {
      globalShortcut.register(accel, () => {
        console.log(`[focus] swallowed ${accel} during session`);
      });
    } catch {}
  }

  win.setAlwaysOnTop(true, 'screen-saver');

  const reclaim = () => {
    if (!focus.isEnforcing || !win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.show();
    win.focus();
    win.moveTop();
  };

  const onBlur = () => {
    if (!focus.isEnforcing) return;
    console.log('[focus] focus lost during session — pulling back');
    // Small delay: taking focus back inside the blur handler fights the OS
    // switcher and can leave the window in a half-activated state.
    setTimeout(reclaim, 120);
  };

  const onMinimize = () => {
    if (!focus.isEnforcing) return;
    setTimeout(reclaim, 60);
  };

  win.on('blur', onBlur);
  win.on('minimize', onMinimize);

  // Safety net for switches that never emit blur (some shell transitions).
  const interval = setInterval(() => {
    if (!focus.isEnforcing) return;
    if (win && !win.isDestroyed() && !win.isFocused()) reclaim();
  }, 1200);
  if (interval.unref) interval.unref();

  focusGuard = { onBlur, onMinimize, interval };
}

function stopFocusGuard() {
  if (!focusGuard) return;
  try {
    globalShortcut.unregister('Alt+Escape');
  } catch {}
  try {
    win.off('blur', focusGuard.onBlur);
    win.off('minimize', focusGuard.onMinimize);
  } catch {}
  clearInterval(focusGuard.interval);
  focusGuard = null;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(false);
}

function registerShortcuts() {
  // Global on purpose: pause must be reachable from any app.
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (focus.status === 'paused') {
      focus.resume();
      hideOverlay();
    } else if (focus.status === 'running') {
      focus.pause();
      showOverlay('paused');
    }
    sendState();
  });
}

// -------------------------------------------------------------------- boot

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // Remove the default File/Edit/View/Window menu. Focus draws its own top
    // bar, and a native menu bar would look bolted on.
    Menu.setApplicationMenu(null);

    store = new Store();
    focus = new FocusSession();
    watcher = new AppWatcher({
      isAllowed: (exe) => {
        const list = store.get('allowedApps') || [];
        return list.includes(String(exe || '').toLowerCase());
      },
      isEnforcing: () => focus.isEnforcing && !!store.get('blockApps'),
      onAlert: () => sendState(),
    });

    focus.on('update', () => {
      // One place decides whether the window is locked in front, so pause,
      // resume, complete and expiry can never disagree about it.
      if (focus.isEnforcing) startFocusGuard();
      else stopFocusGuard();
      sendState();
    });
    focus.on('finished', (snap) => {
      store.recordSession(snap);
      watcher.stop();
      stopFocusGuard();
      // "End session" lands on the initial screen instead of the summary, so
      // the next step is Close (or start again) rather than another modal.
      if (!returnToSetup) showOverlay('summary');
      sendState();
    });

    installNetworkFilter();
    registerIpc();
    createWindow();
    registerShortcuts();

    // Auto-update from GitHub Releases. Never interrupts a running session.
    updater = initUpdater({
      isBusy: () => focus.isActive,
      onChange: () => sendState(),
      getWindow: () => win,
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (watcher) watcher.stop();
  });
}
