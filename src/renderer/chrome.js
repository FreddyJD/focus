'use strict';

const icon = window.Icons.icon;
const $ = (id) => document.getElementById(id);

const el = {
  tabs: $('tabs'),
  newTab: $('newTab'),
  timer: $('timer'),
  time: $('time'),
  prog: $('prog'),
  pause: $('pause'),
  finish: $('finish'),
  back: $('back'),
  forward: $('forward'),
  reload: $('reload'),
  address: $('address'),
  addrIcon: $('addrIcon'),
  status: $('status'),
  statusIcon: $('statusIcon'),
  statusLabel: $('statusLabel'),
  settings: $('settings'),
  chatBtn: $('chatBtn'),
};

const CIRC = 62.83; // 2 * pi * 10
let state = null;
let addressDirty = false;

// Static icons, painted once.
el.newTab.innerHTML = icon('plus', 'sm');
el.back.innerHTML = icon('back', 'sm');
el.forward.innerHTML = icon('forward', 'sm');
el.reload.innerHTML = icon('reload', 'sm');
el.finish.innerHTML = icon('check', 'xs');
el.settings.innerHTML = icon('settings', 'sm');
el.chatBtn.innerHTML = icon('sparkle', 'sm');

// ------------------------------------------------------------------ helpers

function fmt(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function prettyUrl(url) {
  if (!url) return '';
  if (url.startsWith('file://') && url.includes('blocked.html')) {
    try {
      const q = new URLSearchParams(url.split('?')[1] || '');
      return q.get('url') || q.get('host') || '';
    } catch {
      return '';
    }
  }
  return url;
}

/** Strip scheme and trailing slash — the address bar should read cleanly. */
function displayUrl(url) {
  const pretty = prettyUrl(url);
  if (!pretty) return '';
  return pretty.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// --------------------------------------------------------------------- tabs

function renderTabs(tabsData) {
  const sig = tabsData.map((t) => `${t.id}:${t.title}:${t.active}:${t.blocked}`).join('|');
  if (el.tabs.dataset.sig === sig) return;
  el.tabs.dataset.sig = sig;

  el.tabs.replaceChildren();
  for (const t of tabsData) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (t.active ? ' active' : '') + (t.blocked ? ' blocked' : '');
    tab.title = prettyUrl(t.url);

    const glyph = document.createElement('span');
    glyph.className = 'tab-icon';
    glyph.innerHTML = icon(t.blocked ? 'slash' : 'globe', 'xs');

    const label = document.createElement('button');
    label.className = 'label';
    label.textContent = t.blocked ? 'Blocked' : t.title || 'New tab';
    label.addEventListener('click', () => window.focusApi.selectTab(t.id));

    const x = document.createElement('button');
    x.className = 'x';
    x.innerHTML = icon('close', 'xs');
    x.title = 'Close tab';
    x.setAttribute('aria-label', 'Close tab');
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      window.focusApi.closeTab(t.id);
    });

    tab.append(glyph, label, x);
    el.tabs.appendChild(tab);
  }
}

// -------------------------------------------------------------------- timer

function renderTimer(s) {
  const { status, remainingMs, durationMs } = s;
  el.timer.className = `timer ${status}`;

  if (status === 'idle') {
    el.time.textContent = '--:--';
    el.prog.style.strokeDashoffset = CIRC;
  } else if (status === 'done') {
    el.time.textContent = 'Done';
    el.prog.style.strokeDashoffset = 0;
  } else {
    el.time.textContent = fmt(remainingMs);
    const frac = durationMs > 0 ? remainingMs / durationMs : 0;
    el.prog.style.strokeDashoffset = CIRC * (1 - frac);
  }

  const paused = status === 'paused';
  el.pause.innerHTML = icon(paused ? 'play' : 'pause', 'xs');
  el.pause.title = paused ? 'Resume \u00a0 Ctrl Shift P' : 'Pause \u00a0 Ctrl Shift P';
  el.pause.setAttribute('aria-label', paused ? 'Resume session' : 'Pause session');

  el.pause.disabled = !s.isActive;
  el.finish.disabled = !s.isActive;
}

// ------------------------------------------------------------------- status

function renderStatus(s) {
  const enforcing = s.session.isEnforcing;
  const paused = s.session.status === 'paused';
  const count = s.config.allowedSites.length;

  if (enforcing) {
    el.status.className = 'status on';
    el.statusIcon.innerHTML = icon('shieldCheck', 'xs');
    el.statusLabel.textContent = `${count} site${count === 1 ? '' : 's'}`;
    el.status.title = `Blocking everything except ${count} allowed site${count === 1 ? '' : 's'}`;
  } else if (paused) {
    el.status.className = 'status off';
    el.statusIcon.innerHTML = icon('shield', 'xs');
    el.statusLabel.textContent = 'Paused';
    el.status.title = 'Session paused — nothing is blocked right now';
  } else {
    el.status.className = 'status off';
    el.statusIcon.innerHTML = icon('shield', 'xs');
    el.statusLabel.textContent = 'Off';
    el.status.title = 'No session running';
  }

  const existing = el.status.parentElement.querySelector('.alert');
  const alert = s.appAlert;
  if (alert && enforcing) {
    if (!existing || existing.dataset.exe !== alert.exe) {
      if (existing) existing.remove();
      const node = document.createElement('div');
      node.className = 'alert';
      node.dataset.exe = alert.exe;
      node.innerHTML = icon('app', 'xs');
      const text = document.createElement('span');
      text.textContent = `${alert.exe} put away`;
      node.appendChild(text);
      el.status.parentElement.insertBefore(node, el.settings);
    }
  } else if (existing) {
    existing.remove();
  }
}

// ---------------------------------------------------------------------- nav

function renderNav(s) {
  el.back.disabled = !s.nav.canGoBack;
  el.forward.disabled = !s.nav.canGoForward;

  if (!addressDirty && document.activeElement !== el.address) {
    el.address.value = displayUrl(s.nav.url);
  }

  const url = s.nav.url || '';
  const blocked = url.includes('blocked.html');
  const secure = url.startsWith('https://') && !blocked;

  el.addrIcon.innerHTML = icon(blocked ? 'slash' : secure ? 'lock' : 'globe', 'xs');
  el.addrIcon.classList.toggle('secure', secure);
}

function render(s) {
  state = s;
  renderTabs(s.tabs);
  renderTimer(s.session);
  renderStatus(s);
  renderNav(s);
  el.chatBtn.classList.toggle('on', !!s.chatOpen);
}

// ------------------------------------------------------------------- events

el.newTab.addEventListener('click', () => window.focusApi.newTab());
el.back.addEventListener('click', () => window.focusApi.goBack());
el.forward.addEventListener('click', () => window.focusApi.goForward());
el.reload.addEventListener('click', () => window.focusApi.reload());
el.pause.addEventListener('click', () => window.focusApi.togglePause());
el.finish.addEventListener('click', () => window.focusApi.complete());
el.settings.addEventListener('click', () => window.focusApi.openSettings());
el.chatBtn.addEventListener('click', () => window.focusApi.ai.toggle());

el.address.addEventListener('input', () => {
  addressDirty = true;
});
el.address.addEventListener('focus', () => el.address.select());
el.address.addEventListener('blur', () => {
  addressDirty = false;
  if (state) el.address.value = displayUrl(state.nav.url);
});
el.address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addressDirty = false;
    window.focusApi.navigate(el.address.value);
    el.address.blur();
  } else if (e.key === 'Escape') {
    addressDirty = false;
    if (state) el.address.value = displayUrl(state.nav.url);
    el.address.blur();
  }
});

window.focusApi.onState(render);
window.focusApi.getState().then(render);

if (window.focusApi.onFocusAddressBar) {
  window.focusApi.onFocusAddressBar(() => {
    el.address.focus();
    el.address.select();
  });
}

// Keep the countdown smooth between main-process pushes.
setInterval(() => {
  if (!state || state.session.status !== 'running') return;
  state.session.remainingMs = Math.max(0, state.session.endsAt - Date.now());
  renderTimer(state.session);
}, 250);
