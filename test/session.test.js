'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FocusSession } = require('../src/main/session');

test('starts running and counts down', () => {
  const s = new FocusSession();
  s.start(25 * 60_000);
  assert.equal(s.status, 'running');
  assert.equal(s.isEnforcing, true);
  assert.ok(s.remainingMs() > 24 * 60_000);
  s.reset();
});

test('pause stops enforcing and freezes the clock', async () => {
  const s = new FocusSession();
  s.start(10 * 60_000);
  s.pause();

  assert.equal(s.status, 'paused');
  // The core promise: paused means genuinely not blocking.
  assert.equal(s.isEnforcing, false);

  const frozen = s.remainingMs();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.remainingMs(), frozen, 'clock must not move while paused');
  s.reset();
});

test('resume restores enforcement and does not lose time', async () => {
  const s = new FocusSession();
  s.start(10 * 60_000);
  s.pause();
  const frozen = s.remainingMs();

  await new Promise((r) => setTimeout(r, 80));
  s.resume();

  assert.equal(s.status, 'running');
  assert.equal(s.isEnforcing, true);
  // Time spent paused is not deducted from the session.
  assert.ok(Math.abs(s.remainingMs() - frozen) < 50);
  assert.ok(s.pausedMs >= 60);
  s.reset();
});

test('toggle flips between running and paused', () => {
  const s = new FocusSession();
  s.start(60_000);
  s.toggle();
  assert.equal(s.status, 'paused');
  s.toggle();
  assert.equal(s.status, 'running');
  s.reset();
});

test('complete ends the session and stops blocking', () => {
  const s = new FocusSession();
  s.start(60_000);
  s.complete(true);
  assert.equal(s.status, 'done');
  assert.equal(s.isEnforcing, false);
  assert.equal(s.isActive, false);
  assert.equal(s.endedEarly, true);
  assert.equal(s.remainingMs(), 0);
  s.reset();
});

test('natural expiry is not marked as ended early', () => {
  const s = new FocusSession();
  let finished = null;
  s.on('finished', (snap) => { finished = snap; });

  s.start(60_000);
  s.endsAt = Date.now() - 1; // force the deadline to have passed
  s.tick();

  assert.ok(finished, 'finished event should fire');
  assert.equal(finished.endedEarly, false);
  assert.equal(finished.status, 'done');
  assert.equal(s.isEnforcing, false);
  s.reset();
});

test('pause count is tracked', () => {
  const s = new FocusSession();
  s.start(60_000);
  s.pause(); s.resume();
  s.pause(); s.resume();
  assert.equal(s.pauseCount, 2);
  s.reset();
});

test('extend adds time to a running session', () => {
  const s = new FocusSession();
  s.start(60_000);
  const before = s.remainingMs();
  s.extend(30_000);
  assert.ok(s.remainingMs() - before > 29_000);
  s.reset();
});

test('idle session is not enforcing', () => {
  const s = new FocusSession();
  assert.equal(s.status, 'idle');
  assert.equal(s.isEnforcing, false);
  assert.equal(s.remainingMs(), 0);
});

test('minimum duration is one minute', () => {
  const s = new FocusSession();
  s.start(5);
  assert.ok(s.durationMs >= 60_000);
  s.reset();
});
