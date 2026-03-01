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
    // %% formatting directives (%%tablature, %%score, %%MIDI, etc.) are
    // meaningful ABC pseudo-comments — highlight as 'meta', not 'comment'.
    if (stream.match(/%%[^\s].*$/) || stream.match(/%%\s*$/)) {
      state.inHeader = false; return 'meta';
    }
    // Regular % comments: rest of line
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
// Tablature helpers
// ---------------------------------------------------------------------------

/**
 * Supported tablature instruments and their human-readable names.
 * These match the keys registered in abcjs's internal pluginTab table.
 */
const TAB_INSTRUMENTS = new Set(['guitar', 'mandolin', 'violin', 'fiddle', 'fiveString']);

/**
 * Parse `%%tablature` formatting directives from an ABC source string.
 *
 * Each `%%tablature` line defines tablature for one staff (in declaration
 * order).  Recognised key=value pairs on the line:
 *
 *   instrument  – required; one of: guitar, mandolin, violin, fiddle, fiveString
 *   capo        – fret number to capo (integer, default 0)
 *   label       – label text shown to the left of the tab staff
 *   firstStaffOnly – if "true", only show the tab label on the first staff
 *
 * Lines with an unrecognised or empty instrument create a placeholder so
 * that per-voice ordering still works (e.g. omit tab on the second voice of
 * a two-voice tune).
 *
 * Returns the `tablature` array to pass to `renderAbc`, or `null` when no
 * `%%tablature` directives are present.
 *
 * Example ABC:
 *   %%tablature instrument=guitar capo=2 label=Tab
 */
function parseTabDirectives(src) {
  const tabs = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^%%tablature\b(.*)/i);
    if (!m) continue;
    const args = {};
    for (const pair of m[1].matchAll(/([\w]+)=([^\s]+)/g)) {
      args[pair[1]] = pair[2];
    }
    // capo must be an integer
    if (args.capo !== undefined) args.capo = parseInt(args.capo, 10) || 0;
    // firstStaffOnly is a boolean flag
    if (args.firstStaffOnly !== undefined) args.firstStaffOnly = args.firstStaffOnly === 'true';
    // Unknown / empty instrument → placeholder (no tab for this staff slot)
    if (!args.instrument || !TAB_INSTRUMENTS.has(args.instrument)) {
      args.instrument = '';
    }
    tabs.push(args);
  }
  return tabs.length ? tabs : null;
}

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
    const tablature = parseTabDirectives(content);
    const tuneObjects = abcjs.renderAbc(container, content, {
      responsive: 'resize',
      add_classes: true,
      ...(tablature ? { tablature } : {}),
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
// engraver.rangeHighlight(from, to) to drive the preview selection.
//
// A collapsed cursor (from === to) uses rangeHighlight(0, 0) which calls
// clearSelection() and then matches nothing — effectively clearing all
// SVG highlights.  This fixes the "selection persists after clicking in
// the text editor" bug (the previous rangeHighlight(pos, pos) call sometimes
// left inline fill attributes set by abcjs's own click handler intact).
// ---------------------------------------------------------------------------

state.on('editor-select', ({ from, to }) => {
  _lastEditorSel = { from, to };
  if (_engraver && state.data?.dslType === 'abcjs' && !state.abcPlaying) {
    try {
      // Collapsed cursor → clear all highlights; real selection → show range.
      _engraver.rangeHighlight(from === to ? 0 : from, from === to ? 0 : to);
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

  // Use primary startChar for single-voice event matching; multi-voice events
  // expose startCharArray / endCharArray with one entry per simultaneous voice.
  const noteEvents = (previewTc.noteTimings ?? []).filter(e => e.type === 'event');

  if (selFrom !== selTo && selTo > selFrom) {
    // ── Range selection: play from first note that starts at/after selFrom
    //    (searching across all voices via startCharArray).
    const startEv = noteEvents.find(e => {
      const chars = e.startCharArray ?? [e.startChar];
      return chars.some(c => c !== undefined && c >= selFrom);
    });
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

      // ── Range mode stop check ──────────────────────────────────────────────
      // For multi-voice scores, startCharArray contains one char per voice.
      // We stop when ALL voices have moved past the selection end so that no
      // voice is prematurely cut off.
      if (stopChar !== null) {
        const chars = event.startCharArray ?? (event.startChar !== undefined ? [event.startChar] : []);
        if (chars.length > 0 && chars.every(c => c >= stopChar)) {
          stopPlayback();
          return;
        }
      }

      // ── SVG: highlight all simultaneously-playing note elements ────────────
      // We use event.elements (array-of-arrays, one sub-array per voice) to
      // directly add/remove our own CSS class rather than calling rangeHighlight,
      // which only supports a single range and clears all other highlights.
      if (_playEl) {
        _playEl.querySelectorAll('.abcjs-note_playing').forEach(el => {
          el.classList.remove('abcjs-note_playing');
        });
        if (event.elements) {
          event.elements.flat().forEach(svgEl => {
            svgEl?.classList.add('abcjs-note_playing');
          });
        }
      }

      // ── Editor: emit all voice char ranges for text-colour highlighting ────
      const starts = event.startCharArray ?? [event.startChar];
      const ends   = event.endCharArray   ?? [event.endChar];
      const ranges = starts
        .map((s, i) => ({ from: s, to: ends[i] }))
        .filter(r => r.from !== undefined && r.to !== undefined && r.from < r.to);
      state.emit('abc-play-cursor', ranges.length ? ranges : null);
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

  // Remove the direct per-note SVG play highlights.
  if (_playEl) {
    _playEl.querySelectorAll('.abcjs-note_playing').forEach(el => {
      el.classList.remove('abcjs-note_playing');
    });
  }

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
    const tablature = parseTabDirectives(content);
    abcjs.renderAbc(tmp, content, {
      responsive: 'resize',
      ...(tablature ? { tablature } : {}),
    });
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
  const tablature = parseTabDirectives(content);
  abcjs.renderAbc(tmp, content, { ...(tablature ? { tablature } : {}) });
  const svgContent = tmp.innerHTML;
  document.body.removeChild(tmp);
  return new Blob([svgContent], { type: 'image/svg+xml' });
}

async function exportPDF(content) {
  // ── 1. Render offscreen with oneSvgPerLine ─────────────────────────────────
  // oneSvgPerLine splits the single large SVG into one <div><svg></svg></div>
  // per staff system.  Each SVG carries a viewBox so it can be scaled by CSS
  // in the print window, and each wrapper div has a fixed height so that
  // page-break-inside: avoid can be enforced between systems.
  //
  // staffwidth 680 is abcjs's own print default ("pixels in 8.5 in minus 1 cm
  // margin") and gives good note spacing for typical scores.
  //
  // The container must be in the live DOM with a real width so that abcjs can
  // call getBBox() on each staff <g> during the split.  position:fixed +
  // left:-9999px keeps it off-screen while still being layout-computed.
  const STAFF_W = 680;
  const tmp = document.createElement('div');
  tmp.style.cssText = `position:fixed;left:-9999px;top:0;width:${STAFF_W}px;visibility:hidden;`;
  document.body.appendChild(tmp);

  const tablature = parseTabDirectives(content);
  try {
    abcjs.renderAbc(tmp, content, {
      oneSvgPerLine: true,
      staffwidth: STAFF_W,
      add_classes: true,
      ...(tablature ? { tablature } : {}),
    });
  } catch (e) {
    document.body.removeChild(tmp);
    return null;
  }

  const bodyHtml = tmp.innerHTML;
  document.body.removeChild(tmp);

  // ── 2. Build a clean, self-contained print page ────────────────────────────
  //
  // @page { margin: 0 }  →  removes the browser's own header/footer chrome
  //                          (URL, date, page number).  Visible margins come
  //                          from body padding instead so we control them.
  //
  // svg { width:100%; height:auto }  →  each system SVG scales to fill the
  //                          content column; height is derived from the viewBox
  //                          aspect ratio, keeping notation proportional.
  //
  // body > div { height:auto !important; page-break-inside:avoid }
  //                       →  overrides abcjs's fixed inline height on each
  //                          wrapper so the scaled SVG sets the div's height,
  //                          and prevents the browser from splitting a staff
  //                          system across a page.
  const printHtml = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Sheet Music</title>
<style>
  @page { size: letter; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: white; color: black; }
  body { padding: 0.35in 0.5in; font-family: serif; }

  /* Never break a staff system across a page; override abcjs fixed height */
  body > div {
    height: auto !important;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  /* Scale every SVG to the content column width */
  svg { display: block; width: 100%; height: auto; }

  /* Strip interactive red selection highlights */
  [fill="#ff0000"] { fill: black !important; }
  .abcjs-note_selected path,
  .abcjs-note_selected rect { fill: black !important; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;

  // ── 3. Open print window and trigger the dialog ────────────────────────────
  const win = window.open('', '_blank');
  if (!win) return null; // pop-up blocked

  win.document.open();
  win.document.write(printHtml);
  win.document.close();

  // A short timeout lets the browser finish laying out the SVGs before the
  // print dialog opens; onload is unreliable for SVG-only documents.
  setTimeout(() => { win.focus(); win.print(); }, 400);
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
