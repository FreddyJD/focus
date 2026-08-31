'use strict';

const api = window.focusApi;
const icon = window.Icons.icon;
const $ = (id) => document.getElementById(id);

const el = {
  heading: $('heading'),
  subheading: $('subheading'),
  durationSection: $('durationSection'),
  durations: $('durations'),
  siteInput: $('siteInput'),
  addSite: $('addSite'),
  siteList: $('siteList'),
  siteCount: $('siteCount'),
  siteErr: $('siteErr'),
  blockApps: $('blockApps'),
  appCollapse: $('appCollapse'),
  addApp: $('addApp'),
  appList: $('appList'),
  strictMode: $('strictMode'),
  stats: $('stats'),
  start: $('start'),
  cancel: $('cancel'),
};

$('icoClock').innerHTML = icon('clock', 'xs');
$('icoGlobe').innerHTML = icon('globe', 'xs');
$('icoApp').innerHTML = icon('app', 'xs');
$('icoShield').innerHTML = icon('shield', 'xs');

const PRESETS = [15, 25, 50, 90];
let selected = 50;
let customActive = false;
let state = null;

// ----------------------------------------------------------------- duration

function label(min) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function renderDurations() {
  el.durations.replaceChildren();

  for (const min of PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip' + (!customActive && selected === min ? ' sel' : '');
    b.textContent = label(min);
    b.addEventListener('click', () => {
      selected = min;
      customActive = false;
      renderDurations();
    });
    el.durations.appendChild(b);
  }

  const custom = document.createElement('div');
  custom.className = 'chip custom' + (customActive ? ' sel' : '');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.max = '480';
  input.value = customActive ? String(selected) : '';
  input.placeholder = '00';
  input.setAttribute('aria-label', 'Custom minutes');
  input.addEventListener('focus', () => {
    customActive = true;
    custom.classList.add('sel');
    for (const c of el.durations.querySelectorAll('.chip:not(.custom)')) c.classList.remove('sel');
  });
  input.addEventListener('input', () => {
    const v = Math.min(480, Math.max(1, Number(input.value) || 0));
    if (v) selected = v;
  });
  const unit = document.createElement('span');
  unit.textContent = 'm';
  custom.append(input, unit);
  el.durations.appendChild(custom);
}

// -------------------------------------------------------------------- lists

function tagFor(value, onRemove) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  const text = document.createElement('span');
  text.textContent = value;
  const x = document.createElement('button');
  x.innerHTML = icon('close', 'xs');
  x.title = `Remove ${value}`;
  x.setAttribute('aria-label', `Remove ${value}`);
  x.addEventListener('click', onRemove);
  tag.append(text, x);
  return tag;
}

function renderSites(sites) {
  el.siteList.replaceChildren();
  el.siteCount.textContent = sites.length ? String(sites.length) : '';

  if (!sites.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.innerHTML = icon('alert', 'xs');
    const t = document.createElement('span');
    t.textContent = 'Add at least one site to begin.';
    p.appendChild(t);
    el.siteList.appendChild(p);
    return;
  }
  for (const s of sites) {
    el.siteList.appendChild(tagFor(s, () => api.removeSite(s)));
  }
}

function renderApps(apps) {
  el.appList.replaceChildren();
  if (!apps.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    const t = document.createElement('span');
    t.textContent = 'Focus is always allowed.';
    p.appendChild(t);
    el.appList.appendChild(p);
    return;
  }
  for (const a of apps) {
    el.appList.appendChild(tagFor(a, () => api.removeApp(a)));
  }
}

function fmtDur(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return '0m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ------------------------------------------------------------------- render

function render(s) {
  const first = state === null;
  state = s;

  if (first) {
    selected = s.config.durationMin || 50;
    customActive = !PRESETS.includes(selected);
    el.blockApps.checked = !!s.config.blockApps;
    el.strictMode.checked = !!s.config.strictMode;
    renderDurations();
  }

  renderSites(s.config.allowedSites);
  renderApps(s.config.allowedApps);
  el.appCollapse.classList.toggle('open', el.blockApps.checked);

  const running = s.session.isActive;
  el.heading.textContent = running ? 'Session settings' : 'Start a focus session';
  el.subheading.textContent = running
    ? 'Changes apply right away. Your allowlist is editable while paused.'
    : 'Only the sites you allow will load. Everything else is blocked until the timer ends.';
  el.start.textContent = running ? 'Back to browsing' : 'Start focusing';
  // On the initial screen this is the real way out of the app. During a
  // session it just dismisses the settings panel.
  el.cancel.textContent = running ? 'Close' : 'Quit Focus';
  el.cancel.hidden = false;
  el.durationSection.hidden = running;

  const st = s.stats;
  el.stats.replaceChildren();

  // An update banner takes priority over stats — it's the only thing in this
  // footer that needs an action.
  const up = s.update;
  if (up && up.downloaded) {
    el.stats.innerHTML = icon('arrowRight', 'xs');
    const t = document.createElement('button');
    t.className = 'update-link';
    t.textContent = `Update to ${up.version || 'the latest version'} — restart now`;
    t.addEventListener('click', () => api.installUpdate());
    el.stats.appendChild(t);
  } else {
    // Clicking anywhere here opens the day-by-day charts.
    const btn = document.createElement('button');
    btn.className = 'stats-link';
    btn.title = 'See your focus history';

    const last = s.lastSession;
    let label;
    if (st.todayCount) {
      label = `${fmtDur(st.todayMs)} focused today`;
    } else if (last) {
      // Be specific rather than showing a hopeful zero: the last real session
      // is the honest thing to report.
      label = `Last session ${fmtDur(last.elapsedMs)}`;
    } else {
      label = 'No sessions yet';
    }

    btn.innerHTML = icon(st.todayCount ? 'check' : 'clock', 'xs');
    const t = document.createElement('span');
    t.className = 'label';
    t.textContent = label;
    btn.appendChild(t);

    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.innerHTML = icon('forward', 'xs');
    btn.appendChild(chev);

    btn.addEventListener('click', () => api.openActivity());
    el.stats.appendChild(btn);
  }

  el.start.disabled = !running && s.config.allowedSites.length === 0;
}

// ------------------------------------------------------------------- events

function showError(message) {
  el.siteErr.replaceChildren();
  if (!message) {
    el.siteErr.classList.remove('show');
    return;
  }
  el.siteErr.innerHTML = icon('alert', 'xs');
  const t = document.createElement('span');
  t.textContent = message;
  el.siteErr.appendChild(t);
  el.siteErr.classList.add('show');
}

async function submitSite() {
  const value = el.siteInput.value.trim();
  if (!value) return;
  const res = await api.addSite(value);
  if (res && res.ok) {
    el.siteInput.value = '';
    showError('');
  } else {
    showError((res && res.reason) || 'Could not add that.');
  }
}

el.addSite.addEventListener('click', submitSite);
el.siteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitSite();
});
el.siteInput.addEventListener('input', () => showError(''));

el.addApp.addEventListener('click', () => api.addApp());

el.blockApps.addEventListener('change', () => {
  el.appCollapse.classList.toggle('open', el.blockApps.checked);
  api.setConfig({ blockApps: el.blockApps.checked });
});
el.strictMode.addEventListener('change', () => {
  api.setConfig({ strictMode: el.strictMode.checked });
});

el.start.addEventListener('click', () => {
  if (state && state.session.isActive) api.closeOverlay();
  else api.startSession({ durationMin: selected });
});
el.cancel.addEventListener('click', () => {
  // Initial screen: this closes the app. Mid-session: just hides the panel.
  if (state && state.session.isActive) api.closeOverlay();
  else api.quit();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state && state.session.isActive) api.closeOverlay();
  // Enter starts the session, unless focus is in the site input.
  if (e.key === 'Enter' && document.activeElement !== el.siteInput) {
    if (state && !state.session.isActive && !el.start.disabled) {
      api.startSession({ durationMin: selected });
    }
  }
});

api.onState(render);
api.getState().then(render);
