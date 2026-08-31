'use strict';

/**
 * Renderer smoke test.
 *
 * Loads every UI page in a real Electron renderer and fails on any console
 * error, uncaught exception, or missing DOM.
 *
 * This exists because a single top-level SyntaxError silently blanks an entire
 * view — the app still "runs", the window is just empty. That is invisible to
 * the main-process tests and easy to miss by eye.
 *
 *   npm run test:renderer
 */

const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const results = [];
function check(name, pass, extra = '') {
  results.push({ name, pass, extra });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'index.js');

const PAGES = [
  { file: 'chrome.html', search: '', mustFind: ['#tabs', '#timer', '#address', '#status'] },
  { file: 'setup.html', search: '', mustFind: ['#durations', '#siteInput', '#start'] },
  {
    file: 'blocked.html',
    search: 'host=example.com&reason=site',
    mustFind: ['#title', '#host', '#actions'],
  },
  { file: 'summary.html', search: '', mustFind: ['#focused', '#pauses', '#today'] },
  { file: 'paused.html', search: '', mustFind: ['#remaining', '#resume', '#quit'] },
  {
    file: 'activity.html',
    search: '',
    mustFind: ['#heat', '#bars', '#figToday', '#figStreak', '#close'],
  },
  {
    file: 'chat.html',
    search: '',
    mustFind: ['#log', '#input', '#send', '#settingsBtn', '#modelBtn'],
  },
];

const STATE = {
  session: {
    status: 'running',
    durationMs: 3_000_000,
    remainingMs: 1_500_000,
    elapsedMs: 1_500_000,
    endsAt: Date.now() + 1_500_000,
    startedAt: Date.now() - 1_500_000,
    finishedAt: 0,
    pauseCount: 1,
    pausedMs: 0,
    endedEarly: false,
    isActive: true,
    isEnforcing: true,
  },
  config: {
    durationMin: 50,
    allowedSites: ['github.com', 'wikipedia.org'],
    allowedApps: ['code.exe'],
    blockApps: true,
    strictMode: false,
    homeUrl: 'https://duckduckgo.com',
  },
  stats: { todayCount: 2, todayMs: 5_400_000, totalCount: 9, totalMs: 20_000_000 },
  tabs: [{ id: 1, title: 'Example', url: 'https://example.com', active: true, blocked: false }],
  nav: { url: 'https://example.com', canGoBack: true, canGoForward: false, loading: false },
  appAlert: null,
};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  ipcMain.handle('focus:getState', () => STATE);
  ipcMain.handle('focus:getBlockInfo', () => ({
    host: 'example.com',
    url: 'https://example.com',
    reason: 'site',
    isEnforcing: true,
    allowedSites: STATE.config.allowedSites,
  }));

  // A year of days with a few active ones, so the charts have something real
  // to draw.
  ipcMain.handle('focus:getActivity', () => {
    const days = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 364; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const p = (n) => String(n).padStart(2, '0');
      const active = i % 3 === 0 && i < 40;
      days.push({
        date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
        ms: active ? (i % 7) * 900_000 + 600_000 : 0,
        sessions: active ? 1 + (i % 3) : 0,
        dow: d.getDay(),
      });
    }
    return {
      days,
      bestDayMs: 6 * 900_000 + 600_000,
      activeDays: days.filter((d) => d.ms > 0).length,
      totalMs: days.reduce((a, d) => a + d.ms, 0),
      currentStreak: 2,
      longestStreak: 5,
    };
  });

  // Chat panel needs its AI config channels stubbed.
  ipcMain.handle('ai:getConfig', () => ({
    baseUrl: 'https://roxy.gg/v1',
    model: 'openai/gpt-5.6-sol',
    hasKey: true,
    keyHint: 'rx-ab…7f9c',
    encryptionAvailable: true,
    skills: [{ id: 'demo', name: 'demo', description: 'A demo skill', chars: 100 }],
    mcp: [],
  }));
  ipcMain.handle('ai:listModels', () => ({ ok: true, models: [] }));

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });

  let problems = [];
  win.webContents.on('console-message', (event) => {
    const level = event.level;
    const message = event.message || '';
    if (/Electron Security Warning/i.test(message)) return;
    if (level === 'error' || level === 3) problems.push(message);
  });
  win.webContents.on('preload-error', (_e, _p, err) => {
    problems.push('preload: ' + err.message);
  });

  for (const page of PAGES) {
    problems = [];

    try {
      const opts = page.search ? { search: page.search } : undefined;
      await win.webContents.loadFile(path.join(RENDERER, page.file), opts);
    } catch (err) {
      problems.push('load failed: ' + err.message);
    }

    await new Promise((r) => setTimeout(r, 600));

    check(`${page.file}: no console errors`, problems.length === 0, problems[0] || '');

    for (const sel of page.mustFind) {
      let found = false;
      try {
        found = await win.webContents.executeJavaScript(
          `!!document.querySelector(${JSON.stringify(sel)})`
        );
      } catch {
        found = false;
      }
      check(`${page.file}: renders ${sel}`, found === true);
    }

    // Layout assertions for the chrome bar: the + must sit next to the tabs
    // (like a real browser), and there must be no close/minimize buttons.
    if (page.file === 'chrome.html') {
      const probe = [
        'JSON.stringify((function () {',
        '  var tabs = document.getElementById("tabs").getBoundingClientRect();',
        '  var plus = document.getElementById("newTab").getBoundingClientRect();',
        '  var timer = document.getElementById("timer").getBoundingClientRect();',
        '  return {',
        '    gap: Math.round(plus.left - tabs.right),',
        '    plusLeft: Math.round(plus.left),',
        '    timerRight: Math.round(timer.right),',
        '    width: window.innerWidth,',
        '    hasClose: !!document.getElementById("winClose"),',
        '    hasMin: !!document.getElementById("winMin")',
        '  };',
        '})())',
      ].join('\n');

      let g = null;
      try {
        g = JSON.parse(await win.webContents.executeJavaScript(probe));
      } catch (err) {
        check('chrome.html: layout probe ran', false, err.message);
      }

      if (g) {
        check(
          'chrome.html: + sits immediately after the tabs',
          g.gap >= 0 && g.gap <= 12,
          `gap=${g.gap}px`
        );
        check(
          'chrome.html: + is on the left, not floated right',
          g.plusLeft < g.width / 2,
          `plusLeft=${g.plusLeft} of ${g.width}`
        );
        check(
          'chrome.html: timer is pinned far right',
          g.timerRight > g.width - 40,
          `timerRight=${g.timerRight} of ${g.width}`
        );
        check('chrome.html: no close button exists', g.hasClose === false);
        check('chrome.html: no minimize button exists', g.hasMin === false);
      }

      // Spacing. These guard against the chrome feeling glued together, and
      // against the CSS height drifting away from CHROME_HEIGHT in main —
      // if those disagree, the page view overlaps the bar.
      const space = [
        'JSON.stringify((function () {',
        '  var strip = document.querySelector(".strip").getBoundingClientRect();',
        '  var tabs = document.getElementById("tabs").getBoundingClientRect();',
        '  var plus = document.getElementById("newTab").getBoundingClientRect();',
        '  var timer = document.getElementById("timer").getBoundingClientRect();',
        '  var addr = document.getElementById("address").getBoundingClientRect();',
        '  return {',
        '    stripHeight: Math.round(strip.height),',
        '    plusToTimer: Math.round(timer.left - plus.right),',
        '    tabsTop: Math.round(tabs.top),',
        '    addrBottomGap: Math.round(strip.bottom - addr.bottom),',
        '    rowGap: Math.round(addr.top - tabs.bottom)',
        '  };',
        '})())',
      ].join('\n');

      let sp = null;
      try {
        sp = JSON.parse(await win.webContents.executeJavaScript(space));
      } catch (err) {
        check('chrome.html: spacing probe ran', false, err.message);
      }
      if (sp) {
        check(
          'chrome.html: strip height matches CHROME_HEIGHT (88)',
          sp.stripHeight === 88,
          `height=${sp.stripHeight}`
        );
        check(
          'chrome.html: timer is not glued to the tabs',
          sp.plusToTimer >= 16,
          `gap=${sp.plusToTimer}px`
        );
        check(
          'chrome.html: address bar is not glued to the page',
          sp.addrBottomGap >= 12,
          `gap=${sp.addrBottomGap}px`
        );
        check('chrome.html: tabs have room above', sp.tabsTop >= 8, `top=${sp.tabsTop}px`);
        check('chrome.html: the two rows are separated', sp.rowGap >= 6, `gap=${sp.rowGap}px`);
      }
    }

    // The paused modal is the ONE sanctioned exit, so its layout matters:
    // Continue must be the primary action on the right; Quit secondary on the
    // left, so it cannot be hit by reflex.
    if (page.file === 'paused.html') {
      const probe = [
        'JSON.stringify((function () {',
        '  var q = document.getElementById("quit").getBoundingClientRect();',
        '  var r = document.getElementById("resume").getBoundingClientRect();',
        '  return {',
        '    quitLeftOfResume: q.left < r.left,',
        '    resumeIsPrimary: document.getElementById("resume").className.indexOf("btn-primary") !== -1,',
        '    quitIsSecondary: document.getElementById("quit").className.indexOf("btn-primary") === -1',
        '  };',
        '})())',
      ].join('\n');

      let g = null;
      try {
        g = JSON.parse(await win.webContents.executeJavaScript(probe));
      } catch (err) {
        check('paused.html: layout probe ran', false, err.message);
      }
      if (g) {
        check('paused.html: End session sits left of Continue', g.quitLeftOfResume === true);
        check('paused.html: Continue is the primary action', g.resumeIsPrimary === true);
        check('paused.html: End session is not primary', g.quitIsSecondary === true);
      }
    }

    // The initial screen must always offer a real way out of the app.
    if (page.file === 'setup.html') {
      const probe = [
        'JSON.stringify((function () {',
        '  var c = document.getElementById("cancel");',
        '  var s = document.getElementById("start");',
        '  return {',
        '    cancelExists: !!c,',
        '    cancelHidden: c ? c.hidden : true,',
        '    cancelText: c ? c.textContent.trim() : "",',
        '    startLeftOfCancel: (c && s) ? (s.getBoundingClientRect().left > c.getBoundingClientRect().left) : false',
        '  };',
        '})())',
      ].join('\n');

      let g = null;
      try {
        g = JSON.parse(await win.webContents.executeJavaScript(probe));
      } catch (err) {
        check('setup.html: layout probe ran', false, err.message);
      }
      if (g) {
        check('setup.html: a close/quit button exists', g.cancelExists === true);
        check('setup.html: it is visible', g.cancelHidden === false);
        check('setup.html: Start sits right of it', g.startLeftOfCancel === true);
      }
    }

    // The charts are canvas, so "renders" isn't enough — assert they actually
    // drew pixels, otherwise a broken draw call looks identical to a blank one.
    if (page.file === 'activity.html') {
      const probe = [
        'JSON.stringify((function () {',
        '  function painted(id) {',
        '    var c = document.getElementById(id);',
        '    if (!c || !c.width) return 0;',
        '    var d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;',
        '    var n = 0;',
        '    for (var i = 3; i < d.length; i += 4) { if (d[i] > 0) n++; }',
        '    return n;',
        '  }',
        '  return {',
        '    heat: painted("heat"),',
        '    bars: painted("bars"),',
        '    legend: painted("legend"),',
        '    today: (document.getElementById("figToday").textContent || "").trim()',
        '  };',
        '})())',
      ].join('\n');

      let g = null;
      try {
        g = JSON.parse(await win.webContents.executeJavaScript(probe));
      } catch (err) {
        check('activity.html: chart probe ran', false, err.message);
      }
      if (g) {
        check('activity.html: heatmap drew pixels', g.heat > 500, `px=${g.heat}`);
        check('activity.html: bar chart drew pixels', g.bars > 500, `px=${g.bars}`);
        check('activity.html: legend drew pixels', g.legend > 20, `px=${g.legend}`);
        check('activity.html: figures show a value', g.today.length > 0, `today="${g.today}"`);
      }
    }

    // The chat log must actually scroll. It's a flex child, and flex items
    // default to min-height:auto — without min-height:0 the log grows to fit
    // its content and overflow-y never engages, which is exactly the bug this
    // pins. Assert by overflowing it and checking scrollHeight > clientHeight.
    if (page.file === 'chat.html') {
      const probe = [
        'JSON.stringify((function () {',
        '  var log = document.getElementById("log");',
        '  var empty = log.querySelector(".empty");',
        '  if (empty) empty.remove();',
        '  for (var i = 0; i < 60; i++) {',
        '    var m = document.createElement("div");',
        '    m.className = "msg assistant";',
        '    m.innerHTML = "<div class=\\"bubble\\">line " + i + "</div>";',
        '    log.appendChild(m);',
        '  }',
        '  log.scrollTop = log.scrollHeight;',
        '  return {',
        '    scrollable: log.scrollHeight > log.clientHeight + 10,',
        '    scrolled: log.scrollTop > 0,',
        '    logH: log.clientHeight,',
        '    contentH: log.scrollHeight,',
        '    bodyH: document.body.clientHeight,',
        '    composerVisible: document.getElementById("composer").getBoundingClientRect().bottom <= document.body.clientHeight + 2',
        '  };',
        '})())',
      ].join('\n');

      let g = null;
      try {
        g = JSON.parse(await win.webContents.executeJavaScript(probe));
      } catch (err) {
        check('chat.html: scroll probe ran', false, err.message);
      }
      if (g) {
        check(
          'chat.html: log scrolls when it overflows',
          g.scrollable === true,
          `content=${g.contentH} view=${g.logH}`
        );
        check('chat.html: log can be scrolled down', g.scrolled === true, `top=${g.scrolled}`);
        check(
          'chat.html: log does not push the composer off-screen',
          g.composerVisible === true,
          `bodyH=${g.bodyH}`
        );
      }
    }

    // Every icon placeholder should have been filled with an <svg>.
    let emptyIcons = -1;
    try {
      emptyIcons = await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.icon-btn, .win-btn, .new-tab'))` +
          `.filter(function (b) { return !b.querySelector('svg'); }).length`
      );
    } catch {
      emptyIcons = -1;
    }
    check(`${page.file}: icon buttons all have an svg`, emptyIcons === 0, `empty=${emptyIcons}`);
  }

  win.destroy();

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
