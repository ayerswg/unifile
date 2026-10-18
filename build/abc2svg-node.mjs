// abc2svg in Node — for the tests (and any tooling) that want the engine the
// app draws and times with, without a browser.
//
// abc2svg-1.js exports `abc2svg` and `Abc` under CommonJS; play-1.js does not
// load in Node at all (its tail touches `document`), so ToAudio is sliced out
// of it by build/abc2svg-toaudio.mjs — the same slice the esbuild plugin
// bundles — and evaluated with `abc2svg` bound as its one free name.
//
// `engraveModel(abc, source)` mirrors what src/dsl/abc2svg-render.js does in
// the app: parse + engrave, capture the FIRST tune's time-sequenced model
// through `user.get_abcmodel`, then run ToAudio over it. abc2svg's own front
// end (abcemb-1.js) stores the model there and feeds it to the player later,
// after the engraving — the order this follows.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { toAudioSource } from './abc2svg-toaudio.mjs';
import { graceStartsOf } from '../src/core/abc-timing.js';

const require = createRequire(import.meta.url);

let _lib = null;
/** `{ abc2svg, Abc, ToAudio }` — the engine + the player's event generator. */
export function loadAbc2svg() {
  if (_lib) return _lib;
  const core = require('abc2svg/abc2svg-1.js');
  const playPath = require.resolve('abc2svg/play-1.js');
  const ToAudio = new Function('abc2svg', `${toAudioSource(readFileSync(playPath, 'utf8'))}\nreturn ToAudio;`)(core.abc2svg);
  _lib = { abc2svg: core.abc2svg, Abc: core.Abc, ToAudio };
  return _lib;
}

/**
 * Engrave `source` headlessly and return abc2svg's view of it.
 * @param {string} source  ABC (already expanded the way the app expands it)
 * @returns {{ events: Float32Array[], voices: string[], errors: string[], svg: string }}
 *   `events` are ToAudio's `[istart, seconds, instr, midi, durationSeconds, volume, voiceIndex]`
 *   rows for the first tune (empty when it has none); `voices` the tune's voice ids in
 *   score order; `errors` every `errmsg` line (`file:line:col message`).
 */
export function engraveModel(source) {
  const { Abc, ToAudio } = loadAbc2svg();
  const errors = [], chunks = [];
  let model = null;
  const user = {
    read_file: () => '',
    errmsg: (m) => errors.push(String(m)),
    img_out: (s) => chunks.push(s),
    get_abcmodel: (tsfirst, voice_tb) => { if (!model) model = { tsfirst, voice_tb }; },
  };
  const abc = new Abc(user);
  abc.tosvg('node', source);
  let events = [], graceStarts = new Set();
  if (model) {
    graceStarts = graceStartsOf(model.tsfirst, loadAbc2svg().abc2svg.C);   // before ToAudio relinks the chain
    const audio = ToAudio();
    audio.add(model.tsfirst, model.voice_tb);
    events = audio.clear() ?? [];
  }
  return {
    events,
    voices: model ? model.voice_tb.map(v => String(v.id)) : [],
    graceStarts,
    errors,
    svg: chunks.join(''),
    truncated: !!ToAudio.truncated,   // the step guard cut the walk short (see abc2svg-toaudio.mjs)
  };
}
