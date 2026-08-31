'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

/**
 * Tools the model can call.
 *
 * `bash` runs real shell commands, which is the whole point — but it also
 * means the model can do anything the user can. So:
 *
 *   - every call is queued for EXPLICIT USER APPROVAL by default
 *   - output is truncated so a runaway command can't flood the context
 *   - there's a hard timeout and the process tree is killed on abort
 *   - a small deny-list catches the catastrophic one-liners outright
 *
 * The approval gate is the real protection. The deny-list is a seatbelt for
 * obvious accidents, not a security boundary — anyone claiming a regex can
 * sandbox a shell is kidding themselves.
 */

const MAX_OUTPUT = 30_000; // characters returned to the model
const DEFAULT_TIMEOUT = 120_000;

/** Commands refused outright: irreversible, machine-wide damage. */
const DENY = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+\/(?:\s|$)/i, // rm -rf /
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+.*of=\/dev\/(?:sd|nvme|hd)/i,
  /Remove-Item\s+.*(?:C:\\+|\$env:SystemRoot|\$env:windir)\s*(?:\\?\*)?\s*.*-Recurse/i,
  /\bcipher\s+\/w/i,
  /\bvssadmin\s+delete\s+shadows/i,
  /\bbcdedit\b.*\bdelete\b/i,
  /\bdiskpart\b/i,
  /\bshutdown\b|\bRestart-Computer\b/i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
];

function screen(command) {
  for (const re of DENY) {
    if (re.test(command)) {
      return `Refused: this command matches a deny-list pattern (${re}). It can cause irreversible damage, so Focus will not run it.`;
    }
  }
  return null;
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT) return text;
  const head = text.slice(0, Math.floor(MAX_OUTPUT * 0.7));
  const tail = text.slice(-Math.floor(MAX_OUTPUT * 0.25));
  const cut = text.length - head.length - tail.length;
  return `${head}\n\n… [${cut} characters truncated] …\n\n${tail}`;
}

/** Tracks running children so a cancel actually stops them. */
const running = new Set();

function killAll() {
  for (const child of running) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    } catch {}
  }
  running.clear();
}

/**
 * Run a shell command.
 *
 * @param {object} args
 * @param {string} args.command
 * @param {number} [args.timeout] seconds
 * @param {string} [args.cwd]
 */
function runBash({ command, timeout = 120, cwd } = {}) {
  return new Promise((resolve) => {
    const cmd = String(command || '').trim();
    if (!cmd) return resolve({ ok: false, output: 'No command given.' });

    const refusal = screen(cmd);
    if (refusal) return resolve({ ok: false, output: refusal, refused: true });

    const ms = Math.min(600_000, Math.max(1_000, Number(timeout) * 1000 || DEFAULT_TIMEOUT));
    const workdir = cwd && fs.existsSync(cwd) ? cwd : app.getPath('home');

    const isWin = process.platform === 'win32';
    const file = isWin ? 'powershell.exe' : '/bin/bash';
    const argv = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', cmd]
      : ['-lc', cmd];

    let child;
    try {
      child = spawn(file, argv, {
        cwd: workdir,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      });
    } catch (err) {
      return resolve({ ok: false, output: `Could not start shell: ${err.message}` });
    }

    running.add(child);

    let out = '';
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      running.delete(child);
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        if (isWin) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {}
      finish({
        ok: false,
        output: truncate(out) + `\n\n[timed out after ${ms / 1000}s and was killed]`,
      });
    }, ms);

    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.length > MAX_OUTPUT * 3) out = out.slice(0, MAX_OUTPUT * 3);
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
      if (out.length > MAX_OUTPUT * 3) out = out.slice(0, MAX_OUTPUT * 3);
    });

    child.on('error', (err) => finish({ ok: false, output: `Shell error: ${err.message}` }));

    child.on('close', (code) => {
      const body = out.trim() || '(no output)';
      finish({
        ok: code === 0,
        output: truncate(code === 0 ? body : `${body}\n\n[exit ${code}]`),
      });
    });
  });
}

// ------------------------------------------------------------------- skills

const SKILLS_DIR = () => path.join(app.getPath('userData'), 'skills');

/** Frontmatter parser: name + description, enough for the skill contract. */
function parseSkill(md, fallbackName) {
  const meta = { name: fallbackName, description: '' };
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^(name|description):\s*(.+)$/i);
      if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return meta;
}

function listSkills() {
  const dir = SKILLS_DIR();
  const out = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const md = fs.readFileSync(file, 'utf8');
      const meta = parseSkill(md, entry.name);
      out.push({
        id: entry.name,
        name: meta.name || entry.name,
        description: meta.description || '',
        chars: md.length,
      });
    }
  } catch (err) {
    console.error('[focus] listSkills failed:', err.message);
  }
  return out;
}

function readSkill(id) {
  const safe = String(id || '').replace(/[^a-z0-9._-]/gi, '');
  if (!safe) return null;
  const file = path.join(SKILLS_DIR(), safe, 'SKILL.md');
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Install a skill from raw SKILL.md text. */
function installSkill(name, markdown) {
  const safe = String(name || '')
    .trim()
    .replace(/[^a-z0-9._-]/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!safe) return { ok: false, reason: 'Give the skill a name.' };
  const body = String(markdown || '').trim();
  if (!body) return { ok: false, reason: 'The skill file is empty.' };

  try {
    const dir = path.join(SKILLS_DIR(), safe);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
    return { ok: true, id: safe };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function removeSkill(id) {
  const safe = String(id || '').replace(/[^a-z0-9._-]/gi, '');
  if (!safe) return { ok: false };
  try {
    fs.rmSync(path.join(SKILLS_DIR(), safe), { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Fetch a SKILL.md from a URL (raw GitHub, gist, etc). */
async function installSkillFromUrl(url) {
  const u = String(url || '').trim();
  if (!/^https:\/\//i.test(u)) {
    return { ok: false, reason: 'Use an https URL to a SKILL.md file.' };
  }

  // Accept a GitHub blob URL by rewriting it to raw.
  const raw = u
    .replace('https://github.com/', 'https://raw.githubusercontent.com/')
    .replace('/blob/', '/');

  try {
    const res = await fetch(raw, { redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: `Fetch failed (${res.status}).` };
    const text = await res.text();
    if (!text.trim()) return { ok: false, reason: 'That URL returned nothing.' };
    if (text.length > 400_000) return { ok: false, reason: 'That file is too large.' };

    const meta = parseSkill(text, '');
    const guessed =
      meta.name ||
      decodeURIComponent(raw.split('/').filter(Boolean).slice(-2, -1)[0] || 'skill');
    return installSkill(guessed, text);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// --------------------------------------------------------- tool definitions

/** OpenAI-compatible tool schemas advertised to the model. */
function toolSchemas(mcpTools = []) {
  const base = [
    {
      type: 'function',
      function: {
        name: 'bash',
        description:
          'Run a shell command on the user\'s computer (PowerShell on Windows, bash elsewhere) ' +
          'and return its combined stdout/stderr. Use this for file operations, git, builds, ' +
          'inspecting the system, or anything else that needs a terminal. Requires user approval.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command to run.' },
            timeout: {
              type: 'number',
              description: 'Seconds before the command is killed. Default 120, max 600.',
            },
            cwd: { type: 'string', description: 'Optional working directory.' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'skill',
        description:
          'Load an installed skill to get its full instructions. Call this when the task ' +
          'matches a skill listed in the system prompt.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The skill id to load.' },
          },
          required: ['name'],
        },
      },
    },
  ];

  return base.concat(mcpTools);
}

module.exports = {
  runBash,
  killAll,
  screen,
  truncate,
  listSkills,
  readSkill,
  installSkill,
  installSkillFromUrl,
  removeSkill,
  toolSchemas,
  SKILLS_DIR,
  MAX_OUTPUT,
};
