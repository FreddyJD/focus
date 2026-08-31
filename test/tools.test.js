'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

/**
 * Tool safety.
 *
 * `bash` can do anything the user can, so the protections need to be pinned:
 *
 *   1. Catastrophic commands are refused outright.
 *   2. Ordinary commands are NOT refused (a blunt filter that blocks real
 *      work would just get disabled).
 *   3. Output is truncated so one runaway command can't flood the context.
 *
 * The deny-list is a seatbelt for obvious accidents, not a sandbox — the real
 * protection is that every call waits for explicit user approval.
 */

// tools.js pulls in electron for app paths; stub it for a plain node test.
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...args);
};
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: { app: { getPath: () => process.cwd() } },
};

const { screen, truncate, MAX_OUTPUT } = require('../src/main/ai/tools');

test('refuses commands that destroy the machine', () => {
  const lethal = [
    'rm -rf /',
    'rm -rf / --no-preserve-root',
    'format C:',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'vssadmin delete shadows /all',
    'diskpart',
    'shutdown /s /t 0',
    'Restart-Computer -Force',
    ':(){ :|:& };:',
  ];
  for (const cmd of lethal) {
    assert.ok(screen(cmd), `should refuse: ${cmd}`);
  }
});

test('allows ordinary, useful commands', () => {
  const fine = [
    'ls -la',
    'git status',
    'npm test',
    'node --version',
    'rm -rf node_modules', // scoped deletes are normal work
    'rm ./tmp/file.txt',
    'Get-ChildItem -Recurse',
    'cat package.json',
    'grep -rn "TODO" src/',
    'mkdir -p build/out',
    'curl https://example.com',
    'echo "formatting the output"', // the word alone must not trip it
  ];
  for (const cmd of fine) {
    assert.equal(screen(cmd), null, `should allow: ${cmd}`);
  }
});

test('truncation keeps head and tail, and bounds the size', () => {
  const huge = 'x'.repeat(MAX_OUTPUT * 3);
  const out = truncate(huge);
  assert.ok(out.length < MAX_OUTPUT * 1.1, `truncated output too long: ${out.length}`);
  assert.ok(out.includes('truncated'), 'should say it was truncated');
});

test('short output is returned untouched', () => {
  const small = 'hello world';
  assert.equal(truncate(small), small);
});

test('empty commands are rejected before anything runs', async () => {
  const { runBash } = require('../src/main/ai/tools');
  const res = await runBash({ command: '   ' });
  assert.equal(res.ok, false);
});

test('a refused command never executes', async () => {
  const { runBash } = require('../src/main/ai/tools');
  const res = await runBash({ command: 'rm -rf /' });
  assert.equal(res.ok, false);
  assert.equal(res.refused, true);
  assert.ok(res.output.includes('deny-list'));
});
