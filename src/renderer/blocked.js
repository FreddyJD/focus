'use strict';

const api = window.focusApi;
const icon = window.Icons.icon;
const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const host = params.get('host') || '';
const reason = params.get('reason') || 'site';
const detail = params.get('detail') || '';

$('host').textContent = host || 'this page';

const COPY = {
  site: {
    title: 'Not on your list',
    message: 'This site stays blocked for the rest of your session.',
    glyph: 'slash',
  },
  redirect: {
    title: 'Redirect blocked',
    message: 'That link tried to send you outside your allowed sites.',
    glyph: 'slash',
  },
  popup: {
    title: 'Pop-up blocked',
    message: 'A pop-up tried to open a site that is not on your list.',
    glyph: 'slash',
  },
  'session-start': {
    title: 'Put away for this session',
    message: 'This tab was open when your session started.',
    glyph: 'slash',
  },
  empty: {
    title: 'Nothing is allowed yet',
    message: 'Add at least one site to your allowlist to start browsing.',
    glyph: 'alert',
  },
  error: {
    title: "This page didn't load",
    message: detail ? `The browser reported: ${detail}` : 'The page could not be reached.',
    glyph: 'alert',
  },
};

const copy = COPY[reason] || COPY.site;
$('title').textContent = copy.title;
$('message').textContent = copy.message;
$('mark').innerHTML = icon(copy.glyph, 'lg');

function button(label, primary, glyph, onClick) {
  const b = document.createElement('button');
  b.className = 'btn' + (primary ? ' btn-primary' : ' btn-secondary');
  if (glyph) b.innerHTML = icon(glyph, 'xs');
  const t = document.createElement('span');
  t.textContent = label;
  b.appendChild(t);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Rebuilt on every state change so the actions always match reality —
 * "Pause" while enforcing, "Allow this site" once paused.
 */
function render({ isEnforcing, allowedSites }) {
  const sites = allowedSites || [];
  const actions = $('actions');
  const note = $('note');
  actions.replaceChildren();

  if (reason === 'error') {
    actions.appendChild(button('Try again', true, 'reload', () => api.reload()));
  }

  if (sites.length) {
    actions.appendChild(
      button(
        reason === 'error' ? 'Go home' : 'Back to work',
        reason !== 'error',
        'arrowRight',
        () => api.navigate(`https://${sites[0]}`)
      )
    );
  }

  if (reason === 'error') {
    note.textContent = '';
  } else if (isEnforcing) {
    actions.appendChild(button('Pause session', false, 'pause', () => api.pause()));
    note.textContent = 'Your list is locked while the timer runs. Pause if you truly need this.';
  } else if (host) {
    actions.appendChild(
      button(`Allow ${host}`, false, 'plus', async () => {
        const res = await api.allowBlockedSite(host);
        if (res && !res.ok && res.reason) note.textContent = res.reason;
      })
    );
    note.textContent = 'Session is paused, so you can change your list.';
  }

  const wrap = $('allowedWrap');
  if (sites.length && reason !== 'error') {
    wrap.hidden = false;
    const chips = $('chips');
    chips.replaceChildren();
    for (const s of sites.slice(0, 10)) {
      const c = document.createElement('button');
      c.className = 'chip-link';
      c.innerHTML = icon('globe', 'xs');
      const t = document.createElement('span');
      t.textContent = s;
      c.appendChild(t);
      c.addEventListener('click', () => api.navigate(`https://${s}`));
      chips.appendChild(c);
    }
  } else {
    wrap.hidden = true;
  }
}

api.getBlockInfo().then(render);
api.onState((s) =>
  render({ isEnforcing: s.session.isEnforcing, allowedSites: s.config.allowedSites })
);
