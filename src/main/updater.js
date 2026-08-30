'use strict';

const { app, dialog } = require('electron');

/**
 * Auto-update against GitHub Releases.
 *
 * Deliberately quiet: a focus app must never interrupt a session. Updates are
 * downloaded in the background and only ever installed when the user is idle
 * and chooses to. Nothing here can steal focus mid-session.
 */
let autoUpdater = null;
let state = {
  checking: false,
  available: false,
  downloaded: false,
  version: null,
  error: null,
};

function load() {
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return null;
  }

  // We prompt the user ourselves rather than quitting under them.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  return autoUpdater;
}

/**
 * @param {object} opts
 * @param {() => boolean} opts.isBusy      true while a session is running
 * @param {() => void}    opts.onChange    called when update state changes
 * @param {import('electron').BaseWindow} opts.getWindow
 */
function initUpdater({ isBusy, onChange = () => {}, getWindow = () => null }) {
  // Updates only make sense in a packaged build; in dev there's no signature
  // and electron-updater would just throw on every launch.
  if (!app.isPackaged) return { state, checkNow: () => {}, quitAndInstall: () => {} };

  const updater = load();
  if (!updater) return { state, checkNow: () => {}, quitAndInstall: () => {} };

  const change = (patch) => {
    state = { ...state, ...patch };
    onChange(state);
  };

  updater.on('checking-for-update', () => change({ checking: true, error: null }));
  updater.on('update-not-available', () => change({ checking: false, available: false }));
  updater.on('update-available', (info) =>
    change({ checking: false, available: true, version: info && info.version })
  );
  updater.on('error', (err) =>
    change({ checking: false, error: (err && err.message) || String(err) })
  );

  updater.on('update-downloaded', async (info) => {
    change({ downloaded: true, checking: false, version: info && info.version });

    // Never interrupt a running session — the install offer waits.
    if (isBusy()) return;

    const win = getWindow();
    const opts = {
      type: 'info',
      buttons: ['Later', 'Restart now'],
      defaultId: 1,
      cancelId: 0,
      title: 'Update ready',
      message: `Focus ${info && info.version ? info.version : ''} is ready to install.`,
      detail: 'The update installs when you restart. Your settings are kept.',
    };

    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);

    if (response === 1) {
      setImmediate(() => updater.quitAndInstall(false, true));
    }
  });

  const checkNow = () => {
    try {
      updater.checkForUpdates();
    } catch (err) {
      change({ error: err.message });
    }
  };

  // First check shortly after launch, then every 6 hours.
  setTimeout(checkNow, 8000).unref?.();
  const timer = setInterval(checkNow, 6 * 60 * 60 * 1000);
  timer.unref?.();

  return {
    get state() {
      return state;
    },
    checkNow,
    quitAndInstall: () => updater.quitAndInstall(false, true),
  };
}

module.exports = { initUpdater };
