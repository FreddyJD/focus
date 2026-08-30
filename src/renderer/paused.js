'use strict';

const api = window.focusApi;
const icon = window.Icons.icon;
const $ = (id) => document.getElementById(id);

$('mark').innerHTML = icon('pause', 'lg');

function fmt(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function render(state) {
  $('remaining').textContent = fmt(state.session.remainingMs);
}

// Continue is the primary action and sits on the right — the safe, expected
// choice. End session is secondary on the left, so it can't be hit by reflex.
// Ending returns to the start screen rather than closing the app; quitting is
// a separate, deliberate click from there.
$('resume').addEventListener('click', () => api.resume());
$('quit').addEventListener('click', () => api.quitSession());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Enter') {
    e.preventDefault();
    api.resume();
  }
});

api.onState(render);
api.getState().then(render);
