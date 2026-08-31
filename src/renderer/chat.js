'use strict';

const api = window.focusApi;
const ai = api.ai;
const icon = window.Icons.icon;
const MD = window.MD;
const $ = (id) => document.getElementById(id);

const el = {
  log: $('log'),
  input: $('input'),
  send: $('send'),
  hint: $('hint'),
  composer: $('composer'),
  sheet: $('sheet'),
  modelLabel: $('modelLabel'),
  modelSelect: $('modelSelect'),
};

$('icoBrand').innerHTML = icon('sparkle', 'xs');
$('settingsBtn').innerHTML = icon('settings', 'sm');
$('closeBtn').innerHTML = icon('close', 'sm');
$('backBtn').innerHTML = icon('back', 'sm');
$('editorBack').innerHTML = icon('back', 'sm');
$('send').innerHTML = icon('arrowRight', 'xs');
$('refreshModels').innerHTML = icon('reload', 'xs');

/** Conversation sent to the model. Tool results are appended in main. */
let messages = [];
let config = null;
let streaming = false;
let currentBubble = null; // the assistant bubble being streamed into

// ------------------------------------------------------------------ helpers

function scrollDown() {
  el.log.scrollTop = el.log.scrollHeight;
}

function addMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const who = document.createElement('div');
  who.className = 'who';
  who.innerHTML = icon(role === 'user' ? 'check' : 'sparkle', 'xs');
  const label = document.createElement('span');
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  who.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'user') bubble.textContent = text;
  else bubble.innerHTML = MD.render(text || '');

  wrap.append(who, bubble);
  el.log.appendChild(wrap);
  scrollDown();
  return bubble;
}

function clearEmpty() {
  const empty = el.log.querySelector('.empty');
  if (empty) empty.remove();
}

function showEmpty() {
  el.log.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'empty';

  const mark = document.createElement('div');
  mark.className = 'mark';
  mark.innerHTML = icon('sparkle', 'lg') || icon('check', 'lg');

  const h = document.createElement('h2');
  const p = document.createElement('p');

  if (!config || !config.hasKey) {
    h.textContent = 'Add an API key';
    p.textContent =
      'Save a key in Settings to start. It is encrypted with your OS keychain and never leaves this machine.';
  } else if (!config.model) {
    h.textContent = 'Choose a model';
    p.textContent = 'Pick one from Settings and you are ready to go.';
  } else {
    h.textContent = 'Ready';
    p.textContent =
      'Ask a question, or describe a task. The assistant can run terminal commands — you approve each one.';
  }

  wrap.append(mark, h, p);
  el.log.appendChild(wrap);
}

// --------------------------------------------------------------- tool cards

const toolCards = new Map();

function toolCard(call) {
  let card = toolCards.get(call.id);
  if (card) return card;

  const wrap = document.createElement('div');
  wrap.className = 'tool';

  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML = icon('app', 'xs');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = call.name;
  const state = document.createElement('span');
  state.className = 'state';
  head.append(name, state);

  const cmd = document.createElement('div');
  cmd.className = 'tool-cmd';
  cmd.textContent =
    call.args?.command || JSON.stringify(call.args || {}, null, 2).slice(0, 800);

  wrap.append(head, cmd);
  el.log.appendChild(wrap);
  scrollDown();

  card = { wrap, state, cmd, out: null };
  toolCards.set(call.id, card);
  return card;
}

function setToolState(id, status, output) {
  const card = toolCards.get(id);
  if (!card) return;

  card.wrap.className = `tool ${status}`;
  card.state.textContent =
    { pending: 'waiting for you', running: 'running…', done: 'done', failed: 'failed', denied: 'declined' }[
      status
    ] || status;

  if (output != null) {
    if (!card.out) {
      card.out = document.createElement('div');
      card.out.className = 'tool-out';
      card.wrap.appendChild(card.out);
    }
    card.out.textContent = output;
  }
  scrollDown();
}

/** Approval buttons appear inside the tool card itself. */
function askApproval(call) {
  clearEmpty();
  const card = toolCard(call);
  setToolState(call.id, 'pending');

  const row = document.createElement('div');
  row.className = 'approve';

  const deny = document.createElement('button');
  deny.className = 'btn btn-secondary';
  deny.textContent = 'Decline';

  const run = document.createElement('button');
  run.className = 'btn btn-primary';
  run.textContent = 'Run';

  const answer = (approved) => {
    row.remove();
    ai.approve(call.id, approved);
  };
  deny.addEventListener('click', () => answer(false));
  run.addEventListener('click', () => answer(true));

  row.append(deny, run);
  card.wrap.appendChild(row);
  scrollDown();
}

// ------------------------------------------------------------------ sending

async function send() {
  const text = el.input.value.trim();
  if (!text || streaming) return;

  if (!config?.hasKey) {
    openSheet();
    return;
  }
  if (!config?.model) {
    openSheet();
    return;
  }

  clearEmpty();
  addMessage('user', text);
  messages.push({ role: 'user', content: text });

  el.input.value = '';
  el.input.style.height = 'auto';
  setStreaming(true);

  currentBubble = addMessage('assistant', '');
  currentBubble.dataset.raw = '';

  await ai.send({ messages, model: config.model });
}

function setStreaming(on) {
  streaming = on;
  el.send.disabled = on;
  el.hint.textContent = on ? 'Working… press Esc to stop' : '';
  el.hint.innerHTML = on
    ? icon('clock', 'xs') + '<span>Working… Esc to stop</span>'
    : '';
}

ai.onEvent((ev) => {
  if (ev.type === 'delta') {
    if (!currentBubble) {
      clearEmpty();
      currentBubble = addMessage('assistant', '');
      currentBubble.dataset.raw = '';
    }
    currentBubble.dataset.raw += ev.text;
    currentBubble.innerHTML = MD.render(currentBubble.dataset.raw);
    scrollDown();
    return;
  }

  if (ev.type === 'tool') {
    clearEmpty();
    // A new tool card ends the current text bubble.
    if (currentBubble && currentBubble.dataset.raw) {
      messages.push({ role: 'assistant', content: currentBubble.dataset.raw });
    }
    currentBubble = null;

    toolCard(ev);
    setToolState(ev.id, ev.status, ev.output);
    return;
  }

  if (ev.type === 'step') {
    // A fresh bubble for whatever the model says next.
    currentBubble = null;
    return;
  }

  if (ev.type === 'done') {
    if (currentBubble && currentBubble.dataset.raw) {
      messages.push({ role: 'assistant', content: currentBubble.dataset.raw });
    }
    currentBubble = null;
    setStreaming(false);
    return;
  }

  if (ev.type === 'cancelled') {
    setStreaming(false);
    currentBubble = null;
    return;
  }

  if (ev.type === 'error') {
    clearEmpty();
    const b = addMessage('assistant', '');
    b.innerHTML = `<p class="muted">${MD.escapeHtml(ev.message)}</p>`;
    setStreaming(false);
    currentBubble = null;
  }
});

ai.onApprove((call) => askApproval(call));

// ------------------------------------------------------------------ settings

function openSheet() {
  el.sheet.hidden = false;
  refreshSheet();
}
function closeSheet() {
  el.sheet.hidden = true;
}

async function refreshSheet() {
  config = await ai.getConfig();

  $('keyInput').value = '';
  $('keyInput').placeholder = config.hasKey ? config.keyHint || '••••' : 'rx-…';
  $('keyDesc').textContent = config.hasKey
    ? 'Saved and encrypted with your OS keychain.'
    : config.encryptionAvailable
      ? 'Stored encrypted on this machine. Never sent anywhere except your provider.'
      : 'No secure store available on this system — a key cannot be saved safely.';
  $('baseUrl').value = config.baseUrl || '';
  $('autoApprove').checked = config.autoApprove !== false;

  renderModels(config.model);
  renderSkills(config.skills || []);
  renderMcp(config.mcp || []);
  updateModelLabel();
}

function updateModelLabel() {
  const m = config?.model || '';
  el.modelLabel.textContent = m ? m.split('/').pop() : 'no model';
}

let catalog = [];

function renderModels(selected) {
  const sel = el.modelSelect;
  sel.replaceChildren();

  if (!catalog.length) {
    const opt = document.createElement('option');
    opt.value = selected || '';
    opt.textContent = selected || 'Load the catalog →';
    sel.appendChild(opt);
    return;
  }

  for (const m of catalog) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    if (m.id === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function loadModels() {
  $('modelDesc').textContent = 'Loading…';
  const res = await ai.listModels();
  if (!res.ok) {
    $('modelDesc').textContent = res.reason || 'Could not load models.';
    return;
  }
  catalog = res.models;
  renderModels(config?.model);
  $('modelDesc').textContent = `${catalog.length} models available.`;
}

function renderSkills(skills) {
  const box = $('skillList');
  box.replaceChildren();
  if (!skills.length) return;

  for (const s of skills) {
    const item = document.createElement('div');
    item.className = 'item ok';
    item.title = `Edit ${s.id}`;

    const dot = document.createElement('span');
    dot.className = 'dot';

    const txt = document.createElement('div');
    txt.className = 'txt';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = s.id;
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = s.description || s.name;
    txt.append(n, d);

    // Clicking the row opens the editor.
    txt.addEventListener('click', () => openEditor(s.id));

    const rm = document.createElement('button');
    rm.className = 'icon-btn';
    rm.innerHTML = icon('close', 'xs');
    rm.title = `Remove ${s.id}`;
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      await ai.removeSkill(s.id);
      refreshSheet();
    });

    item.append(dot, txt, rm);
    box.appendChild(item);
  }
}

// ------------------------------------------------------------ skill editor

let editingId = null;

async function openEditor(id) {
  editingId = id;
  const body = id ? await ai.readSkill(id) : '';

  $('editorTitle').textContent = id ? id : 'New skill';
  $('editorName').hidden = !!id;
  $('editorName').value = '';
  $('editorText').value =
    body ||
    '---\nname: my-skill\ndescription: When the assistant should use this\n---\n\n';
  $('editorErr').textContent = '';

  $('editor').hidden = false;
  $('editorText').focus();
}

function closeEditor() {
  $('editor').hidden = true;
  editingId = null;
}

$('editorBack').addEventListener('click', closeEditor);

$('editorSave').addEventListener('click', async () => {
  const text = $('editorText').value;
  let res;

  if (editingId) {
    res = await ai.saveSkill(editingId, text);
  } else {
    // Take the name from frontmatter when present, else the field.
    const fm = text.match(/^---[\s\S]*?\bname:\s*(.+?)\s*$/m);
    const name = (fm ? fm[1] : $('editorName').value).trim();
    if (!name) {
      $('editorErr').textContent = 'Give the skill a name, or add one to the frontmatter.';
      return;
    }
    res = await ai.installSkillText(name, text);
  }

  if (res && res.ok) {
    closeEditor();
    refreshSheet();
  } else {
    $('editorErr').textContent = (res && res.reason) || 'Could not save.';
  }
});

$('newSkill').addEventListener('click', () => openEditor(null));

function renderMcp(servers) {
  const box = $('mcpList');
  box.replaceChildren();
  if (!servers.length) return;

  for (const s of servers) {
    const item = document.createElement('div');
    item.className = 'item' + (s.status === 'connected' ? ' ok' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const txt = document.createElement('div');
    txt.className = 'txt';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = s.id;
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent =
      s.status === 'connected'
        ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`
        : s.error || s.status;
    txt.append(n, d);

    const rm = document.createElement('button');
    rm.className = 'icon-btn';
    rm.innerHTML = icon('close', 'xs');
    rm.addEventListener('click', async () => {
      await ai.removeMcp(s.id);
      refreshSheet();
    });

    item.append(dot, txt, rm);
    box.appendChild(item);
  }
}

// ------------------------------------------------------------------- events

$('settingsBtn').addEventListener('click', openSheet);
$('backBtn').addEventListener('click', closeSheet);
$('modelBtn').addEventListener('click', openSheet);
$('closeBtn').addEventListener('click', () => ai.toggle(false));

$('saveKey').addEventListener('click', async () => {
  const res = await ai.setKey($('keyInput').value);
  $('keyErr').textContent = res.ok ? '' : res.reason || 'Could not save.';
  if (res.ok) {
    await refreshSheet();
    loadModels();
  }
});

$('baseUrl').addEventListener('change', async () => {
  await ai.setBaseUrl($('baseUrl').value);
  catalog = [];
  refreshSheet();
});

$('refreshModels').addEventListener('click', loadModels);

$('autoApprove').addEventListener('change', async () => {
  config = await ai.setAutoApprove($('autoApprove').checked);
});

el.modelSelect.addEventListener('change', async () => {
  config = await ai.setModel(el.modelSelect.value);
  updateModelLabel();
});

$('addSkill').addEventListener('click', async () => {
  const url = $('skillUrl').value.trim();
  if (!url) return;
  $('skillErr').textContent = 'Fetching…';
  const res = await ai.installSkillUrl(url);
  $('skillErr').textContent = res.ok ? '' : res.reason || 'Could not install.';
  if (res.ok) {
    $('skillUrl').value = '';
    refreshSheet();
  }
});

$('addMcp').addEventListener('click', async () => {
  const id = $('mcpId').value.trim();
  const cmd = $('mcpCmd').value.trim();
  if (!id || !cmd) return;
  $('mcpErr').textContent = 'Connecting…';
  const res = await ai.addMcp({ id, command: cmd });
  $('mcpErr').textContent = res.ok ? '' : res.reason || 'Could not connect.';
  if (res.ok) {
    $('mcpId').value = '';
    $('mcpCmd').value = '';
    refreshSheet();
  }
});

el.send.addEventListener('click', send);

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(140, el.input.scrollHeight) + 'px';
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('editor').hidden) closeEditor();
    else if (!el.sheet.hidden) closeSheet();
    else if (streaming) ai.cancel();
  }
  // Ctrl+S saves while the editor is open.
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && !$('editor').hidden) {
    e.preventDefault();
    $('editorSave').click();
  }
});

// -------------------------------------------------------------------- start

(async () => {
  config = await ai.getConfig();
  showEmpty();
  updateModelLabel();
  if (config.hasKey) loadModels();
})();
