/**
 * unifile build system
 *
 * Every output is fully self-contained and works 100% offline.
 * All vendor libraries are bundled by esbuild — no CDN fetches at runtime.
 *
 * Outputs (quine + optional PWA for each)
 * ----------------------------------------
 *   dist/unifile.md.html    markdown quine  (~475 KB)
 *   dist/unifile.mer.html   mermaid quine   (~1.2 MB)  [elkjs stubbed — no ELK layout]
 *   dist/unifile.abc.html   abc notation    (~678 KB)
 *   dist/unifile.mar.html   MARP slides     (~1.7 MB)  [unused hljs languages stubbed]
 *   dist/pwa/               installable PWA (same DSL selection)
 *
 * npm scripts
 * -----------
 *   npm run build:markdown   markdown quine + PWA
 *   npm run build:mermaid    mermaid quine  + PWA
 *   npm run build:abcjs      abc notation   + PWA
 *   npm run build:marp       MARP slides    + PWA
 *   npm run build            alias for build:markdown
 *   npm run build:dev        markdown, unminified + inline source maps
 *
 * The PWA build always accompanies the quine build.
 * Pass --no-pwa to skip it.
 */

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const SRC       = join(ROOT, 'src');
const TEMPLATES = join(ROOT, 'templates');
const DIST      = join(ROOT, 'dist');

// ---------------------------------------------------------------------------
// esbuild plugins for bundle size reduction
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
 * marp-core registers all 189+ highlight.js language grammars so that any
 * language tag in a Marp code fence can be highlighted.  Most of those grammars
 * are never used in practice and several individual files exceed 100 KB.
 *
 * This plugin intercepts `require("highlight.js/lib/languages/<name>")` calls
 * and returns an empty stub for every language NOT in the keep-list, shrinking
 * the Marp bundle by ~600–800 KB of raw JS.
 *
 * Languages in HLJS_KEEP are passed through to esbuild unchanged so they are
 * included and work normally.
 */
const HLJS_KEEP = new Set([
  'javascript', 'typescript', 'python', 'bash', 'shell',
  'html', 'xml', 'css', 'json', 'markdown', 'yaml',
  'java', 'cpp', 'c', 'csharp', 'go', 'rust', 'ruby', 'php', 'sql',
  'swift', 'kotlin', 'scala', 'r', 'perl', 'lua',
]);

const hljsLanguageFilterPlugin = {
  name: 'hljs-language-filter',
  setup(build) {
    build.onResolve({ filter: /highlight\.js\/lib\/languages\// }, args => {
      const lang = args.path.split('/').pop().replace(/\.js$/, '');
      if (HLJS_KEEP.has(lang)) return null; // keep — let esbuild resolve normally
      return { path: args.path, namespace: 'hljs-lang-stub' };
    });
    build.onLoad({ filter: /.*/, namespace: 'hljs-lang-stub' }, () => ({
      contents: 'module.exports = function() { return { name: "stub", contains: [] }; };',
      loader: 'js',
    }));
  },
};

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args      = process.argv.slice(2);
const DEV       = args.includes('--dev');
const BUILD_PWA = !args.includes('--no-pwa');

const dslArg = (args.find(a => a.startsWith('--dsl='))?.split('=')[1] ?? 'markdown').toLowerCase();

// DSL metadata — single source of truth shared by build + app (see also
// src/dsl/registry.js which stores a superset of this at runtime).
export const DSL_META = {
  markdown: { abbrev: 'md',  plugins: ['markdown'],            defaultDslType: 'markdown' },
  mermaid:  { abbrev: 'mer', plugins: ['markdown', 'mermaid'], defaultDslType: 'mermaid'  },
  abcjs:    { abbrev: 'abc', plugins: ['markdown', 'abcjs'],   defaultDslType: 'abcjs'    },
  marp:     { abbrev: 'mar', plugins: ['marp'],                defaultDslType: 'marp'     },
};

if (!DSL_META[dslArg]) {
  console.error(`Unknown --dsl: "${dslArg}". Choose: ${Object.keys(DSL_META).join(' | ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Generate a temporary entry module for esbuild.
// Only imports the DSL plugins needed — unused ones are never bundled.
// ---------------------------------------------------------------------------

async function generateEntry(plugins, mode) {
  const src = `// Auto-generated entry — do not edit (regenerated on every build)
${plugins.map(p => `import './dsl/${p}.js';`).join('\n')}
import { App } from './ui/app.js';

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
  const path = join(SRC, `_entry_${mode}_${dslArg}.js`);
  await writeFile(path, src, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// Embedded initial data
// ---------------------------------------------------------------------------

function makeInitialData(meta) {
  return {
    version: '0.1.0',
    title: 'Untitled Document',
    dslType: meta.defaultDslType,
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

function buildOptions(entryPoint, unifileMode, dsl) {
  const plugins = [];
  if (dsl === 'mermaid') plugins.push(elkjsStubPlugin);
  if (dsl === 'marp')    plugins.push(hljsLanguageFilterPlugin);

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
      'UNIFILE_MODE': `"${unifileMode}"`
    },
    logOverride: { 'indirect-require': 'silent' },
    plugins,
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

async function buildQuine(dsl, meta) {
  console.log(`\nBuilding quine [dsl=${dsl}, dev=${DEV}]…`);

  const entryPath = await generateEntry(meta.plugins, 'quine');

  const [jsResult, css] = await Promise.all([
    esbuild.build({ ...buildOptions(entryPath, 'quine', dsl), write: false }),
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
    .replace('"UNIFILE_INITIAL_DATA"', () => JSON.stringify(makeInitialData(meta), null, 2));

  await mkdir(DIST, { recursive: true });
  const outPath = join(DIST, `unifile.${meta.abbrev}.html`);
  await writeFile(outPath, html, 'utf8');
  const rawKB  = Math.round(jsText.length    / 1024);
  const gzKB   = Math.round(bundleGz.length  / 1024);   // base64 size
  const totalKB = Math.round(html.length     / 1024);
  console.log(`  ✓ ${outPath}  (${totalKB} KB total; bundle ${rawKB}→${gzKB} KB gzip+b64)`);
}

// ---------------------------------------------------------------------------
// Build PWA
// ---------------------------------------------------------------------------

async function buildPWA(dsl, meta) {
  console.log(`\nBuilding PWA [dsl=${dsl}]…`);

  const pwaDir    = join(DIST, 'pwa');
  await mkdir(pwaDir, { recursive: true });

  const entryPath = await generateEntry(meta.plugins, 'pwa');

  const [jsResult, css] = await Promise.all([
    esbuild.build({ ...buildOptions(entryPath, 'pwa', dsl), write: false }),
    bundleCSS()
  ]);
  await unlink(entryPath).catch(() => {});

  const [pwaHtml, sw, manifest] = await Promise.all([
    readFile(join(TEMPLATES, 'pwa.html'),      'utf8'),
    readFile(join(TEMPLATES, 'sw.js'),         'utf8'),
    readFile(join(TEMPLATES, 'manifest.json'), 'utf8')
  ]);

  // Stamp a content-hash-based cache version so that each new build
  // automatically invalidates the service worker cache, ensuring users
  // receive updated assets after re-deployment.
  const cacheVersion = `unifile-${
    createHash('sha256')
      .update(jsResult.outputFiles[0].text)
      .update(css)
      .digest('hex')
      .slice(0, 12)
  }`;
  const swStamped = sw.replace('UNIFILE_CACHE_VERSION', cacheVersion);

  await Promise.all([
    writeFile(join(pwaDir, 'app.js'),        jsResult.outputFiles[0].text, 'utf8'),
    writeFile(join(pwaDir, 'app.css'),       css,                          'utf8'),
    writeFile(join(pwaDir, 'index.html'),    pwaHtml,                      'utf8'),
    writeFile(join(pwaDir, 'sw.js'),         swStamped,                    'utf8'),
    writeFile(join(pwaDir, 'manifest.json'), manifest,                     'utf8')
  ]);

  const kb = ((jsResult.outputFiles[0].text.length + css.length) / 1024).toFixed(0);
  console.log(`  ✓ ${pwaDir}/  (${kb} KB JS+CSS)`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const meta = DSL_META[dslArg];
  try {
    await buildQuine(dslArg, meta);
    if (BUILD_PWA) await buildPWA(dslArg, meta);
    console.log('\nBuild complete. All outputs are fully self-contained and offline.');
  } catch (err) {
    console.error('\nBuild failed:', err.message);
    process.exit(1);
  }
}

main();
