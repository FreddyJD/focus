'use strict';

/**
 * Rasterizes the icon SVG to PNGs, then packs them into build/icon.ico.
 *
 * Everything renders in ONE 512px window and is downscaled from there. Tiny
 * BrowserWindows (24px) fall below the Windows minimum and fail to load, and
 * spawning a window per size is slow besides. Downscaling from a single
 * high-res render also produces cleaner small icons.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const BUILD = path.join(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const RENDER_AT = 512;

/** Build an .ico from PNG buffers (Vista+ allows PNG-compressed entries). */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;

  entries.forEach((e, i) => {
    const b = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0); // width (0 == 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1); // height
    dir.writeUInt8(0, b + 2); // palette
    dir.writeUInt8(0, b + 3); // reserved
    dir.writeUInt16LE(1, b + 4); // colour planes
    dir.writeUInt16LE(32, b + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');

  const win = new BrowserWindow({
    width: RENDER_AT,
    height: RENDER_AT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { sandbox: false },
  });

  const html =
    `<html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;width:${RENDER_AT}px;height:${RENDER_AT}px;` +
    `background:transparent;overflow:hidden}` +
    `svg{display:block;width:${RENDER_AT}px;height:${RENDER_AT}px}` +
    `</style></head><body>${svg}</body></html>`;

  const tmp = path.join(BUILD, '.render.html');
  fs.writeFileSync(tmp, html, 'utf8');

  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 500));

  const full = await win.webContents.capturePage({
    x: 0,
    y: 0,
    width: RENDER_AT,
    height: RENDER_AT,
  });

  fs.writeFileSync(path.join(BUILD, 'icon-512.png'), full.toPNG());

  const entries = [];
  for (const size of SIZES) {
    const resized = full.resize({ width: size, height: size, quality: 'best' });
    const png = resized.toPNG();
    fs.writeFileSync(path.join(BUILD, `icon-${size}.png`), png);
    entries.push({ size, png });
  }

  fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(entries));
  fs.copyFileSync(path.join(BUILD, 'icon-256.png'), path.join(BUILD, 'icon.png'));

  fs.unlinkSync(tmp);
  win.destroy();

  console.log(`icon.ico written (${entries.map((e) => e.size).join(', ')})`);
  app.exit(0);
});
