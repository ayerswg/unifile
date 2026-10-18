// abc2svg's player lives in play-1.js, a <script>-tag file: `ToAudio()` (the
// pure part — it walks a tune's time-sequenced symbol list and emits timed
// note events) followed by Audio5 / Midi5 (the Web Audio + Web MIDI players)
// and a tail IIFE that injects a `.abcr` stylesheet into `document` at load.
//
// {compose} wants only ToAudio: it feeds abc2svg's own timing to the app's
// transport, synth and highlights (see src/core/abc-timing.js), so the engine
// that DRAWS the score is the one that says when each note sounds. The players
// stay out of the bundle (ours is abcjs's synth with the offline piano), and the
// stylesheet injection must never run (it would restyle our annotation rects).
//
// `toAudioSource` slices the function out of the file's text. The esbuild
// plugin (build.mjs) wraps it as an ES module for the bundle; the Node loader
// (abc2svg-node.mjs) evaluates it for the tests. ONE slicer, so both see the
// same code — and the slice is verified so an abc2svg upgrade that moves the
// function fails the build loudly instead of shipping a silent stub.

/**
 * The text of play-1.js's `function ToAudio(){…}` (closes before its CommonJS
 * export guard). Throws when the file no longer matches.
 * @param {string} playSrc  the contents of abc2svg/play-1.js
 * @returns {string}
 */
export function toAudioSource(playSrc) {
  const start = playSrc.indexOf('function ToAudio');
  const end = start < 0 ? -1 : playSrc.indexOf("if(typeof module=='object'", start);
  if (start < 0 || end < 0) {
    throw new Error('abc2svg play-1.js: cannot find function ToAudio — check the abc2svg upgrade');
  }
  let src = playSrc.slice(start, end).trimEnd();
  // Sanity: the slice must be self-contained (its only free names are abc2svg's).
  if (!/return\{clear:function\(\)/.test(src) || !/add:function\(start,voice_tb\)/.test(src)) {
    throw new Error('abc2svg play-1.js: ToAudio changed shape — update build/abc2svg-toaudio.mjs');
  }
  // Step guard. `add` walks the time-sequenced symbols in ONE `while(s)` loop
  // and follows repeat bars by jumping back; a malformed repeat structure
  // (`|: … :| … |1 … :|2 …` — the second ending jumps to the first `|:`, whose
  // `:|` jumps again, forever) never terminates in abc2svg 1.22.1's own player.
  // A tune is at most a few hundred thousand symbol visits even with every
  // repeat played, so a hard ceiling turns a hang into a truncated event list
  // (reported as `ToAudio.truncated`), which the app can show and still play.
  const loops = src.match(/while\(s\)\{/g) ?? [];
  if (loops.length !== 1) {
    throw new Error(`abc2svg play-1.js: expected one while(s) loop in ToAudio, found ${loops.length}`);
  }
  src = src.replace('while(s){', 'var __steps=0;ToAudio.truncated=false;while(s){if(++__steps>' + MAX_STEPS + '){ToAudio.truncated=true;break}');
  return src;
}

/**
 * Symbol visits `add` may make before the event list is cut short (see above).
 * A long multi-voice tune with every repeat played is tens of thousands; the
 * runaway case reaches this in ~0.3 s, which a live preview can afford.
 */
export const MAX_STEPS = 200_000;
