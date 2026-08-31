'use strict';

const api = window.focusApi;
const icon = window.Icons.icon;
const D = window.Dither;
const $ = (id) => document.getElementById(id);

$('icoGrid').innerHTML = icon('app', 'xs');
$('icoBars').innerHTML = icon('clock', 'xs');

// Monochrome: intensity is carried by dither density, not hue.
const INK = '#f7f8f8';
const EMPTY = '#1d1e20';
const CELL = 11; // heatmap cell size
const GAP = 3;

let data = null;

function fmt(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return '0m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtLong(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'nothing yet';
  if (min === 1) return '1 minute';
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h} hour${h === 1 ? '' : 's'}`;
}

function niceDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Map a day's minutes to dither intensity.
 *
 * Scaled against a 4-hour reference rather than the user's best day, so the
 * chart doesn't rescale every time a record is broken — a solid cell always
 * means the same thing. sqrt keeps short sessions visible instead of letting
 * one long day wash everything else out.
 */
function levelFor(ms) {
  if (ms <= 0) return 0;
  const REF = 4 * 60 * 60 * 1000;
  const t = Math.min(1, ms / REF);
  return 0.18 + Math.sqrt(t) * 0.82;
}

// ------------------------------------------------------------------ heatmap

let heatCells = [];

function drawHeat(days) {
  const canvas = $('heat');
  const LABEL_W = 30;
  const TOP = 18;

  // Start on the Sunday on or before the first day, so weeks are columns.
  const first = days[0];
  const lead = first.dow;
  const total = lead + days.length;
  const weeks = Math.ceil(total / 7);

  const w = LABEL_W + weeks * (CELL + GAP);
  const h = TOP + 7 * (CELL + GAP);
  const ctx = D.setup(canvas, w, h);

  ctx.clearRect(0, 0, w, h);
  heatCells = [];

  // Weekday labels
  ctx.fillStyle = '#5f6165';
  ctx.font = '10px "Inter Variable", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const [row, label] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    ctx.fillText(label, 0, TOP + row * (CELL + GAP) + CELL / 2);
  }

  let lastMonth = -1;
  for (let i = 0; i < days.length; i++) {
    const slot = lead + i;
    const col = Math.floor(slot / 7);
    const row = slot % 7;
    const x = LABEL_W + col * (CELL + GAP);
    const y = TOP + row * (CELL + GAP);
    const day = days[i];

    // Month label at the top of the first column of each month.
    const month = Number(day.date.slice(5, 7));
    if (month !== lastMonth && row <= 1) {
      ctx.fillStyle = '#5f6165';
      ctx.fillText(
        new Date(day.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short' }),
        x,
        8
      );
      lastMonth = month;
    }

    // Empty cells still get a faint plate so the grid reads as a calendar.
    ctx.save();
    D.roundRect(ctx, x, y, CELL, CELL, 2);
    ctx.fillStyle = EMPTY;
    ctx.fill();
    ctx.restore();

    const level = levelFor(day.ms);
    if (level > 0) {
      D.fillRoundRect(ctx, { x, y, w: CELL, h: CELL, r: 2, level, color: INK, dot: 2 });
    }

    heatCells.push({ x, y, w: CELL, h: CELL, day });
  }

  // Legend swatches, same scale as the grid.
  const lc = $('legend');
  const lctx = D.setup(lc, 5 * (CELL + 2), CELL);
  for (let i = 0; i < 5; i++) {
    const x = i * (CELL + 2);
    lctx.save();
    D.roundRect(lctx, x, 0, CELL, CELL, 2);
    lctx.fillStyle = EMPTY;
    lctx.fill();
    lctx.restore();
    if (i > 0) {
      D.fillRoundRect(lctx, {
        x,
        y: 0,
        w: CELL,
        h: CELL,
        r: 2,
        level: 0.18 + (i / 4) * 0.82,
        color: INK,
        dot: 2,
      });
    }
  }
}

// --------------------------------------------------------------- bar chart

let barRects = [];
const BAR_DAYS = 30;

function drawBars(allDays) {
  const days = allDays.slice(-BAR_DAYS);
  const canvas = $('bars');

  const AXIS_W = 34;
  const H = 150;
  const BOTTOM = 20;
  const barW = 14;
  const gap = 6;
  const w = AXIS_W + days.length * (barW + gap);
  const plotH = H - BOTTOM - 10;

  const ctx = D.setup(canvas, w, H);
  ctx.clearRect(0, 0, w, H);
  barRects = [];

  const max = Math.max(...days.map((d) => d.ms), 60 * 60 * 1000); // >= 1h scale

  // Gridlines + y labels, rounded to whole hours.
  ctx.font = '10px "Inter Variable", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const hours = Math.max(1, Math.ceil(max / 3600000));
  const step = hours <= 4 ? 1 : Math.ceil(hours / 4);
  for (let hLine = 0; hLine <= hours; hLine += step) {
    const ms = hLine * 3600000;
    const y = 10 + plotH - (ms / max) * plotH;
    ctx.fillStyle = '#1d1e20';
    ctx.fillRect(AXIS_W, y, w - AXIS_W, 1);
    ctx.fillStyle = '#5f6165';
    ctx.fillText(`${hLine}h`, 0, y);
  }

  days.forEach((day, i) => {
    const x = AXIS_W + i * (barW + gap);
    const bh = day.ms > 0 ? Math.max(3, (day.ms / max) * plotH) : 0;
    const y = 10 + plotH - bh;

    if (bh > 0) {
      D.fillRoundRect(ctx, {
        x,
        y,
        w: barW,
        h: bh,
        r: 2,
        level: 0.35 + 0.65 * (day.ms / max),
        color: INK,
        dot: 2,
      });
    } else {
      // A flat tick keeps zero days visible instead of looking like a gap.
      ctx.fillStyle = '#1d1e20';
      ctx.fillRect(x, 10 + plotH - 1, barW, 1);
    }

    // Date label every 5th bar, plus the last.
    if (i % 5 === 0 || i === days.length - 1) {
      ctx.fillStyle = '#5f6165';
      ctx.fillText(day.date.slice(8), x, H - BOTTOM / 2);
    }

    barRects.push({ x, y: 10, w: barW, h: plotH, day });
  });
}

// ---------------------------------------------------------------- tooltip

function attachTip(canvas, getRects) {
  const tip = $('tip');

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;

    const hit = getRects().find(
      (c) => mx >= c.x && mx <= c.x + c.w && my >= c.y && my <= c.y + c.h
    );

    if (!hit) {
      tip.classList.remove('show');
      return;
    }

    const d = hit.day;
    tip.innerHTML =
      `<strong>${d.ms > 0 ? fmtLong(d.ms) : 'No focus'}</strong>` +
      `<span class="d"> · ${niceDate(d.date)}</span>` +
      (d.sessions ? `<span class="d"> · ${d.sessions} session${d.sessions === 1 ? '' : 's'}</span>` : '');
    tip.classList.add('show');
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 240) + 'px';
    tip.style.top = e.clientY - 34 + 'px';
  });

  canvas.addEventListener('mouseleave', () => $('tip').classList.remove('show'));
}

// ------------------------------------------------------------------ render

function render(a) {
  data = a;
  const days = a.days;

  const today = days[days.length - 1];
  const week = days.slice(-7).reduce((s, d) => s + d.ms, 0);

  $('figToday').textContent = fmt(today ? today.ms : 0);
  $('figWeek').textContent = fmt(week);
  $('figStreak').textContent = a.currentStreak ? `${a.currentStreak}d` : '0d';
  $('figBest').textContent = fmt(a.bestDayMs);

  $('yearTotal').textContent =
    a.activeDays > 0
      ? `${fmt(a.totalMs)} across ${a.activeDays} day${a.activeDays === 1 ? '' : 's'}`
      : '';
  $('barRange').textContent = `last ${Math.min(BAR_DAYS, days.length)} days`;

  if (a.activeDays === 0) {
    $('sub').textContent =
      'No sessions recorded yet. Finish one and it will show up here.';
  }

  drawHeat(days);
  drawBars(days);
}

attachTip($('heat'), () => heatCells);
attachTip($('bars'), () => barRects);

$('close').addEventListener('click', () => api.closeActivity());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Enter') api.closeActivity();
});

api.getActivity().then(render);
