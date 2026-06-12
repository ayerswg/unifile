/**
 * Site sync — build the apps and copy their artifacts into the Jekyll site.
 *
 * The site (docs/) is served by GitHub Pages.  The command bar lists downloads
 * and PWAs (docs/_data/apps.yml); this step makes those URLs resolve by copying
 * the built files out of dist/ into docs/:
 *
 *   dist/unifile.html      → docs/dl/unifile.html        (universal download)
 *   dist/unifile.abc.html  → docs/dl/unifile.abc.html    (ABC download)
 *   dist/pwa/              → docs/pwa/                    (universal PWA)
 *   dist/pwa-abc/          → docs/pwa-abc/                (ABC PWA)
 *
 * Run:  npm run build:site
 * (builds the universal + abcjs variants first, then copies)
 */

import { execSync } from 'child_process';
import { cp, mkdir, rm, copyFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const DOCS = join(ROOT, 'docs');

const FILES = [
  ['unifile.html',     'dl/unifile.html'],
  ['unifile.abc.html', 'dl/unifile.abc.html'],
];
const DIRS = [
  ['pwa',     'pwa'],
  ['pwa-abc', 'pwa-abc'],
];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  // 1. Build the variants (default = universal quine + PWA + plugins; then abcjs).
  console.log('Building site artifacts…');
  execSync('node build/build.mjs',            { cwd: ROOT, stdio: 'inherit' });
  execSync('node build/build.mjs --dsl=abcjs', { cwd: ROOT, stdio: 'inherit' });

  // 2. Copy standalone downloads.
  await mkdir(join(DOCS, 'dl'), { recursive: true });
  for (const [src, dst] of FILES) {
    const from = join(DIST, src);
    if (!(await exists(from))) { console.warn(`  ! missing ${src} — skipped`); continue; }
    await copyFile(from, join(DOCS, dst));
    console.log(`  ✓ docs/${dst}`);
  }

  // 3. Copy PWA directories (replace wholesale so stale assets don't linger).
  for (const [src, dst] of DIRS) {
    const from = join(DIST, src);
    if (!(await exists(from))) { console.warn(`  ! missing ${src}/ — skipped`); continue; }
    await rm(join(DOCS, dst), { recursive: true, force: true });
    await cp(from, join(DOCS, dst), { recursive: true });
    console.log(`  ✓ docs/${dst}/`);
  }

  console.log('\nSite synced. Commit docs/ and push to publish on GitHub Pages.');
}

main().catch(err => {
  console.error('\nsync-site failed:', err.message);
  process.exit(1);
});
