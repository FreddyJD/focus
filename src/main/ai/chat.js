'use strict';

const {
  runBash,
  killAll,
  listSkills,
  readSkill,
  toolSchemas,
} = require('./tools');
const { getKey, readMeta } = require('./credentials');
const mcp = require('./mcp');

/**
 * Chat engine: OpenAI-compatible streaming with a tool-call loop.
 *
 * Speaks the Chat Completions protocol (Roxy, OpenAI, anything compatible).
 * The API key never leaves this process — renderers receive only text deltas
 * and tool events over IPC.
 *
 * Tool calls that touch the machine (bash) pause here and wait for the user to
 * approve them, so the model can never silently run something.
 */

const MAX_STEPS = 24; // tool-call rounds before we stop, to avoid runaway loops

/** In-flight run, so it can be cancelled. */
let active = null;

function systemPrompt() {
  const skills = listSkills();
  const lines = [
    'You are the assistant built into Focus, a fullscreen focus browser on Windows.',
    '',
    'You can run real shell commands on the user\'s computer with the `bash` tool.',
    'Every call is shown to the user for approval before it runs, so prefer one',
    'clear command over many small ones, and say what you intend to do first.',
    '',
    'Be concise. Use markdown. Show file paths and commands in backticks.',
    'When a command fails, read the error and fix it rather than guessing again.',
    'Never claim something worked unless you saw it succeed in the output.',
  ];

  if (skills.length) {
    lines.push(
      '',
      'Installed skills — load one with the `skill` tool when the task matches:',
      ...skills.map((s) => `- ${s.id}: ${s.description || s.name}`)
    );
  }

  lines.push('', `Platform: ${process.platform}. Today: ${new Date().toDateString()}.`);
  return lines.join('\n');
}

/**
 * Stream a chat completion, running tools until the model stops asking.
 *
 * @param {object} opts
 * @param {Array}  opts.messages        conversation so far
 * @param {string} opts.model
 * @param {(ev: object) => void} opts.onEvent
 * @param {(call: object) => Promise<boolean>} opts.confirm  approval gate
 */
async function run({ messages, model, onEvent, confirm }) {
  const key = getKey();
  if (!key) {
    onEvent({ type: 'error', message: 'No API key saved. Add one to start chatting.' });
    return;
  }

  const meta = readMeta();
  const baseUrl = (meta.baseUrl || 'https://roxy.gg/v1').replace(/\/+$/, '');
  const controller = new AbortController();
  active = controller;

  const convo = [{ role: 'system', content: systemPrompt() }, ...messages];
  const tools = toolSchemas(mcp.toolSchemas());

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: convo,
          stream: true,
          tools: tools.length ? tools : undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = body?.error?.message || '';
        } catch {
          detail = await res.text().catch(() => '');
        }
        onEvent({
          type: 'error',
          message: describeHttpError(res.status, detail),
        });
        return;
      }

      const { content, toolCalls, usage } = await readStream(res, onEvent, controller);

      // No tools requested: the model is done talking.
      if (!toolCalls.length) {
        onEvent({ type: 'done', usage });
        return;
      }

      convo.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.args },
        })),
      });

      for (const call of toolCalls) {
        const result = await executeTool(call, { onEvent, confirm, signal: controller.signal });
        convo.push({ role: 'tool', tool_call_id: call.id, content: result });
      }

      onEvent({ type: 'step', step: step + 1 });
    }

    onEvent({
      type: 'error',
      message: `Stopped after ${MAX_STEPS} tool rounds — the model kept going without finishing.`,
    });
  } catch (err) {
    if (err.name === 'AbortError') onEvent({ type: 'cancelled' });
    else onEvent({ type: 'error', message: err.message });
  } finally {
    active = null;
  }
}

function describeHttpError(status, detail) {
  if (status === 401) return 'That API key was rejected. Check it in Settings.';
  if (status === 402) return detail || 'Out of credits — top up your balance to keep chatting.';
  if (status === 429) return 'Rate limited. Wait a moment and try again.';
  if (status >= 500) return `The provider had a problem (${status}). ${detail}`.trim();
  return detail || `Request failed (${status}).`;
}

/** Parse an SSE stream, emitting deltas and collecting tool calls. */
async function readStream(res, onEvent, controller) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let content = '';
  let usage = null;
  const calls = new Map(); // index -> { id, name, args }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (controller.signal.aborted) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      if (chunk.usage) usage = chunk.usage;

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        onEvent({ type: 'delta', text: delta.content });
      }

      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        if (!calls.has(i)) calls.set(i, { id: tc.id || `call_${i}`, name: '', args: '' });
        const cur = calls.get(i);
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
      }
    }
  }

  return { content, toolCalls: [...calls.values()].filter((c) => c.name), usage };
}

/** Run one tool call, gated on user approval where it touches the machine. */
async function executeTool(call, { onEvent, confirm, signal }) {
  let args = {};
  try {
    args = call.args ? JSON.parse(call.args) : {};
  } catch {
    return 'Error: the tool arguments were not valid JSON.';
  }

  // --- skills: read-only, no approval needed ---
  if (call.name === 'skill') {
    const body = readSkill(args.name);
    onEvent({ type: 'tool', id: call.id, name: 'skill', args, status: 'done' });
    return body || `No skill named "${args.name}" is installed.`;
  }

  // --- MCP tools ---
  if (mcp.isMcpTool(call.name)) {
    onEvent({ type: 'tool', id: call.id, name: call.name, args, status: 'running' });
    const out = await mcp.callTool(call.name, args);
    onEvent({ type: 'tool', id: call.id, name: call.name, args, status: 'done', output: out });
    return out;
  }

  // --- bash: runs straight away unless the user asked to review each call ---
  if (call.name === 'bash') {
    const meta = readMeta();
    const autoApprove = meta.autoApprove !== false;

    if (!autoApprove) {
      onEvent({ type: 'tool', id: call.id, name: 'bash', args, status: 'pending' });
      const approved = await confirm({ id: call.id, name: 'bash', args });
      if (!approved) {
        onEvent({ type: 'tool', id: call.id, name: 'bash', args, status: 'denied' });
        return 'The user declined to run this command. Ask what they would prefer instead.';
      }
    }

    onEvent({ type: 'tool', id: call.id, name: 'bash', args, status: 'running' });
    const result = await runBash(args);
    onEvent({
      type: 'tool',
      id: call.id,
      name: 'bash',
      args,
      // A refused command is worth showing differently from one that just
      // exited non-zero.
      status: result.refused ? 'denied' : result.ok ? 'done' : 'failed',
      output: result.output,
    });
    return result.output;
  }

  return `Error: no tool named "${call.name}".`;
}

function cancel() {
  if (active) active.abort();
  killAll();
}

/** Fetch the provider's model catalog. */
async function listModels() {
  const key = getKey();
  if (!key) return { ok: false, reason: 'No API key saved.' };

  const meta = readMeta();
  const baseUrl = (meta.baseUrl || 'https://roxy.gg/v1').replace(/\/+$/, '');

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      return { ok: false, reason: describeHttpError(res.status, '') };
    }
    const body = await res.json();
    const models = (body.data || [])
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context: m.context_length || 0,
        pricing: m.pricing || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, models };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { run, cancel, listModels, systemPrompt };
