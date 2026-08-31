'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FocusSession } = require('../src/main/session');

/**
 * Honest elapsed time.
 *
 * The original bug: elapsed was derived as `duration - remaining`, and a
 * finished session has no remaining time, so quitting a 25-minute session
 * after 30 seconds was recorded as a full 25 minutes. Real data showed a
 * 0.6-minute session stored as 25 minutes.
 *
 * The rule now: elapsed is wall-clock spent RUNNING, never more.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('quitting early records only the time actually spent', async () => {
  const s = new FocusSession();
  s.start(25 * 60_000);
  await wait(120);
  s.complete(true);

  const snap = s.snapshot();
  assert.ok(
    snap.elapsedMs < 2_000,
    `expected a fraction of a second, got ${snap.elapsedMs}ms`
  );
  assert.ok(snap.elapsedMs >= 100, `expected at least the time waited, got ${snap.elapsedMs}ms`);
  s.reset();
});

test('elapsed never exceeds wall-clock between start and finish', async () => {
  const s = new FocusSession();
  s.start(60 * 60_000); // an hour
  await wait(150);
  s.complete(true);

  const snap = s.snapshot();
  const wall = snap.finishedAt - snap.startedAt;
  assert.ok(
    snap.elapsedMs <= wall + 50,
    `elapsed ${snap.elapsedMs}ms exceeds wall-clock ${wall}ms`
  );
  s.reset();
});

test('paused time is not counted as focus', async () => {
  const s = new FocusSession();
  s.start(25 * 60_000);
  await wait(100);
  s.pause();

  const atPause = s.elapsedMs();
  await wait(200); // idle time that must NOT be banked
  assert.equal(s.elapsedMs(), atPause, 'clock must not advance while paused');

  s.resume();
  await wait(100);
  s.complete(true);

  const snap = s.snapshot();
  assert.ok(snap.elapsedMs < 400, `paused time leaked in: ${snap.elapsedMs}ms`);
  assert.ok(snap.elapsedMs >= 180, `focused time lost: ${snap.elapsedMs}ms`);
  s.reset();
});

test('a session that runs its full length reports roughly its duration', () => {
  const s = new FocusSession();
  s.start(60_000);

  // Simulate the minute passing without waiting for it.
  s._focusedMs = 60_000;
  s._runningSince = Date.now();
  s.endsAt = Date.now() - 1;
  s.tick();

  const snap = s.snapshot();
  assert.equal(snap.status, 'done');
  assert.equal(snap.endedEarly, false);
  assert.ok(snap.elapsedMs >= 60_000, `expected ~60s, got ${snap.elapsedMs}ms`);
  assert.ok(snap.elapsedMs < 61_000, `expected ~60s, got ${snap.elapsedMs}ms`);
  s.reset();
});

test('elapsed grows while running and stops when done', async () => {
  const s = new FocusSession();
  s.start(25 * 60_000);
  await wait(80);
  const mid = s.elapsedMs();
  assert.ok(mid > 0, 'should accumulate while running');

  await wait(80);
  assert.ok(s.elapsedMs() > mid, 'should keep growing while running');

  s.complete(true);
  const done = s.elapsedMs();
  await wait(80);
  assert.equal(s.elapsedMs(), done, 'must freeze once finished');
  s.reset();
});

test('a fresh session starts at zero', () => {
  const s = new FocusSession();
  assert.equal(s.elapsedMs(), 0);
  s.start(25 * 60_000);
  assert.ok(s.elapsedMs() < 50, 'should start near zero');
  s.reset();
  assert.equal(s.elapsedMs(), 0);
});
