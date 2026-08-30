'use strict';

const api = window.focusApi;
const icon = window.Icons.icon;
const $ = (id) => document.getElementById(id);

$('check').innerHTML = icon('check', 'lg');

function fmtDur(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return '0m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

let ready = false;

api.getState().then((s) => {
  const sess = s.session;
  const early = sess.endedEarly;

  $('title').textContent = early ? 'Session ended' : 'Session complete';
  $('sub').textContent = early
    ? 'You stopped before the timer ran out. Blocking is off.'
    : 'The timer ran out and blocking is off.';

  $('focused').textContent = fmtDur(sess.elapsedMs);
  $('pauses').textContent = String(sess.pauseCount);
  $('today').textContent = fmtDur(s.stats.todayMs);
  ready = true;
});

// Both routes lead back to the start screen: "New session" resets and lands
// there ready to go, and "Done" does the same rather than dropping the user
// into an unblocked browser with no session running.
$('again').addEventListener('click', () => api.newSession());
$('done').addEventListener('click', () => api.newSession());

document.addEventListener('keydown', (e) => {
  if (!ready) return;
  if (e.key === 'Escape') api.closeOverlay();
  if (e.key === 'Enter') api.closeOverlay();
});
