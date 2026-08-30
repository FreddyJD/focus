'use strict';

/**
 * Window-lock test.
 *
 * Verifies the "no easy way out" contract at the window level: while a session
 * is enforcing, a close request must be REFUSED; once paused, it must succeed
 * and must not leave a kiosk window stranded over the taskbar.
 *
 * This is driven in-process rather than by synthesizing Alt+F4, because a
 * kiosk window refuses programmatic foreground activation, so simulated input
 * never reaches it. win.close() is exactly what Alt+F4 triggers internally.
 *
 *   npm run test:lock
 */

const { app, BaseWindow } = require('electron');

const results = [];
function check(name, pass, extra = '') {
  results.push({ name, pass, extra });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

// Mirrors the real guard in src/main/index.js.
let enforcing = true;
let quitConfirmed = false;
let warned = 0;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  // Closing the last window would fire window-all-closed and quit the app
  // before the remaining assertions run.
  app.on('window-all-closed', () => {});

  const win = new BaseWindow({
    width: 800,
    height: 600,
    show: false,
    frame: false,
    // Kiosk is skipped here: this asserts the guard logic, and a real kiosk
    // window would take over the test machine's screen.
    kiosk: false,
  });

  let teardown = false;
  win.on('close', (e) => {
    if (enforcing && !quitConfirmed) {
      e.preventDefault();
      warned += 1;
      return;
    }
    if (teardown) return;
    if (win.isKiosk()) {
      e.preventDefault();
      teardown = true;
      win.setKiosk(false);
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 60);
    }
  });

  // --- 1. close is refused while enforcing ---
  win.close();
  await new Promise((r) => setTimeout(r, 150));
  check('close refused while session is running', !win.isDestroyed(), `warned=${warned}`);
  check('user was told why', warned === 1, `warned=${warned}`);

  // --- 2. repeated attempts stay refused ---
  win.close();
  win.close();
  await new Promise((r) => setTimeout(r, 150));
  check('repeated closes still refused', !win.isDestroyed(), `warned=${warned}`);

  // --- 3. pausing releases the lock ---
  enforcing = false;
  win.close();
  await new Promise((r) => setTimeout(r, 400));
  check('close succeeds once paused', win.isDestroyed());

  // --- 4. kiosk is dropped before the window goes away ---
  let releasedBeforeClose = false;
  const win2 = new BaseWindow({ width: 400, height: 300, show: false, frame: false });
  let teardown2 = false;
  win2.on('close', (e) => {
    if (teardown2) return;
    if (win2.isKiosk()) {
      e.preventDefault();
      teardown2 = true;
      win2.setKiosk(false);
      releasedBeforeClose = !win2.isKiosk();
      setTimeout(() => {
        if (!win2.isDestroyed()) win2.destroy();
      }, 60);
    }
  });
  win2.setKiosk(true);
  await new Promise((r) => setTimeout(r, 250));
  win2.close();
  await new Promise((r) => setTimeout(r, 500));
  check('kiosk released before window closes', releasedBeforeClose === true);
  check('kiosk window does close', win2.isDestroyed());

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
