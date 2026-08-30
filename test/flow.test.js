'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FocusSession } = require('../src/main/session');

/**
 * The exit flow, pinned end to end.
 *
 * Leaving Focus is deliberately three separate decisions:
 *
 *   1. Pause          -> modal appears, blocking off, clock stopped
 *   2. End session    -> back to the INITIAL SCREEN (app stays open)
 *   3. Quit Focus     -> app actually closes
 *
 * Each step is reversible except the last, and no single click ever takes you
 * from "focusing" to "app gone".
 */

// Mirrors the main-process wiring so the sequence can be asserted without
// spinning up a window.
function makeApp() {
  const session = new FocusSession();
  const state = { overlay: null, quit: false, returnToSetup: false };

  session.on('finished', () => {
    if (!state.returnToSetup) state.overlay = 'summary';
  });

  return {
    session,
    state,
    start(min) {
      state.returnToSetup = false;
      session.start(min * 60_000);
      state.overlay = null;
    },
    pause() {
      session.pause();
      state.overlay = 'paused';
    },
    resume() {
      session.resume();
      state.overlay = null;
    },
    endSession() {
      state.returnToSetup = true;
      session.complete(true);
      session.reset();
      state.overlay = 'setup';
    },
    quitApp() {
      // Guarded in main: only reachable when not enforcing.
      if (session.isEnforcing) return false;
      state.quit = true;
      return true;
    },
  };
}

test('pause opens the modal, stops the clock, and lifts blocking', () => {
  const app = makeApp();
  app.start(50);
  assert.equal(app.state.overlay, null, 'no overlay while focusing');

  app.pause();
  assert.equal(app.state.overlay, 'paused');
  assert.equal(app.session.isEnforcing, false, 'paused means not blocking');
  assert.equal(app.session.status, 'paused');
});

test('Continue returns to browsing and re-locks', () => {
  const app = makeApp();
  app.start(50);
  app.pause();
  app.resume();

  assert.equal(app.state.overlay, null, 'modal dismissed');
  assert.equal(app.session.isEnforcing, true, 'blocking resumes');
  assert.equal(app.state.quit, false, 'app never closed');
});

test('End session lands on the initial screen — it does NOT quit', () => {
  const app = makeApp();
  app.start(50);
  app.pause();
  app.endSession();

  assert.equal(app.state.overlay, 'setup', 'must land on the start screen');
  assert.equal(app.state.quit, false, 'app must stay open');
  assert.equal(app.session.status, 'idle', 'session is cleared');
  assert.equal(app.session.isEnforcing, false);
});

test('End session shows the start screen, not the summary', () => {
  const app = makeApp();
  app.start(50);
  app.pause();
  app.endSession();
  assert.equal(app.state.overlay, 'setup');
  assert.notEqual(app.state.overlay, 'summary');
});

test('letting the timer expire DOES show the summary', () => {
  const app = makeApp();
  app.start(1);
  app.session.endsAt = Date.now() - 1;
  app.session.tick();
  assert.equal(app.state.overlay, 'summary', 'natural end earns the summary');
});

test('Quit only works from the initial screen', () => {
  const app = makeApp();
  app.start(50);

  // Mid-session: refused.
  assert.equal(app.quitApp(), false, 'cannot quit while focusing');
  assert.equal(app.state.quit, false);

  // Pause alone is not enough to be "out", but it does unlock.
  app.pause();
  app.endSession();

  // Now on the initial screen, quitting is allowed.
  assert.equal(app.quitApp(), true);
  assert.equal(app.state.quit, true);
});

test('the full journey takes three deliberate steps', () => {
  const app = makeApp();
  const steps = [];

  app.start(50);
  steps.push(app.state.overlay); // null (focusing)
  app.pause();
  steps.push(app.state.overlay); // paused
  app.endSession();
  steps.push(app.state.overlay); // setup
  app.quitApp();
  steps.push(app.state.quit ? 'quit' : 'open');

  assert.deepEqual(steps, [null, 'paused', 'setup', 'quit']);
});
