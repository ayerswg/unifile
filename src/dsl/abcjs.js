/**
 * ABC Notation DSL plugin
 *
 * Always bundled offline — no CDN fetches at runtime.
 * Rendering: abcjs (npm), bundled by esbuild.
 * Export:    SVG, PDF (via print), MIDI
 *
 * ABC notation is used for sheet music:
 *   X:1
 *   T:Title
 *   M:4/4
 *   K:C
 *   |: CDEF GABc :|
 */

import abcjs from 'abcjs';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { catppuccinHighlight } from '../ui/editor-theme.js';
import { registerDSL } from './registry.js';
import { state } from '../ui/state.js';

// ---------------------------------------------------------------------------
// Simple ABC Notation stream language for CodeMirror 6
// ---------------------------------------------------------------------------

// Header field letters (single uppercase letter followed by colon)
const ABC_HEADER_FIELDS = new Set([
  'X','T','C','M','L','Q','R','Z','N','G','H','K','P','V','I','U','W','F','O'
]);

const abcLanguage = StreamLanguage.define({
  name: 'abc',
  // Track whether we are inside a header field value (e.g. "T:My Song").
  // Header values must not have their text tokenised as note pitches.
  startState: () => ({ inHeader: false }),
  copyState: s => ({ inHeader: s.inHeader }),

  token(stream, state) {
    // Comments: % to end of line (valid anywhere, resets header context)
    if (stream.match(/%.*$/)) { state.inHeader = false; return 'comment'; }

    // At the start of each line decide whether it is a header line.
    if (stream.sol()) {
      const m = stream.string.match(/^([A-Za-z]):/);
      if (m && ABC_HEADER_FIELDS.has(m[1].toUpperCase())) {
        // Consume just the "X:" token and mark the rest of the line as header.
        stream.match(/^[A-Za-z]:/);
        state.inHeader = true;
        return 'keyword';
      }
      // Not a header line — music body or blank line.
      state.inHeader = false;
    }

    // Inside a header value: consume one character at a time with no token
    // so that letters like A–G are not misread as note pitches.
    if (state.inHeader) {
      stream.next();
      return null;
    }

    // ── Music body tokens ────────────────────────────────────────────────────
    // Barlines
    if (stream.match(/\|\||\|:|:\||\||\[|\]/)) return 'separator';

    // Rests and note lengths
    if (stream.match(/[zZ]\d*/)) return 'atom';

    // Note pitches: A-G (optionally #, b, =) followed by octave markers
    if (stream.match(/[A-Ga-g][#b=]?[,'']*/)) return 'atom';

    // Ties, slurs, beams
    if (stream.match(/[-()~]/)) return 'punctuation';

    // Chord symbols in double-quotes
    if (stream.match(/"[^"]*"/)) return 'string';

    // Numbers (time signatures, repeat counts, etc.)
    if (stream.match(/\d+/)) return 'number';

    stream.next();
    return null;
  }
});

// ---------------------------------------------------------------------------
// Module-level playback and render state
// ---------------------------------------------------------------------------

// The abcjs engraver exposes rangeHighlight(from, to) which finds all note
// elements whose source char range overlaps [from, to] and visually selects
// them (adds abcjs-note_selected class + fill="#ff0000"). Updated on every
// render; null when no ABC content has been rendered yet.
let _engraver = null;

// Full tune objects array from the last renderAbc call; needed for synth init.
let _tuneObjects = null;

// The preview container element; we add/remove 'abc-playing' class on it.
let _playEl = null;

// The last editor selection range (updated by 'editor-select' events).
// Used by playback to determine which note / range to start from.
let _lastEditorSel = { from: 0, to: 0 };

// Active playback handles (null when not playing).
let _synth = null;
let _timingCallbacks = null;
let _audioContext = null;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function render(content, el) {
  // Stop any in-progress playback when the content changes.
  if (_synth) stopPlayback();

  _engraver    = null;
  _tuneObjects = null;
  _playEl      = null;
  el.innerHTML = '';

  if (!content.trim()) {
    el.innerHTML = '<p class="preview-empty">Enter ABC notation to see sheet music.</p>';
    _setHasTune(false);
    return;
  }

  const container = document.createElement('div');
  container.className = 'abc-preview-wrap';
  el.appendChild(container);

  try {
    const tuneObjects = abcjs.renderAbc(container, content, {
      responsive: 'resize',
      add_classes: true,
      // abcjs automatically highlights the clicked element by adding the
      // class `abcjs-note_selected` and setting fill="#ff0000" on its paths.
      // We just need to tell the editor which source range to jump to.
      clickListener: (abcElem) => {
        if (abcElem.startChar !== undefined && abcElem.endChar !== undefined) {
          state.emit('dsl-select', { from: abcElem.startChar, to: abcElem.endChar });
        }
      }
    });
    // Store engraver so editor selections can drive reverse highlighting
    _engraver    = tuneObjects?.[0]?.engraver ?? null;
    _tuneObjects = tuneObjects ?? null;
    _playEl      = container;
    _setHasTune(!!(tuneObjects?.[0]));
  } catch (e) {
    el.innerHTML = `<pre class="error">ABC parse error:\n${e.message}</pre>`;
    _setHasTune(false);
  }
}

function _setHasTune(hasTune) {
  if (state.abcHasTune === hasTune) return;
  state.abcHasTune = hasTune;
  state.emit('abc-tune-state', { hasTune });
}

// ---------------------------------------------------------------------------
// Reverse highlight: editor selection → ABC preview
//
// When the user selects or positions the cursor in CodeMirror, the editor
// emits 'editor-select' with the selection range.  We call
// engraver.rangeHighlight(from, to) which walks the rendered tune tree,
// finds every note/rest whose source char range overlaps [from, to], and
// applies the standard abcjs selection visual (abcjs-note_selected class +
// fill="#ff0000").  A collapsed cursor (from === to) clears the selection.
// ---------------------------------------------------------------------------

state.on('editor-select', ({ from, to }) => {
  _lastEditorSel = { from, to };
  if (_engraver && state.data?.dslType === 'abcjs' && !state.abcPlaying) {
    try {
      _engraver.rangeHighlight(from, to);
    } catch { /* engraver may be stale after a re-render — ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Playback
//
// Three modes (determined by the current editor selection when ▶ is pressed):
//   1. No selection / cursor at 0  → play entire tune from the beginning.
//   2. Cursor inside a note        → play from that note to the end.
//   3. Range selection             → play only the notes in that range,
//                                    letting the last note finish naturally.
//
// During playback:
//   • The preview container gets class `abc-playing` (CSS overrides the
//     note highlight colour to green).
//   • Each note's source range is emitted as 'abc-play-cursor' so the editor
//     can show a green text-highlight tracking the music.
//   • The static (red) selection in the preview is suppressed while playing
//     and restored when playback stops.
// ---------------------------------------------------------------------------

async function startPlayback() {
  if (!_tuneObjects?.[0]) return;

  // Toggle off if already playing.
  if (_synth) {
    stopPlayback();
    return;
  }

  const tune = _tuneObjects[0];
  const { from: selFrom, to: selTo } = _lastEditorSel;

  // ── 1.  Determine start seconds and optional stop char ────────────────────

  let startSeconds = 0;
  let stopChar     = null; // only set for range play mode

  // Build a temporary TimingCallbacks just to read noteTimings synchronously.
  // The constructor computes the full timing table without starting any timers.
  let previewTc;
  try {
    previewTc = new abcjs.TimingCallbacks(tune, { eventCallback: () => {} });
  } catch {
    return; // tune may be malformed
  }

  const noteEvents = (previewTc.noteTimings ?? []).filter(e => e.type === 'event');

  if (selFrom !== selTo && selTo > selFrom) {
    // ── Range selection: play from first note that starts at/after selFrom,
    //    stop before the first note that starts at/after selTo.
    const startEv = noteEvents.find(e => e.startChar >= selFrom);
    if (startEv) startSeconds = startEv.milliseconds / 1000;
    stopChar = selTo;
  } else if (selFrom > 0) {
    // ── Cursor inside the document: find the note whose range contains selFrom,
    //    or the first note after selFrom if the cursor is between notes.
    const startEv =
      noteEvents.find(e => e.startChar <= selFrom && e.endChar > selFrom) ??
      noteEvents.find(e => e.startChar >= selFrom);
    if (startEv) startSeconds = startEv.milliseconds / 1000;
  }
  // else: cursor at 0 / no meaningful selection → play from beginning (startSeconds stays 0)

  // ── 2.  Initialise audio ──────────────────────────────────────────────────

  try {
    _audioContext = new AudioContext();
    await _audioContext.resume(); // unblock suspended context (browser policy)
  } catch {
    _audioContext = null;
    return;
  }

  _synth = new abcjs.synth.CreateSynth();

  try {
    await _synth.init({ visualObj: tune, audioContext: _audioContext });
    await _synth.prime();
  } catch (e) {
    console.warn('ABC synth init failed:', e);
    _synth = null;
    _audioContext?.close();
    _audioContext = null;
    return;
  }

  // Seek the audio buffer to the desired start position.
  if (startSeconds > 0) {
    _synth.pausedTimeSec = startSeconds;
  }

  // ── 3.  Initialise timing callbacks ───────────────────────────────────────

  _timingCallbacks = new abcjs.TimingCallbacks(tune, {
    eventCallback: (event) => {
      if (!event) {
        // Reached the natural end of the tune.
        stopPlayback();
        return;
      }

      // Range mode: stop when we reach the first note past the selection end.
      if (stopChar !== null && event.startChar >= stopChar) {
        stopPlayback();
        return;
      }

      // Green note highlight in the preview pane.
      try { _engraver?.rangeHighlight(event.startChar, event.endChar); } catch { /* stale */ }

      // Green text highlight in the editor.
      state.emit('abc-play-cursor', { from: event.startChar, to: event.endChar });
    }
  });

  // ── 4.  Start ─────────────────────────────────────────────────────────────

  _playEl?.classList.add('abc-playing');
  state.abcPlaying = true;
  state.emit('abc-play-state', { playing: true });

  _synth.start();
  _timingCallbacks.start(startSeconds, 'seconds');
}

function stopPlayback() {
  // Timing callbacks first (they reference _synth indirectly via closure).
  try { _timingCallbacks?.stop(); }  catch { /* ignore */ }
  _timingCallbacks = null;

  try { _synth?.stop(); }            catch { /* ignore */ }
  _synth = null;

  try { _audioContext?.close(); }    catch { /* ignore */ }
  _audioContext = null;

  _playEl?.classList.remove('abc-playing');

  state.abcPlaying = false;
  state.emit('abc-play-state', { playing: false });

  // Clear the green play cursor in the editor.
  state.emit('abc-play-cursor', null);

  // Restore the static (red) preview selection, if any.
  if (_engraver && _lastEditorSel.from !== _lastEditorSel.to) {
    try { _engraver.rangeHighlight(_lastEditorSel.from, _lastEditorSel.to); } catch { /* stale */ }
  } else if (_engraver) {
    try { _engraver.rangeHighlight(0, 0); } catch { /* stale */ }
  }
}

// External play/pause trigger (emitted by the topbar play button).
state.on('abc-play', () => {
  if (state.data?.dslType === 'abcjs') startPlayback();
});

async function renderToString(content) {
  const tmp = document.createElement('div');
  document.body.appendChild(tmp);
  try {
    abcjs.renderAbc(tmp, content, { responsive: 'resize' });
    return tmp.innerHTML;
  } catch {
    return `<pre>${content}</pre>`;
  } finally {
    document.body.removeChild(tmp);
  }
}

// ---------------------------------------------------------------------------
// Exporters
// ---------------------------------------------------------------------------

async function exportSVG(content) {
  const tmp = document.createElement('div');
  document.body.appendChild(tmp);
  abcjs.renderAbc(tmp, content, {});
  const svgContent = tmp.innerHTML;
  document.body.removeChild(tmp);
  return new Blob([svgContent], { type: 'image/svg+xml' });
}

async function exportPDF(content) {
  const svgBlob = await exportSVG(content);
  const svgUrl = URL.createObjectURL(svgBlob);
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head>
    <style>body{margin:20px}img{max-width:100%}@media print{body{margin:0}}</style>
  </head><body><img src="${svgUrl}" onload="window.print()"></body></html>`);
  win.document.close();
  return null;
}

async function exportMIDI(content) {
  // abcjs synth API for MIDI
  const midiData = abcjs.synth.getMidiFile(content, {});
  return new Blob([midiData], { type: 'audio/midi' });
}

// ---------------------------------------------------------------------------
// CodeMirror 6 editor extensions
// ---------------------------------------------------------------------------

function getEditorExtensions() {
  return [
    abcLanguage,
    syntaxHighlighting(catppuccinHighlight)
  ];
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const abcjsDSL = {
  id: 'abcjs',
  name: 'ABC Notation',
  extensions: ['.abc'],
  editorMode: 'abc',

  render,
  renderToString,
  getEditorExtensions,

  exporters: {
    svg:  { label: 'SVG',         mime: 'image/svg+xml',   ext: '.svg', export: exportSVG  },
    pdf:  { label: 'PDF (print)', mime: 'application/pdf', ext: '.pdf', export: exportPDF  },
    midi: { label: 'MIDI',        mime: 'audio/midi',      ext: '.mid', export: exportMIDI }
  },

  detect(content) {
    return /^X:\s*\d+/m.test(content) || /^T:/m.test(content);
  }
};

registerDSL(abcjsDSL);
export default abcjsDSL;
