'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FocusSession } = require('../src/main/session');

/**
 * The "no easy way out" contract.
 *
 * The app deliberately has no close or minimize button while a session runs.
 * These tests pin the state machine that every one of those guards keys off,
 * so the lock can't be weakened by accident later.
 */

test('enforcing is true while running — the window must stay locked', () => {
  const s = new FocusSession();
  s.start(50 * 60_000);
  assert.equal(s.isEnforcing, true, 'running session must enforce');
  s.reset();
});

test('pause is the ONLY way to unlock, and it stops the clock', async () => {
  const s = new FocusSession();
  s.start(50 * 60_000);
  assert.equal(s.isEnforcing, true);

  s.pause();
  assert.equal(s.isEnforcing, false, 'pausing must release the lock');

  // Pausing has to stop the clock too, otherwise "pause to quit" would still
  // bank focus time the user did not actually do.
  const frozen = s.remainingMs();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.remainingMs(), frozen, 'paused clock must not advance');
  s.reset();
});

test('resuming re-locks the window', () => {
  const s = new FocusSession();
  s.start(10 * 60_000);
  s.pause();
  assert.equal(s.isEnforcing, false);
  s.resume();
  assert.equal(s.isEnforcing, true, 'resume must restore the lock');
  s.reset();
});

test('completing unlocks', () => {
  const s = new FocusSession();
  s.start(10 * 60_000);
  s.complete(true);
  assert.equal(s.isEnforcing, false);
  assert.equal(s.isActive, false);
  s.reset();
});

test('an idle session never locks the window', () => {
  const s = new FocusSession();
  assert.equal(s.isEnforcing, false);
  assert.equal(s.isActive, false);
});

test('natural expiry unlocks without user action', () => {
  const s = new FocusSession();
  s.start(60_000);
  assert.equal(s.isEnforcing, true);
  s.endsAt = Date.now() - 1;
  s.tick();
  assert.equal(s.isEnforcing, false, 'expired session must not stay locked');
  s.reset();
});
