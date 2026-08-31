'use strict';

/**
 * Ordered (Bayer) dithering for canvas charts.
 *
 * Instead of drawing flat fills, intensity is expressed as a pixel pattern:
 * the classic 8x8 Bayer threshold matrix decides whether each cell in a grid
 * gets a dot. Low values leave sparse dots, high values fill solid. That gives
 * the charts a crisp, screen-printed look and — more usefully — makes
 * intensity readable by texture as well as brightness.
 *
 * Implemented directly rather than pulled from a package: it's a well-known
 * ~40-line algorithm, and the one library suggested for this failed to resolve
 * (SSL error, flagged as a potential threat), which is not something worth
 * wiring into an app that runs on your machine.
 */

(function () {
  // Normalized 8x8 Bayer matrix, values 0..63 mapped to 0..1.
  const BAYER_8 = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];

  const N = 8;

  /** Threshold at grid position, in 0..1. */
  function threshold(x, y) {
    return (BAYER_8[y % N][x % N] + 0.5) / (N * N);
  }

  /**
   * Fill a rect with a dithered pattern.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} o
   * @param {number} o.x,o.y,o.w,o.h   rect in CSS pixels
   * @param {number} o.level           0..1 intensity
   * @param {string} o.color           dot colour
   * @param {number} [o.dot]           dot size in CSS pixels
   */
  function fillRect(ctx, { x, y, w, h, level, color, dot = 2 }) {
    const v = Math.max(0, Math.min(1, level));
    if (v <= 0) return;

    ctx.fillStyle = color;

    const cols = Math.ceil(w / dot);
    const rows = Math.ceil(h / dot);
    // Anchor the pattern to absolute position so neighbouring cells form one
    // continuous texture rather than each restarting the matrix.
    const ox = Math.round(x / dot);
    const oy = Math.round(y / dot);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (v > threshold(ox + c, oy + r)) {
          const px = x + c * dot;
          const py = y + r * dot;
          const pw = Math.min(dot, x + w - px);
          const ph = Math.min(dot, y + h - py);
          if (pw > 0 && ph > 0) ctx.fillRect(px, py, pw, ph);
        }
      }
    }
  }

  /** Rounded-rect path helper. */
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** Dithered fill clipped to a rounded rect. */
  function fillRoundRect(ctx, { x, y, w, h, r = 2, level, color, dot = 2 }) {
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    fillRect(ctx, { x, y, w, h, level, color, dot });
    ctx.restore();
  }

  /** Size a canvas for the display's pixel ratio. Returns the 2D context. */
  function setup(canvas, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    return ctx;
  }

  window.Dither = { fillRect, fillRoundRect, roundRect, setup, threshold };
})();
