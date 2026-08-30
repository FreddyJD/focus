'use strict';

/**
 * Generates the app icon.
 *
 * The mark is the same material as the app's cards: a dark rounded square
 * (--grey-1) with a translucent white hairline border and a brighter top edge,
 * so it reads as one of the app's own surfaces catching light. Inside sits a
 * single ring — the timer, which is the one thing Focus is about.
 *
 * Written as code rather than a binary blob so the icon stays in sync with the
 * design tokens and can be regenerated at any size.
 *
 *   node tools/make-icon.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OUT = path.join(__dirname, '..', 'build');
fs.mkdirSync(OUT, { recursive: true });

// --- design tokens, matched to src/renderer/base.css -----------------------
const FILL = '#0e0f10'; // --grey-1
const BORDER = '#ffffff14'; // --border-default
const TOP_EDGE = '#ffffff12';
const RING = '#f7f8f8'; // --text-primary
const TRACK = '#2c2d30'; // --grey-6

/**
 * @param {number} s pixel size
 */
function svg(s) {
  // Windows icons read better with a little padding inside the canvas.
  const pad = Math.round(s * 0.055);
  const box = s - pad * 2;
  const r = Math.round(box * 0.225); // squircle-ish corner
  const cx = s / 2;

  const ringR = box * 0.27;
  const ringW = Math.max(2, box * 0.086);

  // Leave a gap at the top so the ring reads as a timer mid-countdown
  // rather than a plain circle. 74% of the circumference is drawn.
  const circ = 2 * Math.PI * ringR;
  const drawn = circ * 0.74;
  const gap = circ - drawn;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.09"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect x="${pad}" y="${pad}" width="${box}" height="${box}" rx="${r}" fill="${FILL}"/>
  <rect x="${pad}" y="${pad}" width="${box}" height="${box}" rx="${r}" fill="url(#edge)"/>
  <rect x="${pad + 0.5}" y="${pad + 0.5}" width="${box - 1}" height="${box - 1}" rx="${r - 0.5}"
        fill="none" stroke="${BORDER}" stroke-width="1"/>
  <rect x="${pad + 0.5}" y="${pad + 0.5}" width="${box - 1}" height="${box - 1}" rx="${r - 0.5}"
        fill="none" stroke="${TOP_EDGE}" stroke-width="1"
        stroke-dasharray="${box * 0.5} ${box * 3.5}" stroke-dashoffset="${-box * 0.25}"/>

  <circle cx="${cx}" cy="${cx}" r="${ringR}" fill="none"
          stroke="${TRACK}" stroke-width="${ringW}"/>
  <circle cx="${cx}" cy="${cx}" r="${ringR}" fill="none"
          stroke="${RING}" stroke-width="${ringW}" stroke-linecap="round"
          stroke-dasharray="${drawn} ${gap}"
          transform="rotate(-90 ${cx} ${cx})"/>
</svg>`;
}

// Sizes Windows actually uses in an .ico.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

for (const s of SIZES) {
  fs.writeFileSync(path.join(OUT, `icon-${s}.svg`), svg(s), 'utf8');
}
fs.writeFileSync(path.join(OUT, 'icon.svg'), svg(512), 'utf8');

console.log(`wrote ${SIZES.length + 1} SVGs to build/`);

// Rasterize with Electron, which is already a dependency — no ImageMagick or
// native canvas needed.
const raster = path.join(__dirname, 'rasterize.js');
try {
  execFileSync(require('electron'), [raster], { stdio: 'inherit' });
} catch (err) {
  console.error('rasterize failed:', err.message);
  process.exit(1);
}
