/**
 * unifile build system
 *
 * Every output is fully self-contained and works 100% offline.
 * All vendor libraries are bundled by esbuild — no CDN fetches at runtime.
 *
 * The website lives in docs/ (Jekyll, GitHub Pages).  This build only produces
 * the app artifacts; `npm run build:site` copies them into docs/ for hosting.
 *
 * Every content type ships as its OWN dedicated build — one DSL bundled in per
 * quine / PWA, no runtime plugins.  There is no "universal" multi-DSL app.
 *
 * Outputs
 * -------
 *   (default, no flags)  builds every dedicated variant in DSL_META:
 *   dist/unifile.<abbrev>.html   standalone quine for each DSL
 *   dist/pwa-<abbrev>/            installable PWA for each DSL
 *
 *   --dsl=<variant>      build just one variant (markdown | mermaid | abcjs | upub)
 *     e.g. `node build/build.mjs --dsl=abcjs` → dist/unifile.abc.html (offline piano)
 *
 * npm scripts
 * -----------
 *   npm run build            default (all dedicated variants: quine + PWA each)
 *   npm run build:dev        default, unminified + inline source maps
 *   npm run build:abcjs      dedicated ABC notation build (--dsl=abcjs)
 *   npm run build:site       build app artifacts + copy into docs/ for hosting
 *   npm run site:preview     render docs/ → docs/_site (no-Ruby local preview)
 *   npm run gen:soundfont    refresh the bundled offline piano soundfont
 *
 * Pass --no-pwa to skip the PWA build.
 */

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, unlink, copyFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const SRC       = join(ROOT, 'src');
const TEMPLATES = join(ROOT, 'templates');
const DIST      = join(ROOT, 'dist');

// ---------------------------------------------------------------------------
// App version — semantic version from the latest git tag (single source of
// truth for releases), falling back to package.json.  Stamped into every build
// so a running copy knows its version and can offer an upgrade (see update-check.js).
// ---------------------------------------------------------------------------

/** Compare two "x.y.z" versions numerically (+1 / -1 / 0). */
function _verCmp(a, b) {
  const A = String(a).replace(/^v/, '').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  const B = String(b).replace(/^v/, '').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0) ? 1 : -1;
  return 0;
}

function detectVersion() {
  let tag = null;
  try {
    tag = execSync('git describe --tags --abbrev=0', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().replace(/^v/, '') || null;
  } catch { /* no tags (e.g. Cloudflare's checkout) */ }
  let pkg = null;
  try {
    pkg = JSON.parse(execSync('cat package.json', { cwd: ROOT }).toString()).version || null;
  } catch { /* no package.json?! */ }
  // The NEWER of the two wins: after `npm version X.Y.Z --no-git-tag-version`
  // (the release-flow bump) builds stamp the bumped version even before the
  // release tag exists; once the tag is cut they agree again.
  if (tag && pkg) return _verCmp(pkg, tag) > 0 ? pkg : tag;
  return tag || pkg || '0.0.0';
}
export const APP_VERSION = detectVersion();

// Build timestamp — stamped alongside the version (shown in uPub's About) so
// two builds of the SAME version are distinguishable when debugging caching.
export const APP_BUILT = new Date().toISOString().slice(0, 19) + 'Z';

// Commit identity — 7-char hash + commit timestamp, shown in About.  The dev
// channel (dev.unifile.app = the `dev` branch's Cloudflare Pages preview)
// deploys every push without a version bump, so the hash is the only way to
// tell which build you're looking at.  Cloudflare's shallow checkout has no
// tags but does have HEAD, and Pages also exports CF_PAGES_COMMIT_SHA.
function detectCommit() {
  let sha = process.env.CF_PAGES_COMMIT_SHA || null;
  if (!sha) {
    try {
      sha = execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim() || null;
    } catch { /* not a git checkout (e.g. source tarball) */ }
  }
  let at = null;
  try {
    at = execSync('git log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd', {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC' }
    }).toString().trim() || null;
  } catch { /* ditto */ }
  return { hash: sha ? sha.slice(0, 7) : '', at: at || '' };
}
export const APP_COMMIT = detectCommit();

// ---------------------------------------------------------------------------
// esbuild plugins for bundle size / offline behaviour
// ---------------------------------------------------------------------------

/**
 * Stub out the ELK graph layout engine (elkjs) — a 1.4 MB dependency pulled in
 * by mermaid's flowchart-elk diagram type.  Diagrams that request `elk` layout
 * will get a clear runtime error; all other Mermaid diagram types are unaffected.
 */
const elkjsStubPlugin = {
  name: 'elkjs-stub',
  setup(build) {
    build.onResolve({ filter: /^elkjs\// }, () => ({
      path: 'elkjs-stub', namespace: 'elkjs-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'elkjs-stub' }, () => ({
      contents: `export default class ELK {
  layout() { return Promise.reject(new Error('ELK layout is not included in this build. Use dagre or other layouts.')); }
  terminateWorker() {}
}`,
      loader: 'js',
    }));
  },
};

/**
 * Redirect abcjs's internal `require('./load-note')` to our offline note loader
 * (src/dsl/abcjs-piano-loader.js), which decodes the bundled FluidR3
 * acoustic_grand_piano soundfont on demand instead of fetching per-note mp3s.
 * Only matches the require coming from inside the abcjs package.
 */
const loadNoteOverridePlugin = {
  name: 'abcjs-load-note-override',
  setup(build) {
    build.onResolve({ filter: /load-note$/ }, (args) => {
      if (args.importer && args.importer.replace(/\\/g, '/').includes('node_modules/abcjs')) {
        return { path: join(SRC, 'dsl', 'abcjs-piano-loader.js') };
      }
      return null;
    });
  },
};

/*
 * abc2svg is a <script>-tag library: its core does `var abc2svg = {}` and hangs
 * everything off that global — no ESM/CJS exports.  To bundle it with esbuild
 * we append an `export default` so `import abc2svg from '.../abc2svg-1.js'`
 * resolves to the populated object.  (`typeof abc2svg == "undefined"` is true
 * for the hoisted-but-unassigned `var`, so its own guard still initialises it.)
 *
 * Its add-on modules (strtab-1.js = string tablature) assume the same globals:
 * `abc2svg` (now module-scoped in the core file, so import it) and a bare
 * `user` (declared by abc2svg's own web frontends; a module-scope var suffices
 * — the module only writes a no-op `user.nul` decoration handler onto it).
 */
const abc2svgExportPlugin = {
  name: 'abc2svg-export',
  setup(build) {
    build.onLoad({ filter: /abc2svg[\\/]abc2svg-1\.js$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      return { contents: src + '\nexport default abc2svg;\n', loader: 'js' };
    });
    build.onLoad({ filter: /abc2svg[\\/]strtab-1\.js$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      return {
        contents: `import abc2svg from './abc2svg-1.js';\nvar user = {};\n${src}`,
        loader: 'js',
      };
    });
  },
};

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args      = process.argv.slice(2);
const DEV       = args.includes('--dev');
const BUILD_PWA = !args.includes('--no-pwa');
const dslArg    = args.find(a => a.startsWith('--dsl='))?.split('=')[1]?.toLowerCase() ?? null;

// Fallback default DSL when makeInitialData is called without one (each variant
// passes its own meta.defaultDslType, so this is only a safety net).
const DEFAULT_DSL_TYPE = 'markdown';

// DSL metadata for dedicated builds.  Every content type is its own build with a
// single DSL bundled directly in (no runtime plugins).  `plugins` is the set of
// DSL modules bundled into the output; `defaultDslType` seeds new documents;
// `abbrev` names the output files (unifile.<abbrev>.html / pwa-<abbrev>/).
//
// A variant may instead ship its OWN shell: `entry` (relative to src/) replaces
// the generated ui/app.js entry module, and `css` (relative to src/) replaces
// styles/app.css.  The `upub` variant uses this — it has no CodeMirror and no
// DSL registry (see src/upub/).
const DSL_META = {
  markdown:  { abbrev: 'md',   plugins: ['markdown'],            defaultDslType: 'markdown', label: 'Unifile Markdown' },
  mermaid:   { abbrev: 'mer',  plugins: ['markdown', 'mermaid'], defaultDslType: 'mermaid',  label: 'Unifile Mermaid'  },
  abcjs:     { abbrev: 'abc',  plugins: ['markdown', 'abcjs'],   defaultDslType: 'abcjs',    label: 'Unifile ABC'      },
  upub:      { abbrev: 'upub', plugins: [],                      defaultDslType: 'upub',     label: 'uPub',
               entry: 'upub/main.js', css: 'styles/upub.css' },
};

if (dslArg && !DSL_META[dslArg]) {
  console.error(`Unknown --dsl: "${dslArg}". Choose: ${Object.keys(DSL_META).join(' | ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Generate a temporary entry module for esbuild.
// Only imports the DSL plugins needed — unused ones are never bundled.
// ---------------------------------------------------------------------------

async function generateEntry(plugins, mode, tag) {
  const src = `// Auto-generated entry — do not edit (regenerated on every build)
${plugins.map(p => `import './dsl/${p}.js';`).join('\n')}
import { App } from './ui/app.js';
import { state as _state } from './ui/state.js';

// Expose the state singleton for tests / preview automation (window.__uf.state).
globalThis.__uf = { state: _state };

async function main() {
  const app = new App();
  await app.init();
  if (typeof UNIFILE_MODE !== 'undefined' && UNIFILE_MODE === 'quine') {
    window.__unifile = app;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
`;
  const path = join(SRC, `_entry_${mode}_${tag}.js`);
  await writeFile(path, src, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// Embedded initial data
// ---------------------------------------------------------------------------

function makeInitialData(defaultDslType = DEFAULT_DSL_TYPE) {
  return {
    version: APP_VERSION,
    title: 'Untitled Document',
    dslType: defaultDslType,
    currentBranch: 'main',
    branches: { main: { name: 'main', head: null } },
    commits: {},
    comments: {},
    password: null
  };
}

// ---------------------------------------------------------------------------
// Shared esbuild config
// ---------------------------------------------------------------------------

/**
 * @param {string[]} plugins  DSL modules bundled into this build (used to decide
 *                            which esbuild source transforms to apply).
 */
function buildOptions(entryPoint, unifileMode, plugins) {
  const esPlugins = [];
  if (plugins.includes('mermaid')) esPlugins.push(elkjsStubPlugin);
  if (plugins.includes('abcjs'))   esPlugins.push(loadNoteOverridePlugin, abc2svgExportPlugin);

  return {
    entryPoints: [entryPoint],
    bundle: true,
    format: 'iife',
    globalName: 'Unifile',
    minify: !DEV,
    sourcemap: DEV ? 'inline' : false,
    logLevel: 'info',
    // Mark Node.js built-ins as external so they don't cause resolution errors
    // when bundled for the browser. The `buffer` module is only reached by the
    // `docx` package in environments without `atob` (i.e. never in a browser).
    external: ['buffer'],
    define: {
      'process.env.NODE_ENV': DEV ? '"development"' : '"production"',
      'UNIFILE_MODE': `"${unifileMode}"`,
      'UNIFILE_VERSION': JSON.stringify(APP_VERSION),
      'UNIFILE_BUILT': JSON.stringify(APP_BUILT),
      'UNIFILE_COMMIT': JSON.stringify(APP_COMMIT.hash),
      'UNIFILE_COMMIT_AT': JSON.stringify(APP_COMMIT.at)
    },
    logOverride: { 'indirect-require': 'silent' },
    plugins: esPlugins,
  };
}

async function bundleCSS(cssRel = 'styles/app.css') {
  const result = await esbuild.build({
    entryPoints: [join(SRC, cssRel)],
    bundle: true, minify: !DEV, write: false
  });
  return result.outputFiles[0].text;
}

// ---------------------------------------------------------------------------
// Build quine
// ---------------------------------------------------------------------------

/**
 * @param {object}   meta            DSL_META entry ({ plugins, defaultDslType, entry?, css?, … }).
 * @param {string}   outName         Output filename (e.g. 'unifile.html' or 'unifile.abc.html').
 * @param {string}   tag             Unique tag for the temp entry file.
 */
async function buildQuine(meta, outName, tag) {
  const { plugins, defaultDslType } = meta;
  console.log(`\nBuilding quine [${outName}, dev=${DEV}]…`);

  // Variants with their own shell (meta.entry) bundle that module directly;
  // standard variants get a generated entry importing their DSL plugins.
  const entryPath = meta.entry ? join(SRC, meta.entry) : await generateEntry(plugins, 'quine', tag);

  const [jsResult, css] = await Promise.all([
    esbuild.build({ ...buildOptions(entryPath, 'quine', plugins), write: false }),
    bundleCSS(meta.css)
  ]);
  if (!meta.entry) await unlink(entryPath).catch(() => {});

  const template = await readFile(join(TEMPLATES, 'quine.html'), 'utf8');

  // Gzip-compress the JS bundle and base64-encode it for the uf-bundle payload.
  // base64 contains only [A-Za-z0-9+/=] so it is safe to embed inside a <script>
  // tag without any </script>-escaping or $-substitution workarounds.
  const jsText   = jsResult.outputFiles[0].text;
  const bundleGz = gzipSync(Buffer.from(jsText), { level: 9 }).toString('base64');

  // Use replacer functions (not plain strings) so String.prototype.replace never
  // interprets $', $`, $& etc. as substitution patterns — the CSS and JSON payloads
  // could theoretically contain those sequences.
  const html = template
    .replace('/* UNIFILE_CSS */',  () => css)
    .replace('UNIFILE_BUNDLE_GZ',  () => bundleGz)
    .replace('"UNIFILE_INITIAL_DATA"', () => JSON.stringify(makeInitialData(defaultDslType), null, 2));

  await mkdir(DIST, { recursive: true });
  const outPath = join(DIST, outName);
  await writeFile(outPath, html, 'utf8');
  const rawKB  = Math.round(jsText.length    / 1024);
  const gzKB   = Math.round(bundleGz.length  / 1024);   // base64 size
  const totalKB = Math.round(html.length     / 1024);
  console.log(`  ✓ ${outPath}  (${totalKB} KB total; bundle ${rawKB}→${gzKB} KB gzip+b64)`);
}

// ---------------------------------------------------------------------------
// Build PWA
// ---------------------------------------------------------------------------

/**
 * @param {string[]} plugins         DSL modules bundled in.
 * @param {object}   meta            { abbrev, defaultDslType, label }.
 * @param {string}   tag             Build tag (the DSL id) for the temp entry.
 *
 * Each build type gets its OWN PWA directory and its own cache namespace so that
 * installing several unifile PWAs on one origin (markdown, abc, …) keeps them
 * independent — each updates itself without disturbing the others.
 *   • --dsl=abc → dist/pwa-abc/     cache prefix "unifile-abc"
 */
async function buildPWA(plugins, meta, tag) {
  const dirName     = `pwa-${meta.abbrev}`;
  const cachePrefix = `unifile-${meta.abbrev}`;
  const appName     = meta.label || 'Unifile';
  console.log(`\nBuilding PWA [${dirName}]…`);

  const pwaDir = join(DIST, dirName);
  await mkdir(pwaDir, { recursive: true });

  const entryPath = meta.entry ? join(SRC, meta.entry) : await generateEntry(plugins, 'pwa', tag);

  const [jsResult, css] = await Promise.all([
    esbuild.build({ ...buildOptions(entryPath, 'pwa', plugins), write: false }),
    bundleCSS(meta.css)
  ]);
  if (!meta.entry) await unlink(entryPath).catch(() => {});

  const [pwaHtmlRaw, sw, manifestRaw] = await Promise.all([
    readFile(join(TEMPLATES, 'pwa.html'),      'utf8'),
    readFile(join(TEMPLATES, 'sw.js'),         'utf8'),
    readFile(join(TEMPLATES, 'manifest.json'), 'utf8')
  ]);

  // Stamp the variant identity into the manifest + shell so each type installs
  // as its own app, seeded with the right default DSL.  Icons are the per-type
  // U-border set (build/icons.mjs → committed PNGs in templates/icons/<abbrev>/,
  // copied alongside the shell below).
  const manifestJson = JSON.parse(manifestRaw);
  manifestJson.name = appName;
  manifestJson.short_name = appName;
  manifestJson.icons = [
    { src: './icon-192.png',          sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png',          sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  const manifest = JSON.stringify(manifestJson, null, 2) + '\n';
  const pwaHtml = pwaHtmlRaw
    .replace(/<title>[^<]*<\/title>/, () => `<title>${appName}</title>`)
    .replace(/(apple-mobile-web-app-title"\s+content=")[^"]*"/, (_, p) => `${p}${appName}"`)
    .replace(/"dslType":\s*"[^"]*"/, () => `"dslType": ${JSON.stringify(meta.defaultDslType)}`);

  // Per-variant icon PNGs (committed; regenerate with `node build/gen-icons.mjs`).
  const iconDir = join(TEMPLATES, 'icons', meta.abbrev);
  const iconFiles = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
  const iconData = await Promise.all(iconFiles.map(f => readFile(join(iconDir, f))));

  // Content-hash cache version so each new build invalidates its own cache;
  // prefixed by type so it only ever supersedes caches of the same type.  Hash
  // ALL precached shell files (js, css, html, manifest, icons) so a change to
  // the CSP, manifest or icons alone — not just app.js — still busts the
  // service-worker cache.
  const shellHash = createHash('sha256')
    .update(jsResult.outputFiles[0].text)
    .update(css)
    .update(pwaHtml)
    .update(manifest);
  for (const buf of iconData) shellHash.update(buf);
  const cacheVersion = `${cachePrefix}-${shellHash.digest('hex').slice(0, 12)}`;
  const swStamped = sw
    .replace('UNIFILE_CACHE_PREFIX',  () => cachePrefix)
    .replace('UNIFILE_CACHE_VERSION', () => cacheVersion);

  await Promise.all([
    writeFile(join(pwaDir, 'app.js'),        jsResult.outputFiles[0].text, 'utf8'),
    writeFile(join(pwaDir, 'app.css'),       css,                          'utf8'),
    writeFile(join(pwaDir, 'index.html'),    pwaHtml,                      'utf8'),
    writeFile(join(pwaDir, 'sw.js'),         swStamped,                    'utf8'),
    writeFile(join(pwaDir, 'manifest.json'), manifest,                     'utf8'),
    ...iconFiles.map(f => copyFile(join(iconDir, f), join(pwaDir, f)))
  ]);

  const kb = ((jsResult.outputFiles[0].text.length + css.length) / 1024).toFixed(0);
  console.log(`  ✓ ${pwaDir}/  (${kb} KB JS+CSS, cache "${cachePrefix}")`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Build one dedicated variant: its quine + (optionally) its PWA. */
async function buildVariant(id) {
  const meta = DSL_META[id];
  await buildQuine(meta, `unifile.${meta.abbrev}.html`, id);
  if (BUILD_PWA) await buildPWA(meta.plugins, meta, id);
}

async function main() {
  try {
    // --dsl=<variant>: build just that variant.  Otherwise build them all.
    const variants = dslArg ? [dslArg] : Object.keys(DSL_META);
    for (const id of variants) await buildVariant(id);
    console.log('\nBuild complete. Every variant is a self-contained, offline single-DSL app.');
  } catch (err) {
    console.error('\nBuild failed:', err.message);
    process.exit(1);
  }
}

main();
