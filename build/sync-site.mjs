/**
 * Site sync — build the apps and copy their artifacts into the Jekyll site.
 *
 * The site (docs/) is served by GitHub Pages.  The command bar lists downloads
 * and PWAs (docs/_data/apps.yml); this step makes those URLs resolve by copying
 * each dedicated build's files out of dist/ into docs/:
 *
 *   dist/unifile.md.html   → docs/dl/unifile.md.html      (Markdown download)
 *   dist/unifile.mer.html  → docs/dl/unifile.mer.html     (Mermaid download)
 *   dist/unifile.abc.html  → docs/dl/unifile.abc.html     (ABC download)
 *   dist/pwa-md/           → docs/pwa-md/                  (Markdown PWA)
 *   dist/pwa-mer/          → docs/pwa-mer/                 (Mermaid PWA)
 *   dist/pwa-abc/          → docs/pwa-abc/                 (ABC PWA)
 *
 * Run:  npm run build:site
 * (builds every dedicated variant first, then copies)
 */

import { execSync } from 'child_process';
import { cp, mkdir, rm, copyFile, access, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const DOCS = join(ROOT, 'docs');

/** Latest git tag (semver source of truth), fallback to package.json. */
function detectVersion() {
  try {
    const tag = execSync('git describe --tags --abbrev=0', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().replace(/^v/, '');
    if (tag) return tag;
  } catch { /* no tags */ }
  try { return JSON.parse(execSync('cat package.json', { cwd: ROOT }).toString()).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

// --- SemVer 2.0 precedence (mirror of src/ui/update-check.js) -----------------
function _parse(v) {
  const [core, pre] = String(v).trim().replace(/^v/, '').split('-');
  const n = core.split('.').map(x => parseInt(x, 10) || 0);
  return { core: [n[0] || 0, n[1] || 0, n[2] || 0], pre: pre ? pre.split('.') : null };
}
function _cmp(a, b) {
  const A = _parse(a), B = _parse(b);
  for (let i = 0; i < 3; i++) if (A.core[i] !== B.core[i]) return A.core[i] > B.core[i] ? 1 : -1;
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x > +y ? 1 : -1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Resolve the two update channels from git tags:
 *   • latest  = highest version overall (may be a pre-release / RC)
 *   • stable  = highest version with no pre-release suffix
 * Falls back to detectVersion() when no tags exist.
 */
function detectChannels() {
  let tags = [];
  try {
    tags = execSync('git tag', { cwd: ROOT }).toString().split('\n')
      .map(t => t.trim().replace(/^v/, '')).filter(Boolean);
  } catch { /* no tags */ }
  // package.json's version competes too: after the release-flow bump (npm
  // version --no-git-tag-version) but before the tag is cut, the bumped
  // version must publish — otherwise version.json stays on the old release.
  try {
    const pkg = JSON.parse(execSync('cat package.json', { cwd: ROOT }).toString()).version;
    if (pkg) tags.push(pkg);
  } catch { /* ignore */ }
  if (!tags.length) { const v = detectVersion(); return { stable: v, latest: v }; }
  const sorted = tags.slice().sort((a, b) => _cmp(b, a)); // desc
  const latest = sorted[0];
  const stable = sorted.find(v => !v.includes('-')) ?? latest;
  return { stable, latest };
}

/** 7-char commit hash + commit time (UTC) — mirrors detectCommit in build.mjs. */
function detectCommit() {
  let sha = process.env.CF_PAGES_COMMIT_SHA || null;
  if (!sha) {
    try {
      sha = execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim() || null;
    } catch { /* not a git checkout */ }
  }
  let at = null;
  try {
    at = execSync('git log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd', {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC' }
    }).toString().trim() || null;
  } catch { /* ditto */ }
  return { hash: sha ? sha.slice(0, 7) : '', at: at || '' };
}

const FILES = [
  ['unifile.md.html',   'dl/unifile.md.html'],
  ['unifile.mer.html',  'dl/unifile.mer.html'],
  ['unifile.abc.html',  'dl/unifile.abc.html'],
  ['unifile.upub.html', 'dl/unifile.upub.html'],
];
const DIRS = [
  ['pwa-md',   'pwa-md'],
  ['pwa-mer',  'pwa-mer'],
  ['pwa-abc',  'pwa-abc'],
  ['pwa-upub', 'pwa-upub'],
];

// Stale artifacts to delete from docs/ (the universal multi-DSL build is gone,
// and the writer→uPub rename retired the wr-named outputs).
const REMOVE_FILES = ['dl/unifile.html', 'dl/unifile.wr.html'];
const REMOVE_DIRS  = ['pwa', 'pwa-wr'];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  // 1. Build every dedicated variant (markdown, mermaid, abcjs → quine + PWA each).
  console.log('Building site artifacts…');
  execSync('node build/build.mjs', { cwd: ROOT, stdio: 'inherit' });

  // 1b. Remove any stale universal artifacts left from the old multi-DSL build.
  for (const rel of REMOVE_FILES) {
    await rm(join(DOCS, rel), { force: true });
  }
  for (const rel of REMOVE_DIRS) {
    await rm(join(DOCS, rel), { recursive: true, force: true });
  }

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

  // 4. Publish the version channels so installed/hosted apps can offer an upgrade.
  //    `version` (= stable) is kept for backward-compat with older clients that
  //    read a single field; new clients pick `stable` or `latest` per the user's
  //    release-candidate opt-in (Settings).
  const { stable, latest } = detectChannels();
  const commit = detectCommit();
  await writeFile(join(DOCS, 'version.json'),
    JSON.stringify({
      version: stable, stable, latest, released: new Date().toISOString(),
      commit: commit.hash, commitAt: commit.at
    }, null, 2) + '\n', 'utf8');
  console.log(`  ✓ docs/version.json  (stable v${stable}, latest v${latest}, commit ${commit.hash || 'n/a'})`);

  console.log('\nSite synced. Commit docs/ and push to publish on GitHub Pages.');
}

main().catch(err => {
  console.error('\nsync-site failed:', err.message);
  process.exit(1);
});
