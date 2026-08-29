/**
 * One-off: rasterize the U-border icon system (build/icons.mjs) into the PNG
 * sizes the PWAs need, committed under templates/icons/<abbrev>/:
 *
 *   icon-192.png            manifest icon (purpose: any)
 *   icon-512.png            manifest icon (purpose: any)
 *   icon-maskable-512.png   manifest icon (purpose: maskable — art inset to
 *                           the ~80% safe zone so OS masks don't clip the U)
 *   apple-touch-icon.png    180×180, iOS home-screen icon (iOS ignores the
 *                           manifest icons; needs the <link rel> in pwa.html)
 *
 * Rendering uses headless Chromium (Playwright's bundled binary, or set
 * CHROMIUM=/path/to/chrome).  Like gen-soundfont.mjs this is a dev-machine
 * tool — the PNGs are committed so CI/Cloudflare builds never need a browser.
 *
 *   node build/gen-icons.mjs
 */

import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { inflateSync, deflateSync, crc32 } from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { ICONS, iconSvg, ICON_BG, ICON_FG } from './icons.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT  = join(ROOT, 'templates', 'icons');

const CHROMIUM = process.env.CHROMIUM
  || '/opt/pw-browsers/chromium';   // Playwright-managed install

const SIZES = [
  { file: 'icon-192.png',          size: 192, pad: 0.02 },
  { file: 'icon-512.png',          size: 512, pad: 0.02 },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.13 },
  { file: 'apple-touch-icon.png',  size: 180, pad: 0.05 },
];

const BASE_FLAGS = [
  '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=1',
];

/**
 * `--window-size` is the OUTER window; headless still reserves some chrome
 * height, so the viewport comes out short (screenshots get a white band).
 * Calibrate once: load a page that prints its own innerWidth×innerHeight,
 * read it back via --dump-dom, and remember the deficit to compensate.
 */
async function viewportDeficit() {
  const page = join(tmpdir(), `uf-icon-probe-${process.pid}.html`);
  await writeFile(page,
    `<!doctype html><body><script>document.body.textContent = innerWidth + 'x' + innerHeight;</script></body>`, 'utf8');
  const dom = execFileSync(CHROMIUM,
    [...BASE_FLAGS, '--dump-dom', '--window-size=500,500', `file://${page}`],
    { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  await rm(page, { force: true });
  const m = dom.match(/(\d+)x(\d+)/);
  if (!m) throw new Error('viewport probe failed');
  return { w: 500 - +m[1], h: 500 - +m[2] };
}
const DEFICIT = await viewportDeficit();

async function raster(svg, size, outPath) {
  const page = join(tmpdir(), `uf-icon-${process.pid}.html`);
  await writeFile(page,
    `<!doctype html><body style="margin:0">${svg.replace('<svg ', '<svg style="display:block" ')}</body>`, 'utf8');
  execFileSync(CHROMIUM, [
    ...BASE_FLAGS,
    `--screenshot=${outPath}`,
    `--window-size=${size + DEFICIT.w},${size + DEFICIT.h}`, `file://${page}`,
  ], { stdio: 'ignore' });
  await rm(page, { force: true });
  await cropPng(outPath, size, size);
}

/**
 * The screenshot canvas is the OUTER window (viewport + the reserved chrome
 * rows padded white at the bottom), so after compensating the viewport we
 * still have to crop the PNG back to size×size.  Minimal PNG surgery — decode
 * scanlines (zlib inflate + per-row unfilter), keep the top `ch` rows,
 * re-encode with filter 0.
 */
async function cropPng(path, cw, ch) {
  const png = await readFile(path);
  let pos = 8, w = 0, h = 0, bitDepth = 8, colorType = 2, idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos), type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      w = png.readUInt32BE(pos + 8); h = png.readUInt32BE(pos + 12);
      bitDepth = png[pos + 16]; colorType = png[pos + 17];
    } else if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`unexpected PNG format in ${path}`);
  if (w === cw && h === ch) return;
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  // Unfilter all rows (Paeth et al. reference the previous row, so we can't
  // just slice), then re-emit the crop with filter type 0.
  const prev = Buffer.alloc(stride);
  const out = Buffer.alloc(ch * (cw * bpp + 1));
  for (let y = 0; y < h; y++) {
    const flt = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      if (flt === 1) row[i] = (row[i] + a) & 255;
      else if (flt === 2) row[i] = (row[i] + b) & 255;
      else if (flt === 3) row[i] = (row[i] + ((a + b) >> 1)) & 255;
      else if (flt === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    row.copy(prev);
    if (y < ch) row.copy(out, y * (cw * bpp + 1) + 1, 0, cw * bpp);
  }
  const chunk = (type, data) => {
    const buf = Buffer.alloc(12 + data.length);
    buf.writeUInt32BE(data.length, 0); buf.write(type, 4);
    data.copy(buf, 8);
    buf.writeUInt32BE(crc32(buf.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return buf;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cw, 0); ihdr.writeUInt32BE(ch, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  await writeFile(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

for (const [id, { glyph, abbrev, codename }] of Object.entries(ICONS)) {
  const dir = join(OUT, abbrev);
  await mkdir(dir, { recursive: true });
  for (const { file, size, pad } of SIZES) {
    const svg = iconSvg(glyph, { size, pad, fg: ICON_FG, bg: ICON_BG });
    await raster(svg, size, join(dir, file));
  }
  console.log(`  ✓ templates/icons/${abbrev}/  (${codename})`);
}
console.log('Icons rasterized. Commit templates/icons/.');
