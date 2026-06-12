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
// Case-insensitive instrument lookup → abcjs's exact pluginTab key.
const TAB_INSTRUMENTS = new Map([
  ['guitar', 'guitar'], ['mandolin', 'mandolin'], ['violin', 'violin'],
  ['fiddle', 'fiddle'], ['fivestring', 'fiveString'],
]);

/**
 * Parse tablature pragmas from an ABC source string into the `tablature` array
 * abcjs's renderAbc expects (abcjs renders one tab staff per array entry, in
 * declaration order).  Forgiving about syntax so the common forms all work:
 *
 *   %%tablature instrument=guitar capo=2 label="Gtr"
 *   %%tablature guitar              (instrument as a bare positional word)
 *   %%tab guitar                    (%%tab is accepted as a shorthand)
 *   %%tablature violin tuning=G,D,A,e
 *
 * Recognised keys (case-insensitive): instrument, capo, label, tuning
 * (comma/space separated → array), transpose / visualtranspose, firststaffonly,
 * hidetabsymbol.  A line with an unknown/empty instrument becomes a placeholder
 * ({instrument:''}) so per-voice ordering still works (e.g. tab on voice 1 only).
 *
 * Returns the array, or null when no tablature pragma is present.
 */
function parseTabDirectives(src) {
  const tabs = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^%%tab(?:lature)?\b(.*)/i);
    if (!m) continue;
    const rest = m[1];

    // key=value pairs (value may be "quoted" to allow spaces).
    const raw = {};
    for (const pair of rest.matchAll(/(\w+)\s*=\s*("[^"]*"|\S+)/g)) {
      raw[pair[1].toLowerCase()] = pair[2].replace(/^"|"$/g, '');
    }

    // Instrument: explicit instrument=… else first bare known-instrument token.
    let inst = raw.instrument;
    if (!inst) {
      for (const tok of rest.split(/\s+/)) {
        if (TAB_INSTRUMENTS.has(tok.toLowerCase())) { inst = tok; break; }
      }
    }

    // Build the abcjs-shaped args (correct camelCase keys).
    const args = {};
    const key = inst ? TAB_INSTRUMENTS.get(inst.toLowerCase()) : null;
    args.instrument = key || '';               // '' = placeholder slot
    if (raw.capo !== undefined)  args.capo = parseInt(raw.capo, 10) || 0;
    if (raw.label !== undefined) args.label = raw.label;
    if (raw.tuning) args.tuning = raw.tuning.split(/[,\s]+/).filter(Boolean);
    const transpose = raw.transpose ?? raw.visualtranspose;
    if (transpose !== undefined) args.visualTranspose = parseInt(transpose, 10) || 0;
    if (raw.firststaffonly !== undefined) args.firstStaffOnly = raw.firststaffonly === 'true';
    if (raw.hidetabsymbol !== undefined) args.hideTabSymbol = raw.hidetabsymbol === 'true';

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

// engraver.rangeHighlight() does an O(notes) DOM scan inside abcjs.  When the
// user drags the cursor / makes a selection it can fire many times per frame, so
// coalesce to one call per animation frame (latest range wins) to keep the main
// thread responsive on large scores.  Other rangeHighlight callers (playback,
// stopPlayback) run synchronously — they aren't on a high-frequency path.
let _rangeHighlightRaf = 0;
function _scheduleRangeHighlight(adjFrom, adjTo) {
  if (_rangeHighlightRaf) cancelAnimationFrame(_rangeHighlightRaf);
  _rangeHighlightRaf = requestAnimationFrame(() => {
    _rangeHighlightRaf = 0;
    if (!_engraver) return;
    try { _engraver.rangeHighlight(adjFrom, adjTo); } catch { /* stale after re-render */ }
  });
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

    // Transport: compute total duration for the scrubber and reset position.
    _totalMs = tuneObjects?.[0] ? _computeDuration(tuneObjects[0]) : 0;
    _pausedAtMs = 0;
    state.abcDurationMs = _totalMs;
    state.emit('abc-duration', { total: _totalMs });
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
    // Translated to section-relative: collapsed cursor clears, range highlights.
    // Coalesced to one rangeHighlight per frame (see _scheduleRangeHighlight).
    const adjFrom = from === to ? 0 : Math.max(0, from - _sectionOffset);
    const adjTo   = from === to ? 0 : Math.max(0, to   - _sectionOffset);
    _scheduleRangeHighlight(adjFrom, adjTo);
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

// ---------------------------------------------------------------------------
// Web MIDI output routing
//
// When the user selects an external MIDI output port (e.g. an IAC virtual bus
// feeding Kontakt or a DAW), playback is routed there as live MIDI note on/off
// messages *instead* of the internal piano synth.  Velocity carries the same
// dynamics-aware volume abcjs computes, so expression is preserved downstream.
//
// Timing: each note's on/off is sent with an absolute DOMHighResTimeStamp via
// MIDIOutput.send(), so the MIDI subsystem schedules it precisely.  We only push
// messages that fall within a short look-ahead window (so a Stop can't be
// outrun by more than that window of already-committed note-ons), and a panic
// (note-offs + CC123 all-notes-off) is sent on stop.
// ---------------------------------------------------------------------------

const MIDI_LOOKAHEAD_MS = 150; // how far ahead we commit messages to the port
const MIDI_PREROLL_MS   = 120; // lead time before the first note sounds
const MIDI_PERSIST_KEY  = 'unifile_abc_midi_out';

let _midiAccess = null;           // MIDIAccess (null until requested/granted)
let _midiOut    = null;           // MIDIOutput currently playing through, or null
let _midiQueue  = [];             // sorted [{at, status, pitch, vel}] absolute perf.now ms
let _midiQueueIdx = 0;
let _midiPumpTimer = null;        // look-ahead pump timeout
let _midiActiveNotes = new Set(); // "ch:pitch" currently sounding (for panic note-offs)

// Selected output id persisted across reloads (null → internal piano).
let _midiOutId = (() => {
  try { return localStorage.getItem(MIDI_PERSIST_KEY) || null; } catch { return null; }
})();
state.abcMidiOutId = _midiOutId;

/** Publish the current output list + selection to state and notify the footer. */
function _publishMidiOutputs() {
  const outs = [];
  if (_midiAccess) {
    for (const out of _midiAccess.outputs.values()) {
      outs.push({ id: out.id, name: out.name || out.id });
    }
  }
  // Drop a stale selection if the device went away.
  if (_midiOutId && !outs.some(o => o.id === _midiOutId)) {
    _midiOutId = null;
    try { localStorage.removeItem(MIDI_PERSIST_KEY); } catch { /* ignore */ }
  }
  state.abcMidiOutputs = outs;
  state.abcMidiOutId   = _midiOutId;
  state.emit('abc-midi-outputs-change', { outputs: outs, selectedId: _midiOutId });
}

/** Lazily request Web MIDI access (only on explicit user interest → no surprise prompt). */
async function _ensureMidiAccess() {
  if (_midiAccess || !navigator.requestMIDIAccess) { _publishMidiOutputs(); return; }
  try {
    _midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    _midiAccess.onstatechange = () => _publishMidiOutputs();
  } catch (err) {
    console.warn('[abcjs] Web MIDI access denied/unavailable:', err?.message ?? err);
    _midiAccess = null;
  }
  _publishMidiOutputs();
}

state.on('abc-midi-refresh', () => { _ensureMidiAccess(); });
state.on('abc-midi-select', ({ id }) => {
  _midiOutId = id || null;
  try {
    if (_midiOutId) localStorage.setItem(MIDI_PERSIST_KEY, _midiOutId);
    else localStorage.removeItem(MIDI_PERSIST_KEY);
  } catch { /* ignore */ }
  state.abcMidiOutId = _midiOutId;
  state.emit('abc-midi-outputs-change', { outputs: state.abcMidiOutputs, selectedId: _midiOutId });
});

/** Resolve the selected output to a live MIDIOutput, or null to use the synth. */
function _resolveMidiOut() {
  if (!_midiOutId || !_midiAccess) return null;
  return _midiAccess.outputs.get(_midiOutId) ?? null;
}

/**
 * Build a time-sorted MIDI message queue from abcjs note timings and start the
 * look-ahead pump.  `startSeconds` is the playback offset; `stopChar` (or null)
 * bounds a range selection.  `meterSize` converts note durations → milliseconds.
 */
function _startMidiPlayback(out, noteEvents, startSeconds, stopChar, meterSize) {
  _midiOut = out;
  _midiActiveNotes.clear();
  const t0 = performance.now() + MIDI_PREROLL_MS;
  const msgs = [];

  for (const ev of noteEvents) {
    const evSec = ev.milliseconds / 1000;
    if (evSec < startSeconds - 1e-6) continue; // note starts before our entry point
    const msPerMeasure = ev.millisecondsPerMeasure || 1000;
    const onAt = t0 + (evSec - startSeconds) * 1000;

    for (const p of (ev.midiPitches ?? [])) {
      if (p?.pitch == null) continue;
      // Range mode: skip notes at/after the selection end.
      if (stopChar !== null && p.startChar !== undefined && p.startChar >= stopChar) continue;
      const ch    = 0; // single channel; downstream instrument decides the sound
      const pitch = Math.round(p.pitch);
      const vel   = Math.max(1, Math.min(127, Math.round(p.volume ?? 92)));
      const durMs = Math.max(40, (p.duration ?? 0.25) * msPerMeasure / meterSize);
      const offAt = onAt + durMs * 0.97; // small gap so repeated pitches retrigger
      msgs.push({ at: onAt,  status: 0x90 | ch, pitch, vel });
      msgs.push({ at: offAt, status: 0x80 | ch, pitch, vel: 0 });
    }
  }

  msgs.sort((a, b) => a.at - b.at);
  _midiQueue = msgs;
  _midiQueueIdx = 0;
  _midiPump();
}

/** Look-ahead pump: flush due messages to the port with precise timestamps. */
function _midiPump() {
  if (!_midiOut) return;
  const now = performance.now();
  while (_midiQueueIdx < _midiQueue.length && _midiQueue[_midiQueueIdx].at <= now + MIDI_LOOKAHEAD_MS) {
    const m = _midiQueue[_midiQueueIdx++];
    try { _midiOut.send([m.status, m.pitch, m.vel], m.at); } catch { /* port vanished */ }
    const key = (m.status & 0x0f) + ':' + m.pitch;
    if ((m.status & 0xf0) === 0x90) _midiActiveNotes.add(key);
    else _midiActiveNotes.delete(key);
  }

  if (_midiQueueIdx >= _midiQueue.length) {
    // All committed — stop shortly after the final message has sounded.
    const lastAt = _midiQueue.length ? _midiQueue[_midiQueue.length - 1].at : now;
    _midiPumpTimer = setTimeout(() => stopPlayback(), Math.max(0, lastAt - now) + 60);
    return;
  }
  _midiPumpTimer = setTimeout(_midiPump, 40);
}

/** Stop MIDI playback: cancel the pump and silence the port (panic). */
function _stopMidiPlayback() {
  if (_midiPumpTimer) { clearTimeout(_midiPumpTimer); _midiPumpTimer = null; }
  if (_midiOut) {
    try {
      // Explicit note-offs for anything still sounding, then all-notes-off per channel.
      for (const key of _midiActiveNotes) {
        const [ch, pitch] = key.split(':').map(Number);
        _midiOut.send([0x80 | ch, pitch, 0]);
      }
      for (let ch = 0; ch < 16; ch++) _midiOut.send([0xB0 | ch, 123, 0]);
    } catch { /* ignore */ }
  }
  _midiActiveNotes.clear();
  _midiQueue = [];
  _midiQueueIdx = 0;
  _midiOut = null;
}

// ---------------------------------------------------------------------------
// Visual feedback callback (shared by audio + MIDI paths)
//
// abcjs TimingCallbacks drives the moving cursor regardless of how sound is
// produced.  This factory builds the per-event handler: it stops at the range
// end, highlights the sounding SVG notes, and emits 'abc-play-cursor' so the
// editor colours the current notes green.
// ---------------------------------------------------------------------------
function _makeVisualEventCallback(stopChar) {
  return (event) => {
    if (!event) { stopPlayback(); return; }

    // Range mode: stop when all voices have passed the selection end.
    if (stopChar !== null) {
      const chars = event.startCharArray ?? (event.startChar !== undefined ? [event.startChar] : []);
      if (chars.length > 0 && chars.every(c => c >= stopChar)) { stopPlayback(); return; }
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
  };
}

// ---------------------------------------------------------------------------
// Transport: duration, progress bar, play/pause, seek
// ---------------------------------------------------------------------------

let _totalMs       = 0;   // total tune duration (ms) — drives the scrubber
let _pausedAtMs    = 0;   // remembered position when paused / sought (ms)
let _progressRaf   = 0;   // rAF id for progress emission
let _playOffsetMs  = 0;   // ms position where the current run started
let _playWallStart = 0;   // performance.now() at the current run's start

/** Play a 1-sample silent buffer to unlock audio on iOS within a user gesture. */
function _unlockAudio(ctx) {
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* ignore */ }
}

/** Compute total tune duration (ms) without playing, for the transport display. */
function _computeDuration(tune) {
  try {
    tune.setUpAudio({});
    const tc = new abcjs.TimingCallbacks(tune, { eventCallback: () => {} });
    const nt = (tc.noteTimings ?? []).filter(e => e.type === 'event');
    if (!nt.length) return 0;
    const last = nt[nt.length - 1];
    // lastMoment is the start of the last event; add ~one beat so the bar
    // reaches the end as the final note rings out.
    const beat = last.millisecondsPerMeasure ? last.millisecondsPerMeasure / 4 : 400;
    return Math.round(last.milliseconds + beat);
  } catch { return 0; }
}

function _emitProgress(ms) {
  state.abcPositionMs = ms;
  state.emit('abc-progress', { ms, total: _totalMs });
}

function _startProgress(offsetMs) {
  _playOffsetMs  = offsetMs;
  _playWallStart = performance.now();
  cancelAnimationFrame(_progressRaf);
  const tick = () => {
    const ms = _playOffsetMs + (performance.now() - _playWallStart);
    _emitProgress(_totalMs ? Math.min(ms, _totalMs) : ms);
    if (state.abcPlaying) _progressRaf = requestAnimationFrame(tick);
  };
  _progressRaf = requestAnimationFrame(tick);
}

function _stopProgress() { cancelAnimationFrame(_progressRaf); _progressRaf = 0; }

/** Current playback position (ms): live while playing, else the paused point. */
function _currentMs() {
  if (state.abcPlaying) {
    const ms = _playOffsetMs + (performance.now() - _playWallStart);
    return _totalMs ? Math.min(ms, _totalMs) : ms;
  }
  return _pausedAtMs;
}

/** Play/pause toggle used by the transport footer. */
function togglePlay() {
  if ((state.activeDslId ?? state.data?.dslType) !== 'abcjs') return;
  if (state.abcPlaying) {
    _pausedAtMs = _currentMs();
    stopPlayback({ keepPosition: true });
  } else {
    startPlayback({ startMs: _pausedAtMs });
  }
}

/** Seek to an absolute ms position (from the scrubber). */
function seekTo(ms) {
  ms = Math.max(0, Math.min(ms, _totalMs || ms));
  _pausedAtMs = ms;
  if (state.abcPlaying) {
    stopPlayback({ keepPosition: true });
    startPlayback({ startMs: ms });
  } else {
    _emitProgress(ms);
  }
}

async function startPlayback(opts = {}) {
  if (!_tuneObjects?.[0]) return;

  // Restart cleanly if something is already playing (e.g. a seek while playing).
  if (_synth) {
    stopPlayback({ keepPosition: true });
  }

  const tune = _tuneObjects[0];
  // Translate full-doc editor positions to section-relative positions so they
  // match the char indices in abcjs noteTimings (which are 0-based from the
  // start of the section content passed to render()).
  const selFrom = Math.max(0, _lastEditorSel.from - _sectionOffset);
  const selTo   = Math.max(0, _lastEditorSel.to   - _sectionOffset);

  // Playback uses the abcjs synthesiser by default — this build bundles the
  // FluidR3 acoustic_grand_piano soundfont and serves it offline (see
  // abcjs-piano-loader.js), so the default sound is a real piano with no fetch.
  // A user-supplied soundfont URL (extension slot) overrides the base URL for
  // richer/other instruments.  Read directly from state.data so the live
  // document value is always seen.
  const soundfontUrl = state.data?.pluginExtensions?.abcjs?.['soundfont-url']?.value ?? null;

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

  if (opts.startMs != null) {
    // Transport seek / resume: play the whole tune from an absolute position.
    startSeconds = Math.max(0, opts.startMs / 1000);
  } else if (selFrom !== selTo && selTo > selFrom) {
    // Range selection: play from first note at/after selFrom.
    const startEv = noteEvents.find(e => {
      const chars = e.startCharArray ?? [e.startChar];
      return chars.some(c => c !== undefined && c >= selFrom);
    });
    if (startEv) startSeconds = startEv.milliseconds / 1000;
    stopChar = selTo;
  } else if (selFrom > 0) {
    // Cursor inside document: find the event whose note (in ANY voice) spans
    // selFrom, else the first event starting at/after it.  Multi-voice events
    // carry startCharArray/endCharArray with one entry per simultaneous voice;
    // matching only the primary startChar would mis-locate a click on a second
    // (e.g. bass-clef) voice and start playback at the wrong place.
    const startsOf = e => e.startCharArray ?? [e.startChar];
    const endsOf   = e => e.endCharArray   ?? [e.endChar];
    const startEv =
      noteEvents.find(e => {
        const s = startsOf(e), n = endsOf(e);
        return s.some((c, i) => c !== undefined && c <= selFrom && n[i] > selFrom);
      }) ??
      noteEvents.find(e => startsOf(e).some(c => c !== undefined && c >= selFrom));
    if (startEv) startSeconds = startEv.milliseconds / 1000;
  }
  // else: cursor at 0 / no selection → play from beginning

  // ── 2.5  MIDI output path (replaces the internal synth when a port is set) ──
  //
  // Route to the selected external MIDI port (e.g. IAC → Kontakt) as live
  // note on/off with dynamics-aware velocity.  No AudioContext/synth here — the
  // external instrument makes the sound; we only drive the visual cursor.
  const midiOut = _resolveMidiOut();
  if (midiOut) {
    const mf = tune.getMeterFraction?.() ?? { num: 4, den: 4 };
    const meterSize = (mf.num / mf.den) || 1;

    _timingCallbacks = new abcjs.TimingCallbacks(tune, {
      eventCallback: _makeVisualEventCallback(stopChar),
    });

    _playEl?.classList.add('abc-playing');
    state.abcPlaying = true;
    state.emit('abc-play-state', { playing: true });

    _startMidiPlayback(midiOut, noteEvents, startSeconds, stopChar, meterSize);
    _timingCallbacks.start(startSeconds, 'seconds');
    _startProgress(startSeconds * 1000);
    return;
  }

  // ── 3.  Schedule audio ───────────────────────────────────────────────────
  //
  // AudioContext must be created AND unlocked synchronously inside the user-
  // gesture handler.  iOS Safari is strict: if audio isn't unlocked during the
  // gesture, playback that starts later (after the async soundfont decode in
  // synth.prime) is silenced — the visual cursor still runs, but no sound.
  // Playing a 1-sample silent buffer here unlocks the context for the session.

  _scheduledOscs = [];

  try {
    _audioContext = new (window.AudioContext || window.webkitAudioContext)();
    _unlockAudio(_audioContext);     // iOS: unlock within the user gesture
    await _audioContext.resume();
  } catch {
    _audioContext = null;
    return;
  }

  if (abcjs.synth?.CreateSynth) {
    // ── 3a.  Soundfont synth path (default: bundled offline piano) ────────
    //
    // abcjs.synth.CreateSynth decodes per-note AudioBuffers via our overridden
    // load-note (acoustic_grand_piano from the bundle, offline).  When the user
    // supplies a soundFontUrl it is used as the base for other instruments.
    // Arbitrary start offsets are handled by seek() before start() (below).
    try {
      const synth = new abcjs.synth.CreateSynth();
      await synth.init({
        audioContext: _audioContext,
        visualObj:    tune,
        options: {
          // Omit soundFontUrl to use abcjs's default FluidR3 base — for which
          // this build serves acoustic_grand_piano from the bundle offline.
          ...(soundfontUrl ? { soundFontUrl: soundfontUrl } : {}),
          onEnded:      () => stopPlayback(),
        },
      });
      await synth.prime();
      _synth = synth;
    } catch (err) {
      // Synth setup failed (e.g. a custom URL is wrong / unreachable, or a note
      // couldn't be decoded).  Fall through to the oscillator path so playback
      // still works.  Only surface a banner when the user explicitly configured
      // a remote soundfont — the default bundled piano falling back is silent.
      const msg = err?.message ?? String(err);
      if (soundfontUrl && _playEl) {
        const banner = document.createElement('div');
        banner.className = 'abc-soundfont-error';
        banner.textContent = `⚠ Soundfont failed to load (${msg}). Using oscillator playback instead.`;
        _playEl.insertAdjacentElement('afterbegin', banner);
        setTimeout(() => banner.remove(), 8000);
      }
      console.warn('[abcjs] Synth init failed, falling back to oscillators:', msg);
      try { _audioContext.close(); } catch { /* ignore */ }
      _audioContext = null;
      _synth = null;

      // Re-create AudioContext for the oscillator path.
      try {
        _audioContext = new AudioContext();
        await _audioContext.resume();
      } catch {
        _audioContext = null;
        return;
      }
    }
  }

  if (!_synth) {
    // ── 3b.  Web Audio oscillator path (offline, no soundfont) ───────────
    _scheduleOscillators(noteEvents, startSeconds, stopChar);
    _synth = { stop: () => {} };
  }

  // ── 4.  Timing callbacks (visual feedback only) ──────────────────────────

  _timingCallbacks = new abcjs.TimingCallbacks(tune, {
    eventCallback: _makeVisualEventCallback(stopChar),
  });

  // ── 5.  Start ────────────────────────────────────────────────────────────

  _playEl?.classList.add('abc-playing');
  state.abcPlaying = true;
  state.emit('abc-play-state', { playing: true });

  // iOS: the context can drop back to 'suspended' during the async prime — make
  // sure it's running again right before start, or the first notes are silent.
  if (_audioContext && _audioContext.state !== 'running') {
    try { await _audioContext.resume(); } catch { /* ignore */ }
  }

  if (typeof _synth?.start === 'function') {
    // Seek to the requested start position before starting (synth.seek() sets
    // pausedTimeSec so that start() resumes from there rather than the beginning).
    if (startSeconds > 0) _synth.seek(startSeconds, 'seconds');
    _synth.start();
    _timingCallbacks.start(startSeconds, 'seconds');
  } else {
    _timingCallbacks.start(startSeconds, 'seconds');
  }

  // Drive the transport progress bar (works for all audio paths).
  _startProgress(startSeconds * 1000);
}

function stopPlayback(opts = {}) {
  try { _timingCallbacks?.stop(); } catch { /* ignore */ }
  _timingCallbacks = null;
  _stopProgress();

  // Silence + cancel any external MIDI routing.
  _stopMidiPlayback();

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

  // Transport position: a real stop / natural end resets to the start; a pause
  // or seek (keepPosition) leaves _pausedAtMs where the caller set it.
  if (!opts.keepPosition) { _pausedAtMs = 0; _emitProgress(0); }

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

// Transport controls (emitted by the persistent abc footer).
state.on('abc-play', () => togglePlay());
state.on('abc-seek', ({ ms }) => seekTo(ms));

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
  },

  /**
   * Extension slots — configurable sub-capabilities exposed in the
   * Manage Plugins modal.  Each slot is a user-configurable input that
   * the DSL can read at runtime via plugin-extensions.js helpers.
   */
  extensionSlots: [
    {
      id:          'soundfont-url',
      type:        'text',
      label:       'Soundfont URL',
      placeholder: 'https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/',
      description: 'Playback already uses a bundled offline acoustic piano. '
        + 'Set this only to use a different/remote soundfont collection (requires a network connection). '
        + 'Compatible URLs: …/FluidR3_GM/  or  …/MusyngKite/  '
        + '(the …/abcjs/ path uses a different format and will not work here). '
        + 'If a note cannot be loaded, playback falls back to the built-in oscillators.',
    },
  ],
};

registerDSL(abcjsDSL);
export default abcjsDSL;
