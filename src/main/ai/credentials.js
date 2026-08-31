'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

/**
 * API key storage.
 *
 * The key is encrypted with Electron's safeStorage, which uses the OS keychain
 * (DPAPI on Windows), so the bytes on disk are useless to anything running as
 * another user — and useless if the file is copied to another machine.
 *
 * Deliberately NOT localStorage: any renderer, and anything that can inject
 * into one, can read localStorage. The key never reaches a renderer at all —
 * the main process makes the HTTP calls and only streams text back.
 */

const FILE = () => path.join(app.getPath('userData'), 'ai-credentials.bin');
const META = () => path.join(app.getPath('userData'), 'ai-config.json');

let cachedKey = null; // in-memory only, never sent to a renderer

const DEFAULTS = {
  baseUrl: 'https://roxy.gg/v1',
  model: '',
  hasKey: false,
};

function readMeta() {
  try {
    const raw = fs.readFileSync(META(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { ...DEFAULTS, ...parsed };
  } catch {
    // First run.
  }
  return { ...DEFAULTS };
}

function writeMeta(patch) {
  const next = { ...readMeta(), ...patch };
  delete next.apiKey; // never let a key leak into the plaintext file
  try {
    fs.mkdirSync(path.dirname(META()), { recursive: true });
    fs.writeFileSync(META(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('[focus] ai config save failed:', err.message);
  }
  return next;
}

/** @returns {boolean} whether a key is stored */
function hasKey() {
  if (cachedKey) return true;
  try {
    return fs.existsSync(FILE()) && fs.statSync(FILE()).size > 0;
  } catch {
    return false;
  }
}

/** Save the key encrypted at rest. */
function setKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) return { ok: false, reason: 'Paste a key first.' };
  if (!/^[\x20-\x7e]+$/.test(key)) {
    return { ok: false, reason: 'That does not look like an API key.' };
  }

  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });

    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(FILE(), safeStorage.encryptString(key));
    } else {
      // Rather than silently writing plaintext, refuse and say why.
      return {
        ok: false,
        reason: 'This system has no secure credential store, so the key cannot be saved safely.',
      };
    }

    // Lock the file down to the current user where the OS supports it.
    try {
      fs.chmodSync(FILE(), 0o600);
    } catch {}

    cachedKey = key;
    writeMeta({ hasKey: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Decrypt and return the key. Main process only. */
function getKey() {
  if (cachedKey) return cachedKey;
  try {
    if (!fs.existsSync(FILE())) return null;
    const buf = fs.readFileSync(FILE());
    if (!buf || !buf.length) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    cachedKey = safeStorage.decryptString(buf);
    return cachedKey;
  } catch (err) {
    console.error('[focus] could not read stored key:', err.message);
    return null;
  }
}

function clearKey() {
  cachedKey = null;
  try {
    if (fs.existsSync(FILE())) fs.unlinkSync(FILE());
  } catch {}
  writeMeta({ hasKey: false });
  return { ok: true };
}

/**
 * Safe to send to a renderer: describes whether a key exists and shows only a
 * masked hint, never the key itself.
 */
function publicConfig() {
  const meta = readMeta();
  const present = hasKey();
  let hint = '';
  if (present) {
    const k = getKey();
    if (k && k.length > 8) hint = `${k.slice(0, 5)}…${k.slice(-4)}`;
    else if (k) hint = '••••';
  }
  return {
    baseUrl: meta.baseUrl || DEFAULTS.baseUrl,
    model: meta.model || '',
    hasKey: present,
    keyHint: hint,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
}

module.exports = {
  setKey,
  getKey,
  clearKey,
  hasKey,
  readMeta,
  writeMeta,
  publicConfig,
};
