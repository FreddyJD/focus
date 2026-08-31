'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * MCP (Model Context Protocol) servers.
 *
 * Connects to local stdio servers and exposes their tools to the model,
 * namespaced as `mcp__<server>__<tool>` so they can't collide with the
 * built-in bash/skill tools.
 *
 * The SDK is loaded lazily: it ships as ESM, and a failure to connect one
 * server must never stop the chat from working at all.
 */

const CONFIG = () => path.join(app.getPath('userData'), 'mcp-servers.json');

/** id -> { client, tools: [...], status, error } */
const servers = new Map();

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // No servers configured yet.
  }
  return {};
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG()), { recursive: true });
    fs.writeFileSync(CONFIG(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('[focus] mcp config save failed:', err.message);
  }
}

/** Namespaced tool name so MCP tools never shadow built-ins. */
function toolName(serverId, tool) {
  return `mcp__${serverId}__${tool}`;
}

function isMcpTool(name) {
  return typeof name === 'string' && name.startsWith('mcp__');
}

function parseToolName(name) {
  const parts = name.split('__');
  if (parts.length < 3) return null;
  return { serverId: parts[1], tool: parts.slice(2).join('__') };
}

/** Connect one configured server and cache its tool list. */
async function connect(id, spec) {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    );

    if (!Array.isArray(spec.command) || !spec.command.length) {
      throw new Error('command must be an array, e.g. ["npx","-y","server-name"]');
    }

    const transport = new StdioClientTransport({
      command: spec.command[0],
      args: spec.command.slice(1),
      env: { ...process.env, ...(spec.env || {}) },
      cwd: spec.cwd || undefined,
    });

    const client = new Client(
      { name: 'focus', version: '1.0.0' },
      { capabilities: {} }
    );

    await client.connect(transport);
    const listed = await client.listTools();

    const tools = (listed.tools || []).map((t) => ({
      name: toolName(id, t.name),
      original: t.name,
      description: t.description || '',
      schema: t.inputSchema || { type: 'object', properties: {} },
    }));

    servers.set(id, { client, tools, status: 'connected', error: null });
    console.log(`[focus] mcp "${id}" connected with ${tools.length} tool(s)`);
    return { ok: true, tools: tools.length };
  } catch (err) {
    servers.set(id, { client: null, tools: [], status: 'error', error: err.message });
    console.error(`[focus] mcp "${id}" failed:`, err.message);
    return { ok: false, reason: err.message };
  }
}

/** Connect every enabled server. Failures are isolated. */
async function connectAll() {
  const cfg = readConfig();
  const ids = Object.keys(cfg).filter((id) => cfg[id] && cfg[id].enabled !== false);
  await Promise.all(ids.map((id) => connect(id, cfg[id]).catch(() => {})));
}

/** OpenAI-shaped schemas for every connected MCP tool. */
function toolSchemas() {
  const out = [];
  for (const [, entry] of servers) {
    if (entry.status !== 'connected') continue;
    for (const t of entry.tools) {
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schema,
        },
      });
    }
  }
  return out;
}

async function callTool(name, args) {
  const parsed = parseToolName(name);
  if (!parsed) return `Error: "${name}" is not a valid MCP tool name.`;

  const entry = servers.get(parsed.serverId);
  if (!entry || entry.status !== 'connected') {
    return `Error: MCP server "${parsed.serverId}" is not connected.`;
  }

  try {
    const res = await entry.client.callTool({ name: parsed.tool, arguments: args || {} });
    const parts = (res.content || [])
      .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join('\n');
    return parts || '(no output)';
  } catch (err) {
    return `MCP tool failed: ${err.message}`;
  }
}

async function addServer(id, spec) {
  const safe = String(id || '').replace(/[^a-z0-9_-]/gi, '');
  if (!safe) return { ok: false, reason: 'Give the server a short id.' };

  let command = spec.command;
  if (typeof command === 'string') {
    command = command.trim().split(/\s+/); // accept "npx -y thing"
  }
  if (!Array.isArray(command) || !command.length) {
    return { ok: false, reason: 'Enter a command, e.g. npx -y @scope/server' };
  }

  const cfg = readConfig();
  cfg[safe] = { command, env: spec.env || {}, cwd: spec.cwd || '', enabled: true };
  writeConfig(cfg);

  const result = await connect(safe, cfg[safe]);
  return result.ok ? { ok: true, id: safe, tools: result.tools } : { ok: false, reason: result.reason };
}

async function removeServer(id) {
  const entry = servers.get(id);
  if (entry?.client) {
    try {
      await entry.client.close();
    } catch {}
  }
  servers.delete(id);

  const cfg = readConfig();
  delete cfg[id];
  writeConfig(cfg);
  return { ok: true };
}

/** Safe summary for the UI. */
function list() {
  const cfg = readConfig();
  return Object.keys(cfg).map((id) => {
    const live = servers.get(id);
    return {
      id,
      command: (cfg[id].command || []).join(' '),
      status: live ? live.status : 'disconnected',
      error: live ? live.error : null,
      tools: live ? live.tools.map((t) => t.original) : [],
    };
  });
}

async function shutdown() {
  for (const [, entry] of servers) {
    if (entry.client) {
      try {
        await entry.client.close();
      } catch {}
    }
  }
  servers.clear();
}

module.exports = {
  connectAll,
  toolSchemas,
  callTool,
  isMcpTool,
  addServer,
  removeServer,
  list,
  shutdown,
};
