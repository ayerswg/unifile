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
 *   --dsl=<variant>      build just one variant (markdown | mermaid | abcjs)
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
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
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

function detectVersion() {
  try {
    const tag = execSync('git describe --tags --abbrev=0', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().replace(/^v/, '');
    if (tag) return tag;
  } catch { /* no tags yet */ }
  try {
    return JSON.parse(execSync('cat package.json', { cwd: ROOT }).toString()).version || '0.0.0';
  } catch { return '0.0.0'; }
}
export const APP_VERSION = detectVersion();

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
const DSL_META = {
  markdown:  { abbrev: 'md',  plugins: ['markdown'],            defaultDslType: 'markdown', label: 'Unifile Markdown' },
  mermaid:   { abbrev: 'mer', plugins: ['markdown', 'mermaid'], defaultDslType: 'mermaid',  label: 'Unifile Mermaid'  },
  abcjs:     { abbrev: 'abc', plugins: ['markdown', 'abcjs'],   defaultDslType: 'abcjs',    label: 'Unifile ABC'      },
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
  if (plugins.includes('abcjs'))   esPlugins.push(loadNoteOverridePlugin);

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
      'UNIFILE_VERSION': JSON.stringify(APP_VERSION)
    },
    logOverride: { 'indirect-require': 'silent' },
    plugins: esPlugins,
  };
}

async function bundleCSS() {
  const result = await esbuild.build({
    entryPoints: [join(SRC, 'styles', 'app.css')],
    bundle: true, minify: !DEV, write: false
  });
  return result.outputFiles[0].text;
}

// ---------------------------------------------------------------------------
// Build quine
// ---------------------------------------------------------------------------

/**
 * @param {string[]} plugins         DSL modules bundled in.
 * @param {string}   defaultDslType  Seeds new documents.
 * @param {string}   outName         Output filename (e.g. 'unifile.html' or 'unifile.abc.html').
 * @param {string}   tag             Unique tag for the temp entry file.
 */
async function buildQuine(plugins, defaultDslType, outName, tag) {
  console.log(`\nBuilding quine [${outName}, dev=${DEV}]…`);

  const entryPath = await generateEntry(plugins, 'quine', tag);

  const [jsResult, css] = await Promise.all([
    esbuild.build({ ...buildOptions(entryPath, 'quine', plugins), write: false }),
    bundleCSS()
  ]);
  await unlink(entryPath).catch(() => {});

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

  const entryPath = await generateEntry(plugins, 'pwa', tag);

  const [jsResult, css] = await Promise.all([
    esbuild.build({ ...buildOptions(entryPath, 'pwa', plugins), write: false }),
    bundleCSS()
  ]);
  await unlink(entryPath).catch(() => {});

  const [pwaHtmlRaw, sw, manifestRaw] = await Promise.all([
    readFile(join(TEMPLATES, 'pwa.html'),      'utf8'),
    readFile(join(TEMPLATES, 'sw.js'),         'utf8'),
    readFile(join(TEMPLATES, 'manifest.json'), 'utf8')
  ]);

  // Stamp the variant identity into the manifest + shell so each type installs
  // as its own app, seeded with the right default DSL.
  const manifest = manifestRaw
    .replace(/"name":\s*"[^"]*"/,       () => `"name": ${JSON.stringify(appName)}`)
    .replace(/"short_name":\s*"[^"]*"/, () => `"short_name": ${JSON.stringify(appName)}`);
  const pwaHtml = pwaHtmlRaw
    .replace(/<title>[^<]*<\/title>/, () => `<title>${appName}</title>`)
    .replace(/(apple-mobile-web-app-title"\s+content=")[^"]*"/, (_, p) => `${p}${appName}"`)
    .replace(/"dslType":\s*"[^"]*"/, () => `"dslType": ${JSON.stringify(meta.defaultDslType)}`);

  // Content-hash cache version so each new build invalidates its own cache;
  // prefixed by type so it only ever supersedes caches of the same type.  Hash
  // ALL cached shell files (js, css, html, manifest) so a change to the CSP or
  // manifest alone — not just app.js — still busts the service-worker cache.
  const cacheVersion = `${cachePrefix}-${
    createHash('sha256')
      .update(jsResult.outputFiles[0].text)
      .update(css)
      .update(pwaHtml)
      .update(manifest)
      .digest('hex')
      .slice(0, 12)
  }`;
  const swStamped = sw
    .replace('UNIFILE_CACHE_PREFIX',  () => cachePrefix)
    .replace('UNIFILE_CACHE_VERSION', () => cacheVersion);

  await Promise.all([
    writeFile(join(pwaDir, 'app.js'),        jsResult.outputFiles[0].text, 'utf8'),
    writeFile(join(pwaDir, 'app.css'),       css,                          'utf8'),
    writeFile(join(pwaDir, 'index.html'),    pwaHtml,                      'utf8'),
    writeFile(join(pwaDir, 'sw.js'),         swStamped,                    'utf8'),
    writeFile(join(pwaDir, 'manifest.json'), manifest,                     'utf8')
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
  await buildQuine(meta.plugins, meta.defaultDslType, `unifile.${meta.abbrev}.html`, id);
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
