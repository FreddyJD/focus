'use strict';

const { EventEmitter } = require('node:events');

const IDLE = 'idle';
const RUNNING = 'running';
const PAUSED = 'paused';
const DONE = 'done';

/**
 * Focus session timer.
 *
 * Deliberately free of Electron imports so it can be unit tested. Time is
 * tracked with absolute timestamps rather than by decrementing a counter, so
 * the clock stays correct across system sleep and slow event loops.
 */
class FocusSession extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this.reset();
  }

  reset() {
    this._stopTimer();
    this.status = IDLE;
    this.durationMs = 0;
    this.endsAt = 0;
    this.frozenMs = 0;
    this.startedAt = 0;
    this.finishedAt = 0;
    this.pauseCount = 0;
    this.pausedMs = 0;
    this._pauseStartedAt = 0;
    this.endedEarly = false;
    this._emit();
  }

  start(durationMs) {
    const ms = Math.max(60_000, Math.round(Number(durationMs) || 0));
    this._stopTimer();
    this.status = RUNNING;
    this.durationMs = ms;
    this.startedAt = Date.now();
    this.endsAt = this.startedAt + ms;
    this.frozenMs = 0;
    this.finishedAt = 0;
    this.pauseCount = 0;
    this.pausedMs = 0;
    this._pauseStartedAt = 0;
    this.endedEarly = false;
    this._startTimer();
    this._emit();
  }

  pause() {
    if (this.status !== RUNNING) return;
    this._stopTimer();
    this.frozenMs = Math.max(0, this.endsAt - Date.now());
    this.status = PAUSED;
    this.pauseCount += 1;
    this._pauseStartedAt = Date.now();
    this._emit();
  }

  resume() {
    if (this.status !== PAUSED) return;
    if (this._pauseStartedAt) {
      this.pausedMs += Date.now() - this._pauseStartedAt;
      this._pauseStartedAt = 0;
    }
    this.endsAt = Date.now() + this.frozenMs;
    this.status = RUNNING;
    this._startTimer();
    this._emit();
  }

  toggle() {
    if (this.status === RUNNING) this.pause();
    else if (this.status === PAUSED) this.resume();
  }

  /** Add time to a running or paused session. */
  extend(ms) {
    const add = Math.round(Number(ms) || 0);
    if (!add) return;
    if (this.status === RUNNING) this.endsAt += add;
    else if (this.status === PAUSED) this.frozenMs = Math.max(0, this.frozenMs + add);
    else return;
    this.durationMs += add;
    this._emit();
  }

  /** Finish now. `early` distinguishes "I'm done" from the timer running out. */
  complete(early = true) {
    if (this.status !== RUNNING && this.status !== PAUSED) return;
    if (this.status === PAUSED && this._pauseStartedAt) {
      this.pausedMs += Date.now() - this._pauseStartedAt;
      this._pauseStartedAt = 0;
    }
    this._stopTimer();
    this.status = DONE;
    this.endedEarly = !!early;
    this.finishedAt = Date.now();
    this.frozenMs = 0;
    this._emit();
    this.emit('finished', this.snapshot());
  }

  get isActive() {
    return this.status === RUNNING || this.status === PAUSED;
  }

  /** True only when blocking should be enforced. Paused means unblocked. */
  get isEnforcing() {
    return this.status === RUNNING;
  }

  remainingMs() {
    if (this.status === RUNNING) return Math.max(0, this.endsAt - Date.now());
    if (this.status === PAUSED) return Math.max(0, this.frozenMs);
    return 0;
  }

  elapsedMs() {
    return Math.max(0, this.durationMs - this.remainingMs());
  }

  snapshot() {
    return {
      status: this.status,
      durationMs: this.durationMs,
      remainingMs: this.remainingMs(),
      elapsedMs: this.elapsedMs(),
      endsAt: this.status === RUNNING ? this.endsAt : 0,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      pauseCount: this.pauseCount,
      pausedMs: this.pausedMs,
      endedEarly: this.endedEarly,
      isActive: this.isActive,
      isEnforcing: this.isEnforcing,
    };
  }

  /** One clock tick. Exposed so tests can drive expiry deterministically. */
  tick() {
    if (this.status !== RUNNING) return;
    if (Date.now() >= this.endsAt) this.complete(false);
    else this._emit();
  }

  _startTimer() {
    this._stopTimer();
    this._timer = setInterval(() => this.tick(), 250);
    if (this._timer.unref) this._timer.unref();
  }

  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _emit() {
    this.emit('update', this.snapshot());
  }
}

module.exports = { FocusSession, IDLE, RUNNING, PAUSED, DONE };
