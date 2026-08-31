'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { normalizeEntry } = require('./allowlist');

const DEFAULTS = {
  durationMin: 50,
  allowedSites: ['wikipedia.org', 'github.com', 'stackoverflow.com'],
  allowedApps: [],
  blockApps: false,
  homeUrl: 'https://duckduckgo.com',
  strictMode: false, // when true, no early completion
  history: [],
};

function uniq(list) {
  return Array.from(new Set(list));
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'focus-config.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { ...DEFAULTS, ...parsed };
      }
    } catch {
      // First run or unreadable config: defaults are correct.
    }
    this.data.allowedSites = uniq(
      (this.data.allowedSites || []).map(normalizeEntry).filter(Boolean)
    );
    this.data.allowedApps = uniq(
      (this.data.allowedApps || [])
        .map((a) => String(a || '').trim().toLowerCase())
        .filter(Boolean)
    );
    if (!Array.isArray(this.data.history)) this.data.history = [];

    // Repair history written before elapsedMs was tracked honestly. That
    // version derived elapsed from the countdown, so a session quit after 30
    // seconds was stored as a full 25 minutes. Wall-clock between start and
    // finish is the hard ceiling on how long anyone could have focused.
    let repaired = 0;
    this.data.history = this.data.history.map((s) => {
      if (!s || typeof s !== 'object') return s;
      const wall = Number(s.finishedAt) - Number(s.startedAt);
      if (Number.isFinite(wall) && wall >= 0 && Number(s.elapsedMs) > wall) {
        repaired += 1;
        return { ...s, elapsedMs: wall, repaired: true };
      }
      return s;
    });
    if (repaired) {
      console.log(`[focus] corrected ${repaired} inflated session record(s)`);
      this.save();
    }
    const d = Number(this.data.durationMin);
    this.data.durationMin = Number.isFinite(d) ? Math.min(480, Math.max(1, d)) : 50;
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[focus] config save failed:', err.message);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
    return this.data;
  }

  addSite(input) {
    const entry = normalizeEntry(input);
    if (!entry) return { ok: false, reason: 'That does not look like a website.' };
    if (this.data.allowedSites.includes(entry)) {
      return { ok: false, reason: 'Already on the list.', entry };
    }
    this.data.allowedSites = uniq([...this.data.allowedSites, entry]);
    this.save();
    return { ok: true, entry };
  }

  removeSite(entry) {
    this.data.allowedSites = this.data.allowedSites.filter((s) => s !== entry);
    this.save();
  }

  addApp(exe) {
    const name = String(exe || '').trim().toLowerCase();
    if (!name.endsWith('.exe')) {
      return { ok: false, reason: 'Pick a program (.exe).' };
    }
    if (this.data.allowedApps.includes(name)) {
      return { ok: false, reason: 'Already on the list.', entry: name };
    }
    this.data.allowedApps = uniq([...this.data.allowedApps, name]);
    this.save();
    return { ok: true, entry: name };
  }

  removeApp(name) {
    this.data.allowedApps = this.data.allowedApps.filter((a) => a !== name);
    this.save();
  }

  recordSession(snapshot) {
    this.data.history = [
      {
        startedAt: snapshot.startedAt,
        finishedAt: snapshot.finishedAt || Date.now(),
        durationMs: snapshot.durationMs,
        elapsedMs: snapshot.elapsedMs,
        pauseCount: snapshot.pauseCount,
        endedEarly: snapshot.endedEarly,
      },
      ...this.data.history,
      // A year of daily history is what the activity heatmap shows, and
      // sessions are tiny, so keep plenty.
    ].slice(0, 5000);
    this.save();
  }

  /** Local YYYY-MM-DD. Days must be local, or sessions land on the wrong date. */
  static dayKey(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * Focused milliseconds per day, keyed YYYY-MM-DD.
   * Only real focused time is counted — see FocusSession.elapsedMs().
   */
  dailyTotals() {
    const byDay = new Map();
    for (const s of this.data.history || []) {
      const when = Number(s.finishedAt) || Number(s.startedAt);
      if (!Number.isFinite(when)) continue;
      const ms = Math.max(0, Number(s.elapsedMs) || 0);
      const key = Store.dayKey(when);
      const cur = byDay.get(key) || { ms: 0, sessions: 0 };
      cur.ms += ms;
      cur.sessions += 1;
      byDay.set(key, cur);
    }
    return byDay;
  }

  /**
   * Everything the activity view needs, computed in main so the renderer
   * just draws.
   *
   * @param {number} days how far back to report
   */
  activity(days = 365) {
    const byDay = this.dailyTotals();

    const out = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = Store.dayKey(d.getTime());
      const hit = byDay.get(key);
      out.push({
        date: key,
        ms: hit ? hit.ms : 0,
        sessions: hit ? hit.sessions : 0,
        dow: d.getDay(),
      });
    }

    const active = out.filter((d) => d.ms > 0);
    const best = active.reduce((m, d) => Math.max(m, d.ms), 0);

    // Streaks, counted backwards from today.
    let current = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].ms > 0) current += 1;
      else if (i !== out.length - 1) break; // today not counting yet is fine
      else continue;
    }
    let longest = 0;
    let run = 0;
    for (const d of out) {
      if (d.ms > 0) {
        run += 1;
        longest = Math.max(longest, run);
      } else {
        run = 0;
      }
    }

    return {
      days: out,
      bestDayMs: best,
      activeDays: active.length,
      totalMs: out.reduce((a, d) => a + d.ms, 0),
      currentStreak: current,
      longestStreak: longest,
    };
  }

  /** The most recent finished session, for "last session" in the footer. */
  lastSession() {
    const h = this.data.history || [];
    if (!h.length) return null;
    const s = h[0];
    return {
      elapsedMs: Math.max(0, Number(s.elapsedMs) || 0),
      durationMs: Number(s.durationMs) || 0,
      finishedAt: Number(s.finishedAt) || 0,
      endedEarly: !!s.endedEarly,
      pauseCount: Number(s.pauseCount) || 0,
    };
  }

  stats() {
    const h = this.data.history || [];
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const today = h.filter((s) => s.finishedAt >= startOfToday);
    return {
      todayCount: today.length,
      todayMs: today.reduce((sum, s) => sum + (s.elapsedMs || 0), 0),
      totalCount: h.length,
      totalMs: h.reduce((sum, s) => sum + (s.elapsedMs || 0), 0),
    };
  }
}

module.exports = { Store, DEFAULTS };
