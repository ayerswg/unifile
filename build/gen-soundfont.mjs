/**
 * Soundfont generator
 *
 * Fetches the Paul Rosen FluidR3_GM `acoustic_grand_piano` MIDI.js soundfont
 * (a JS file declaring `MIDI.Soundfont.acoustic_grand_piano = { "A0": "data:…", … }`)
 * and emits a committed ES module at `src/assets/piano-soundfont.js`:
 *
 *   export default { "A0": "data:audio/mp3;base64,…", … };
 *
 * Committing the output keeps the build fully offline — `build.mjs` imports the
 * generated module and bundles it into the abcjs quine/PWA, where an esbuild
 * override of abcjs's internal `./load-note` decodes these data URIs on demand
 * instead of fetching per-note mp3 files at runtime.
 *
 * Run once (or whenever you want to refresh the soundfont):
 *   npm run gen:soundfont
 *
 * Network is only needed for THIS script, never for the actual build.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const INSTRUMENT = 'acoustic_grand_piano';
const SOUNDFONT_URL =
  `https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/${INSTRUMENT}-mp3.js`;
const OUT_PATH = join(ROOT, 'src', 'assets', 'piano-soundfont.js');

async function main() {
  console.log(`Fetching ${SOUNDFONT_URL} …`);
  const res = await fetch(SOUNDFONT_URL);
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  const js = await res.text();

  // The file opens with `var MIDI = {}` stubs, then
  // `MIDI.Soundfont.acoustic_grand_piano = { … };`.  Anchor on that assignment
  // so we don't grab the empty stub object, then slice the literal between its
  // first `{` and the final `}` and parse as JSON (quoted keys + quoted data-URI
  // string values → valid JSON).
  const assignIdx = js.indexOf(`MIDI.Soundfont.${INSTRUMENT}`);
  if (assignIdx === -1) {
    throw new Error(`Could not find "MIDI.Soundfont.${INSTRUMENT}" assignment.`);
  }
  const start = js.indexOf('{', assignIdx);
  const end   = js.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Could not locate the soundfont object literal.');
  }
  // MIDI.js objects end with a trailing comma (`…"C8": "…",\n}`) which JSON
  // rejects — strip any comma immediately before the closing brace.
  const objText = js.slice(start, end + 1).replace(/,(\s*})$/, '$1');

  let map;
  try {
    map = JSON.parse(objText);
  } catch (e) {
    throw new Error(`Soundfont object is not valid JSON: ${e.message}`);
  }

  const keys = Object.keys(map);
  if (keys.length < 80) {
    throw new Error(`Expected full keyboard (~88 notes), got ${keys.length}.`);
  }

  // Emit a compact-but-readable ES module (one note per line for clean diffs).
  const body = keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(map[k])},`).join('\n');
  const out = `/**
 * Offline FluidR3_GM "${INSTRUMENT}" soundfont (MIDI.js format).
 *
 * GENERATED — do not edit by hand.  Regenerate with:  npm run gen:soundfont
 * Source: ${SOUNDFONT_URL}
 *
 * Map of note name (e.g. "A0", "Db4") → base64 mp3 data URI.  Note names match
 * abcjs's pitch-to-note-name table exactly, so the build's load-note override
 * can decode these directly into AudioBuffers for fully-offline playback.
 */
export default {
${body}
};
`;

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, out, 'utf8');

  const mb = (out.length / 1024 / 1024).toFixed(2);
  console.log(`  ✓ ${OUT_PATH}  (${keys.length} notes, ${mb} MB)`);
}

main().catch(err => {
  console.error('\ngen-soundfont failed:', err.message);
  process.exit(1);
});
