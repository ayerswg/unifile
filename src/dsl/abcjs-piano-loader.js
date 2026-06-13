/**
 * Offline note loader for abcjs's synthesiser.
 *
 * Drop-in replacement for abcjs's internal `src/synth/load-note.js`.  The build
 * (see `loadNoteOverridePlugin` in build/build.mjs) redirects abcjs's
 * `require('./load-note')` to this module whenever the `acoustic_grand_piano`
 * soundfont is bundled, so the synth never fetches per-note mp3 files.
 *
 * IMPORTANT: this MUST be a CommonJS module (`module.exports = getNote`).  abcjs
 * consumes it as `var getNote = require('./load-note')` and calls it directly; an
 * ES `export default` would make esbuild's interop hand back a namespace object
 * (`{ default: fn }`) instead of the function, breaking playback.
 *
 * Same signature/contract as the original `getNote(url, instrument, name, ctx)`:
 * returns a cached Promise resolving `{ instrument, name, status, audioBuffer }`.
 *
 *   • acoustic_grand_piano notes present in the bundled FluidR3 map are decoded
 *     from their base64 data URI on demand (lazy — only notes the tune uses).
 *   • anything else falls back to the original XHR behaviour, so a custom
 *     `soundfont-url` (remote) still works for other instruments.
 */

// piano-soundfont.js is an ES module (`export default {…}`); esbuild's CJS↔ESM
// interop exposes the map under `.default` when required from CommonJS.
const _sf = require('../assets/piano-soundfont.js');
const PIANO = _sf && _sf.default ? _sf.default : _sf;

// CRITICAL: use abcjs's *shared* sounds-cache, not a private object.  placeNote
// (the renderer) reads decoded buffers from `soundsCache[instrument][noteName]`
// directly — _loadBatch only uses getNote's return value for status tracking and
// never copies it into the cache.  Resolving to abcjs/src/synth/sounds-cache
// hits the same module instance esbuild gives place-note.js, so the buffers we
// store here are exactly what the renderer reads.  (Storing them in a private
// cache is what made playback silent.)
const cache = require('abcjs/src/synth/sounds-cache');

function dataUriToArrayBuffer(dataUri) {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Lightweight decode stats for on-screen diagnostics (read by abcjs.js).
const _stats = (globalThis.__ufPiano ??= { ok: 0, fail: 0, err: '' });

function decodeFromBundle(instrument, name, dataUri, audioContext) {
  return new Promise((resolve, reject) => {
    let buf;
    try { buf = dataUriToArrayBuffer(dataUri); }
    catch (e) { _stats.fail++; _stats.err = 'b64:' + e.message; reject(e); return; }
    const onDecoded = (audioBuffer) => {
      _stats.ok++;
      resolve({ instrument, name, status: 'loaded', audioBuffer });
    };
    const onErr = (e) => { _stats.fail++; _stats.err = 'decode:' + (e?.message || e || 'fail'); reject(e); };
    // decodeAudioData returns a promise in modern browsers and uses callbacks in
    // older ones — support both, matching abcjs's own load-note logic.
    const maybePromise = audioContext.decodeAudioData(buf, onDecoded, onErr);
    if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(onErr);
  });
}

// Original abcjs behaviour: XHR a single mp3 from `<url><instrument>-mp3/<name>.mp3`.
function loadViaXhr(url, instrument, name, audioContext) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const noteUrl = url + instrument + '-mp3/' + name + '.mp3';
    xhr.open('GET', noteUrl, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function () {
      if (xhr.status !== 200) {
        reject(Error("Can't load sound at " + noteUrl + ' status=' + xhr.status));
        return;
      }
      const onDecoded = (audioBuffer) =>
        resolve({ instrument, name, status: 'loaded', audioBuffer });
      const maybePromise = audioContext.decodeAudioData(xhr.response, onDecoded, function () {
        reject(Error("Can't decode sound at " + noteUrl));
      });
      if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(reject);
    };
    xhr.onerror = function () { reject(Error("Can't load sound at " + noteUrl)); };
    xhr.send();
  }).catch(err => {
    console.error("Didn't load note", instrument, name, ':', err.message);
    throw err;
  });
}

function getNote(url, instrument, name, audioContext) {
  if (!cache[instrument]) cache[instrument] = {};
  const instrumentCache = cache[instrument];

  if (!instrumentCache[name]) {
    const bundled = instrument === 'acoustic_grand_piano' ? PIANO[name] : null;
    instrumentCache[name] = bundled
      ? decodeFromBundle(instrument, name, bundled, audioContext)
      : loadViaXhr(url, instrument, name, audioContext);
  }
  return instrumentCache[name];
}

module.exports = getNote;
