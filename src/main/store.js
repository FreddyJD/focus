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
    ].slice(0, 100);
    this.save();
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
