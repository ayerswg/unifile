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
import { StreamLanguage } from '@codemirror/language';
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

// Whether a note in the preview is currently highlighted red (user clicked a note
// or has a text-range selection in the editor covering ABC content).
// When true the play button is shown; when false it is hidden.
let _hasNoteHighlight = false;

// Section-relative {from, to} of the last clicked note, and the localOffset of
// the block it belongs to.  Used to restore the visual highlight when the same
// block re-renders (e.g. after active-section-change fires a debounced re-render).
let _lastNoteClickRange  = null;
let _lastNoteBlockOffset = -1;

function _setNoteSelected(v) {
  if (_hasNoteHighlight === v) return;
  _hasNoteHighlight = v;
  state.abcNoteSelected = v;
  state.emit('abc-note-selected', { selected: v });
  if (!v) {
    _lastNoteClickRange  = null;
    _lastNoteBlockOffset = -1;
  }
}

// Active playback handles (null when not playing).
// _synth is used as a boolean sentinel — truthy while playing.
let _synth = null;
let _timingCallbacks = null;
let _audioContext = null;
// Web Audio oscillators scheduled for the current playback.
let _scheduledOscs = [];

// Character offset of the active section's content start within the full document.
// render() receives section-sliced content, so abcjs char positions are 0-based
// relative to the section.  Add _sectionOffset to convert to full-doc positions
// (for dsl-select events) and subtract it when going the other way (rangeHighlight).
let _sectionOffset = 0;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function render(content, el) {
  // Stop any in-progress playback when the content changes.
  if (_synth) stopPlayback();

  // Capture section offset so click positions (section-relative) can be
  // translated to full-document positions and vice-versa.
  //
  // In layout mode (slides / document / webpage) the layout renderer sets
  // el.dataset.dslContentFrom to the absolute offset of the first content
  // character (after the #!abcjs shebang).  Use that when present; fall back
  // to state.activeSectionRange?.from for the standalone preview path.
  _sectionOffset = el.dataset.dslContentFrom != null
    ? parseInt(el.dataset.dslContentFrom, 10)
    : (state.activeSectionRange?.from ?? 0);

  // Note-selected state is NOT reset here.  Clearing happens in the editor-select
  // handler (collapsed cursor) so that a debounced re-render triggered by
  // active-section-change does not flash the play button away after a note click.
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

  // In layout mode (slides / document / webpage), dslContentFrom is set on el.
  // Mark the wrapper so _bindClickBack in preview.js defers to abcjs's own
  // precise clickListener rather than emitting a coarse block-level selection.
  // We only set this in layout mode — in standalone mode stopPropagation handles
  // it, and we must not pollute this.content across re-renders.
  if (el.dataset.dslContentFrom != null) {
    el.dataset.dslHandled = '1';
  }

  // Capture the section offset for this specific block at render time.
  // When multiple abcjs blocks exist (e.g. layout: webpage), the clickListener
  // closure uses localOffset so it always refers to its own block, and it
  // re-establishes the module-level context variables when clicked.
  const localOffset = _sectionOffset;

  try {
    const tablature = parseTabDirectives(content);

    // Declared before renderAbc so the clickListener closure can capture the
    // binding; assigned after renderAbc once we have the tuneObjects back.
    let localEngraver    = null;
    let localTuneObjects = null;

    const tuneObjects = abcjs.renderAbc(container, content, {
      responsive: 'resize',
      add_classes: true,
      ...(tablature ? { tablature } : {}),
      // abcjs highlights the clicked note (abcjs-note_selected + fill="#ff0000").
      // We tell the editor which source range to jump to, and show the play button.
      clickListener: (abcElem, _tuneNum, _classes, _analysis, _drag, mouseEvent) => {
        mouseEvent?.stopPropagation();
        // Re-establish this block as the active playback context so that the
        // play button always acts on the tune whose note was last clicked.
        _engraver    = localEngraver;
        _tuneObjects = localTuneObjects;
        _playEl      = container;
        _sectionOffset = localOffset;
        if (abcElem.startChar !== undefined && abcElem.endChar !== undefined) {
          // Remember which block's note was clicked so we can restore the
          // visual highlight if the block re-renders before the user moves.
          _lastNoteBlockOffset = localOffset;
          _lastNoteClickRange  = { from: abcElem.startChar, to: abcElem.endChar };
          state.emit('dsl-select', {
            from: abcElem.startChar + localOffset,
            to:   abcElem.endChar   + localOffset,
          });
          _setNoteSelected(true); // show the play button
        }
      }
    });

    localEngraver    = tuneObjects?.[0]?.engraver ?? null;
    localTuneObjects = tuneObjects ?? null;

    // Store engraver so editor selections can drive reverse highlighting
    _engraver    = localEngraver;
    _tuneObjects = localTuneObjects;
    _playEl      = container;

    // If a note from this block was selected before the re-render, restore the
    // visual highlight on the freshly-created SVG elements.
    if (_hasNoteHighlight && _lastNoteClickRange && localOffset === _lastNoteBlockOffset && localEngraver) {
      try { localEngraver.rangeHighlight(_lastNoteClickRange.from, _lastNoteClickRange.to); } catch { /* stale */ }
    }

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

  // A collapsed cursor means no note is actively selected — hide the play button.
  // Guard against clearing during playback (user may move cursor while music plays).
  if (from === to && !state.abcPlaying) _setNoteSelected(false);

  if (_engraver && (state.activeDslId ?? state.data?.dslType) === 'abcjs' && !state.abcPlaying) {
    try {
      // Translated to section-relative: collapsed cursor clears, range highlights.
      const adjFrom = from === to ? 0 : Math.max(0, from - _sectionOffset);
      const adjTo   = from === to ? 0 : Math.max(0, to   - _sectionOffset);
      _engraver.rangeHighlight(adjFrom, adjTo);
    } catch { /* engraver may be stale after a re-render — ignore */ }
    // A real text-range selection over ABC content counts as a note selected.
    if (from !== to) _setNoteSelected(true);
  }
});

// When the user clicks a note in the ABC preview, 'dsl-select' fires and the
// editor moves its cursor — but tags the transaction as DSL_SELECT_EVENT so
// 'editor-select' is NOT re-emitted.  Mirror the update here so that
// play-from-cursor works correctly after a preview click.
//
// Use a collapsed cursor (to: from) rather than the full note span so that
// play-from-note means "play from here to the end" rather than "play only
// this one note".  Range-play is driven solely by editor text selections.
state.on('dsl-select', ({ from }) => {
  _lastEditorSel = { from, to: from };
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
// Audio: Web Audio API oscillators (triangle wave, offline — no CDN fetch).
//
// During playback:
//   • The preview container gets class `abc-playing` (CSS overrides the
//     note highlight colour to green).
//   • Each note's source range is emitted as 'abc-play-cursor' so the editor
//     can show a green text-highlight tracking the music.
//   • The static (red) selection in the preview is suppressed while playing
//     and restored when playback stops.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GM program → oscillator timbre
//
// Maps the 128 General MIDI program numbers (organised as 16 families of 8)
// to an oscillator type + envelope shape.  This lets %%MIDI program directives
// in ABC notation produce meaningfully different timbres offline.
//
//  family  0– 1  Piano           sine,    punchy decay
//  family  2– 3  Chromatic perc  triangle, short decay
//  family  4– 5  Organ           sine,    full sustain
//  family  6– 7  Guitar          triangle, plucked decay
//  family  8– 9  Bass            sawtooth, deep (vol ×0.6)
//  family 10–11  Strings         sawtooth, slow attack
//  family 12–13  Ensemble/choir  sine,    slow attack
//  family 14–15  Brass           sawtooth, sharp attack
//  family 16–17  Reed            sawtooth, medium
//  family 18–19  Pipe/flute      sine,    gentle
//  family 20–21  Synth lead      square,  medium
//  family 22–23  Synth pad       sine,    slow attack + release
//  family 24–31  FX/ethnic/perc  triangle, medium
// ---------------------------------------------------------------------------

/**
 * Return oscillator config for a GM program number.
 * @param {number} prog  0–127
 * @returns {{ type: OscillatorType, attack: number, decay: number, sustain: number, volScale: number }}
 */
function _gmConfig(prog) {
  const fam = Math.floor((prog ?? 0) / 8); // 0–15
  // [type, attack(s), decay(s), sustain(0–1), volScale]
  const T = [
    ['sine',     0.005, 0.30, 0.0, 1.0],  //  0–7   Piano
    ['triangle', 0.003, 0.15, 0.0, 1.0],  //  8–15  Chromatic percussion
    ['sine',     0.010, 0.80, 0.8, 0.9],  // 16–23  Organ
    ['triangle', 0.003, 0.20, 0.0, 0.9],  // 24–31  Guitar / plucked
    ['sawtooth', 0.005, 0.40, 0.3, 0.6],  // 32–39  Bass
    ['sawtooth', 0.060, 0.70, 0.7, 0.8],  // 40–47  Strings
    ['sine',     0.080, 0.60, 0.6, 0.8],  // 48–55  Ensemble / choir
    ['sawtooth', 0.008, 0.50, 0.6, 0.9],  // 56–63  Brass
    ['sawtooth', 0.015, 0.55, 0.6, 0.85], // 64–71  Reed
    ['sine',     0.010, 0.55, 0.5, 0.85], // 72–79  Pipe / flute
    ['square',   0.008, 0.45, 0.5, 0.75], // 80–87  Synth lead
    ['sine',     0.100, 0.80, 0.7, 0.75], // 88–95  Synth pad
    ['triangle', 0.010, 0.40, 0.3, 0.85], // 96–103 Synth FX
    ['triangle', 0.005, 0.35, 0.2, 0.9],  // 104–111 Ethnic
    ['triangle', 0.003, 0.20, 0.0, 0.9],  // 112–119 Percussive
    ['triangle', 0.005, 0.30, 0.1, 0.8],  // 120–127 Sound effects
  ];
  const [type, attack, decay, sustain, volScale] = T[Math.min(fam, 15)];
  return { type, attack, decay, sustain, volScale };
}

/**
 * Schedule Web Audio OscillatorNodes for every note.
 * Oscillator type and envelope are chosen from the GM program number stored
 * in each note's midiPitches entry, so %%MIDI program directives in ABC
 * notation produce meaningfully different timbres.
 */
function _scheduleOscillators(noteEvents, startSeconds, stopChar) {
  const scheduleBase = _audioContext.currentTime + 0.05;

  for (let i = 0; i < noteEvents.length; i++) {
    const event      = noteEvents[i];
    const offsetSec  = event.milliseconds / 1000 - startSeconds;
    if (offsetSec < 0) continue;

    if (stopChar !== null) {
      const chars = event.startCharArray ?? (event.startChar !== undefined ? [event.startChar] : []);
      if (chars.length > 0 && chars.every(c => c >= stopChar)) continue;
    }

    const nextEv     = noteEvents[i + 1];
    const gapSec     = nextEv ? (nextEv.milliseconds - event.milliseconds) / 1000 : 1.0;
    const noteDurSec = Math.max(0.05, gapSec * 0.92);

    for (const p of (event.midiPitches ?? [])) {
      if (p?.pitch == null) continue;

      const { type, attack, decay, sustain, volScale } = _gmConfig(p.instrument);

      // MIDI note → Hz, with optional cent offset for microtonal ABC.
      const freq   = 440 * Math.pow(2, (p.pitch - 69 + (p.cents ?? 0) / 100) / 12);
      const peakVol = Math.min(1, ((p.volume ?? 64) / 127) * 0.35 * volScale);
      const susVol  = peakVol * sustain;

      const osc  = _audioContext.createOscillator();
      const gain = _audioContext.createGain();
      osc.connect(gain);
      gain.connect(_audioContext.destination);

      osc.type = type;
      osc.frequency.value = freq;

      const t0      = scheduleBase + offsetSec;
      const tPeak   = t0 + Math.min(attack, noteDurSec * 0.3);
      const tDecay  = tPeak + Math.min(decay, noteDurSec * 0.5);
      const tRelease = t0 + noteDurSec;

      gain.gain.setValueAtTime(0,        t0);
      gain.gain.linearRampToValueAtTime(peakVol, tPeak);
      gain.gain.linearRampToValueAtTime(susVol,  tDecay);
      gain.gain.setValueAtTime(susVol,   tRelease - 0.01);
      gain.gain.linearRampToValueAtTime(0,       tRelease);

      osc.start(t0);
      osc.stop(tRelease + 0.01);
      _scheduledOscs.push(osc);
    }
  }
}

async function startPlayback() {
  if (!_tuneObjects?.[0]) return;

  // Toggle off if already playing.
  if (_synth) {
    stopPlayback();
    return;
  }

  const tune = _tuneObjects[0];
  // Translate full-doc editor positions to section-relative positions so they
  // match the char indices in abcjs noteTimings (which are 0-based from the
  // start of the section content passed to render()).
  const selFrom = Math.max(0, _lastEditorSel.from - _sectionOffset);
  const selTo   = Math.max(0, _lastEditorSel.to   - _sectionOffset);

  // ── 1.  Populate midiPitches by running the MIDI flattener ───────────────
  //
  // tune.setUpAudio() runs the sequencer + flattener which mutates each note's
  // abcelem.midiPitches array.  TimingCallbacks reads those when it builds its
  // noteTimings, so this MUST be called before creating any TimingCallbacks.
  try { tune.setUpAudio({}); } catch { /* best-effort — midiPitches may stay empty */ }

  // ── 2.  Determine start seconds and optional stop char ───────────────────

  let startSeconds = 0;
  let stopChar     = null;

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
    // Range selection: play from first note at/after selFrom.
    const startEv = noteEvents.find(e => {
      const chars = e.startCharArray ?? [e.startChar];
      return chars.some(c => c !== undefined && c >= selFrom);
    });
    if (startEv) startSeconds = startEv.milliseconds / 1000;
    stopChar = selTo;
  } else if (selFrom > 0) {
    // Cursor inside document: find note containing selFrom, or first note after it.
    const startEv =
      noteEvents.find(e => e.startChar <= selFrom && e.endChar > selFrom) ??
      noteEvents.find(e => e.startChar >= selFrom);
    if (startEv) startSeconds = startEv.milliseconds / 1000;
  }
  // else: cursor at 0 / no selection → play from beginning

  // ── 3.  Schedule audio (Web Audio oscillators) ───────────────────────────
  //
  // AudioContext must be created synchronously inside the user-gesture handler
  // so the browser's autoplay policy allows it to start immediately.

  _scheduledOscs = [];

  try {
    _audioContext = new AudioContext();
    await _audioContext.resume();
  } catch {
    _audioContext = null;
    return;
  }
  _scheduleOscillators(noteEvents, startSeconds, stopChar);

  _synth = { stop: () => {} };

  // ── 4.  Timing callbacks (visual feedback only) ──────────────────────────

  _timingCallbacks = new abcjs.TimingCallbacks(tune, {
    eventCallback: (event) => {
      if (!event) {
        stopPlayback();
        return;
      }

      // Range mode: stop when all voices have passed the selection end.
      if (stopChar !== null) {
        const chars = event.startCharArray ?? (event.startChar !== undefined ? [event.startChar] : []);
        if (chars.length > 0 && chars.every(c => c >= stopChar)) {
          stopPlayback();
          return;
        }
      }

      // SVG: highlight all simultaneously-playing note elements.
      if (_playEl) {
        _playEl.querySelectorAll('.abcjs-note_playing').forEach(el =>
          el.classList.remove('abcjs-note_playing')
        );
        if (event.elements) {
          event.elements.flat().forEach(svgEl => svgEl?.classList.add('abcjs-note_playing'));
        }
      }

      // Editor: emit all voice char ranges for green text-colour highlighting.
      const starts = event.startCharArray ?? [event.startChar];
      const ends   = event.endCharArray   ?? [event.endChar];
      const ranges = starts
        .map((s, i) => ({ from: s, to: ends[i] }))
        .filter(r => r.from !== undefined && r.to !== undefined && r.from < r.to);
      state.emit('abc-play-cursor', ranges.length ? ranges : null);
    }
  });

  // ── 5.  Start ────────────────────────────────────────────────────────────

  _playEl?.classList.add('abc-playing');
  state.abcPlaying = true;
  state.emit('abc-play-state', { playing: true });
  _timingCallbacks.start(startSeconds, 'seconds');
}

function stopPlayback() {
  try { _timingCallbacks?.stop(); } catch { /* ignore */ }
  _timingCallbacks = null;

  // Stop all pre-scheduled oscillators immediately.
  for (const osc of _scheduledOscs) {
    try { osc.stop(); } catch { /* already stopped — ignore */ }
  }
  _scheduledOscs = [];

  _synth = null;

  try { _audioContext?.close(); } catch { /* ignore */ }
  _audioContext = null;

  if (_playEl) {
    _playEl.querySelectorAll('.abcjs-note_playing').forEach(el =>
      el.classList.remove('abcjs-note_playing')
    );
  }
  _playEl?.classList.remove('abc-playing');

  state.abcPlaying = false;
  state.emit('abc-play-state', { playing: false });
  state.emit('abc-play-cursor', null);

  // Restore range-selection highlight if the user had a text range selected.
  // For note-click selections (collapsed _lastEditorSel), abcjs's own
  // abcjs-note_selected fill survives naturally — don't call rangeHighlight(0,0)
  // which would erase it.
  if (_engraver && _lastEditorSel.from !== _lastEditorSel.to) {
    const adjFrom = Math.max(0, _lastEditorSel.from - _sectionOffset);
    const adjTo   = Math.max(0, _lastEditorSel.to   - _sectionOffset);
    try { _engraver.rangeHighlight(adjFrom, adjTo); } catch { /* stale */ }
  }
}

// External play/pause trigger (emitted by the topbar play button).
state.on('abc-play', () => {
  if ((state.activeDslId ?? state.data?.dslType) === 'abcjs') startPlayback();
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
  ];
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const abcjsDSL = {
  id: 'abcjs',
  label: 'Ab',
  version: '1.0.0',
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
