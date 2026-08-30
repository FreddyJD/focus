'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * Watches the Windows foreground window during a session and nudges away
 * anything not on the allowlist.
 *
 * Honest limitation: this is friction, not a kernel-level lock. It minimizes
 * offending windows; it cannot stop a determined user with Task Manager.
 */
class AppWatcher {
  constructor({ isAllowed, isEnforcing, onAlert }) {
    this.isAllowed = isAllowed;
    this.isEnforcing = isEnforcing;
    this.onAlert = onAlert || (() => {});
    this.proc = null;
    this.lastAlert = null;
    this._buf = '';
    this._selfPids = new Set([process.pid]);
  }

  get running() {
    return !!this.proc;
  }

  start() {
    if (this.proc || process.platform !== 'win32') return;

    const script = path.join(__dirname, 'watcher.ps1');
    try {
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (err) {
      console.error('[focus] watcher failed to start:', err.message);
      this.proc = null;
      return;
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.on('exit', () => { this.proc = null; });
    this.proc.on('error', () => { this.proc = null; });
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
    } catch {}
    const p = this.proc;
    this.proc = null;
    setTimeout(() => { try { p.kill(); } catch {} }, 400);
    this.lastAlert = null;
  }

  _send(obj) {
    if (!this.proc) return;
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {}
  }

  _onData(chunk) {
    this._buf += chunk;
    const lines = this._buf.split(/\r?\n/);
    this._buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let msg;
      try { msg = JSON.parse(s); } catch { continue; }
      if (msg.t === 'focus') this._onFocus(msg);
    }
  }

  _onFocus(ev) {
    if (!this.isEnforcing()) return;

    const exe = String(ev.exe || '').toLowerCase();
    if (!exe) return;

    // Never fight our own window or the shell itself.
    if (this._selfPids.has(ev.pid)) return;
    if (exe === 'focus.exe' || exe === 'electron.exe') return;
    if (SYSTEM_EXEMPT.has(exe)) return;

    if (this.isAllowed(exe)) {
      if (this.lastAlert) { this.lastAlert = null; this.onAlert(); }
      return;
    }

    this._send({ cmd: 'minimize', hwnd: ev.hwnd });
    this.lastAlert = { exe, title: ev.title || '', at: Date.now() };
    this.onAlert();
  }
}

/** Minimizing these would make the machine unusable or fight the OS. */
const SYSTEM_EXEMPT = new Set([
  'explorer.exe',
  'searchhost.exe',
  'searchapp.exe',
  'shellexperiencehost.exe',
  'startmenuexperiencehost.exe',
  'applicationframehost.exe',
  'systemsettings.exe',
  'taskmgr.exe',
  'lockapp.exe',
  'logonui.exe',
  'dwm.exe',
  'textinputhost.exe',
  'sihost.exe',
  'ctfmon.exe',
  'rundll32.exe',
  'consent.exe',
  'securityhealthsystray.exe',
]);

module.exports = { AppWatcher, SYSTEM_EXEMPT };
