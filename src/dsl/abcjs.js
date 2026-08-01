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
import { linter } from '@codemirror/lint';
import { hoverTooltip } from '@codemirror/view';
import { registerDSL } from './registry.js';
import { alignAbcVoices } from './abc-align.js';
import {
  renderAbc2svg, useAbc2svg, abc2svgExportSvg, abc2svgExportPrintBody,
} from './abc2svg-render.js';   // default engraving engine (abcjs stays for audio)
import { state } from '../ui/state.js';
import { parseGlobalFrontMatter, getFrontMatterRange } from '../core/front-matter.js';
import { schemaCompletions, schemaLint, parseFmEntries } from '../core/fm-schema.js';
import { buildVoiceMap } from '../core/abc-voices.js';

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
    // Decorations / dynamics / keyswitch marks: !staccato! !f! !legato! !pizzicato! …
    // Match the whole `!…!` as one token so its inner letters aren't mis-read as
    // note pitches (e.g. the g/a in !legato!).
    if (stream.match(/![^!\n]*!/)) return 'meta';

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

// Note-timing events for the last-rendered tune (abcjs TimingCallbacks output,
// filtered to type==='event').  Cached at render so we can map a section-relative
// char offset → playback ms (for selection-driven scrubber seeking) without
// rebuilding the timing table on every cursor move.
let _noteEvents = [];

// Raw ABC source of the last render (section-relative).  Needed to scan for
// `!name!` articulation tokens — abcjs drops unknown decorations, so we read
// them from the source ourselves; their indices line up with note startChars.
let _lastAbcSource = '';

// Voice map for the last render (section-relative char → voice id + score order),
// used to mute/solo voices for playback, highlighting and the score fade.
let _voiceMap = buildVoiceMap('');

/** True when the voice at a section-relative char offset is muted/non-soloed. */
function _isMutedAtChar(sectionChar) {
  if (sectionChar == null) return false;
  const id = _voiceMap.at(sectionChar);
  return id != null && state.isVoiceMuted(id);
}

/** Score-order voice indices that are muted (for the synth `voicesOff` option). */
function _mutedVoiceIndices() {
  const idx = [];
  _voiceMap.order.forEach((id, i) => { if (state.isVoiceMuted(id)) idx.push(i); });
  return idx;
}

/** Dim the note groups of muted voices in the rendered score (toggled on change). */
function _applyVoiceFade() {
  // abc2svg score: every annotation rect knows its voice id — one pass.
  if (_a2sScore) { _a2sScore.setVoiceFade(id => state.isVoiceMuted(id)); return; }
  if (!_playEl) return;
  _playEl.querySelectorAll('.abc-voice-muted').forEach(el => el.classList.remove('abc-voice-muted'));
  if (state.abcMutedVoices.size === 0 && state.abcSoloVoices.size === 0) return;
  for (const ev of _noteEvents) {
    const starts = ev.startCharArray ?? [ev.startChar];
    const groups = ev.elements ?? [];
    starts.forEach((s, i) => {
      if (s != null && _isMutedAtChar(s)) {
        (groups[i] ?? []).forEach(el => el?.classList?.add('abc-voice-muted'));
      }
    });
  }
}

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
    _rangeHighlightNow(adjFrom, adjTo);
  });
}

// The abc2svg score object for the active block (null when the abcjs renderer
// is active — localStorage escape hatch — or abc2svg failed on this content).
// Mirrors _engraver's lifecycle: replaced per render, re-established on click.
let _a2sScore = null;

// Re-engrave when the pane width settles or changes: abc2svg engraves to a
// fixed page width measured at render time, which is 0/stale on the very first
// render (pane not laid out yet) and goes stale on window/split resizes
// (abcjs's responsive mode re-flowed CSS-only; abc2svg needs a re-render).
// Deferred while playing — a re-render would reset the transport position.
let _a2sResizeObs   = null;
let _a2sResizeTimer = 0;

// Debug introspection for preview automation (harmless in production).
if (typeof globalThis !== 'undefined') {
  globalThis.__ufAbcDebug = Object.assign(() => ({
    engraver: !!_engraver,
    a2s: !!_a2sScore,
    a2sSyms: _a2sScore?.symCount ?? null,
    a2sLive: _a2sScore ? document.contains(_a2sScore.el) : null,
    a2s_debug: _a2sScore?._debug?.() ?? null,
    sectionOffset: _sectionOffset,
    noteEvents: _noteEvents.length,
  }), { exportSvg: abc2svgExportSvg, exportPrintBody: abc2svgExportPrintBody });
}

/** Selection highlight on whichever engraver is live (section-relative chars). */
function _rangeHighlightNow(adjFrom, adjTo) {
  if (_a2sScore) { _a2sScore.highlightRange(adjFrom, adjTo); return; }
  if (!_engraver) return;
  try { _engraver.rangeHighlight(adjFrom, adjTo); } catch { /* stale after re-render */ }
}

// Active playback handles (null when not playing).
// _synth is used as a boolean sentinel — truthy while playing.
let _synth = null;
let _timingCallbacks = null;
let _audioContext = null;
// iOS: backgrounding the app interrupts the audio session and leaves the
// AudioContext dead — resume() reports success but no sound comes out until the
// context is rebuilt. Set when the OS interrupts us (see the statechange /
// visibility handlers) so the next play recreates the context inside its gesture.
let _audioInterrupted = false;
let _stopping = false;   // re-entrancy guard for stopPlayback (synth onEnded)
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
  _a2sScore    = null;
  _playEl      = null;
  _a2sResizeObs?.disconnect();
  _a2sResizeObs = null;
  clearTimeout(_a2sResizeTimer);
  el.innerHTML = '';

  if (!content.trim()) {
    el.innerHTML = '<p class="preview-empty">Enter ABC notation to see sheet music.</p>';
    _setHasTune(false);
    return;
  }

  const container = document.createElement('div');
  container.className = 'abc-preview-wrap';
  el.appendChild(container);

  // Derived tune title: when the ABC has no explicit `T:` field, show the
  // document title (set once, in the top bar) as the sheet's title. An explicit
  // `T:` overrides it. This is a DOM heading, NOT a source injection, so abcjs's
  // char positions still map 1:1 to the editor (note↔source highlighting stays
  // correct). Exports inject `T:` into the string instead (see _withDerivedTitle).
  if (!/^\s*T:/m.test(content)) {
    const t = (state.title || '').trim();
    if (t && !/^untitled/i.test(t)) {
      const h = document.createElement('div');
      h.className = 'abc-derived-title';
      h.textContent = t;
      el.insertBefore(h, container);
    }
  }

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
    _lastAbcSource = content;
    _voiceMap    = buildVoiceMap(content);
    _playEl      = container;

    // abc2svg engraving (default): abcjs's render above stays in the DOM but
    // hidden — its engraver/TimingCallbacks/synth remain the audio + timing
    // engine — while abc2svg draws the score the user sees. If abc2svg can't
    // render this content, fall back to showing the abcjs render.
    //
    // `%%tablature`/`%%tab` (the abcjs pragma) keeps the abcjs renderer: abcjs
    // ADDS a tab staff below the notation, while abc2svg's %%strtab CONVERTS a
    // voice into a tab staff — falling back preserves those docs exactly.
    // abc2svg-native tablature is available via %%strtab (strtab-1.js bundled).
    let localScore = null;
    if (useAbc2svg() && !tablature) {
      const engravingEl = document.createElement('div');
      engravingEl.className = 'abc2svg-wrap';
      el.appendChild(engravingEl);
      localScore = renderAbc2svg(content, engravingEl, {
        onSelect: (from, to) => {
          // Re-establish this block as the active playback context (parity
          // with the abcjs clickListener above).
          _engraver    = localEngraver;
          _tuneObjects = localTuneObjects;
          _a2sScore    = localScore;
          _playEl      = container;
          _sectionOffset = localOffset;
          _lastNoteBlockOffset = localOffset;
          _lastNoteClickRange  = { from, to };
          state.emit('dsl-select', { from: from + localOffset, to: to + localOffset });
          _setNoteSelected(true);
          localScore.highlightRange(from, to);
        },
      });
      if (localScore) container.style.display = 'none';
      else engravingEl.remove();

      // Watch the wrap's width and re-engrave when it differs meaningfully
      // from the width the score was engraved for (first-layout settle,
      // window/split resize). pageWidth is null when the doc pins its own
      // %%pagewidth — then the layout is the author's, don't second-guess it.
      if (localScore?.pageWidth) {
        try {
          _a2sResizeObs = new ResizeObserver(() => {
            clearTimeout(_a2sResizeTimer);
            _a2sResizeTimer = setTimeout(() => {
              if (_a2sScore !== localScore || state.abcPlaying) return;
              const w = engravingEl.clientWidth;
              if (w && Math.abs(w - localScore.pageWidth) / w > 0.1) {
                render(content, el);   // re-measures and re-engraves
              }
            }, 250);
          });
          _a2sResizeObs.observe(engravingEl);
        } catch { /* ResizeObserver unsupported — engraved width stays as-is */ }
      }
    }
    _a2sScore = localScore;

    // If a note from this block was selected before the re-render, restore the
    // visual highlight on the freshly-created SVG elements.
    if (_hasNoteHighlight && _lastNoteClickRange && localOffset === _lastNoteBlockOffset) {
      _rangeHighlightNow(_lastNoteClickRange.from, _lastNoteClickRange.to);
    }

    _setHasTune(!!(tuneObjects?.[0]));

    // Transport: build the note-timing table (drives duration, the scrubber, and
    // char→ms mapping for selection-driven seeking) and reset position.
    if (tuneObjects?.[0]) _buildNoteEvents(tuneObjects[0]);
    else _noteEvents = [];
    _totalMs = _durationFromEvents();
    _pausedAtMs = 0;
    _selRangeMs = null;
    state.abcDurationMs = _totalMs;
    state.emit('abc-duration', { total: _totalMs });
    state.emit('abc-range', null);
    // Score-level overlay: the playback cursor bar + range band that span the
    // staves in the render pane.  Created against the freshly-rendered SVG.
    _setupScoreCursor(container);
    // Re-project the current editor selection onto the fresh timing table so a
    // persisted range highlight / cursor position survives a re-render.
    _syncTransportToSelection(_lastEditorSel.from, _lastEditorSel.to);
    _updateScoreRange();
    _updateScoreCursor(_pausedAtMs);
    _applyVoiceFade();
    // If this render was triggered by typing a note, sound it now that the
    // timing table can resolve its pitch.
    _consumePendingTypeAudition();
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

  // Move the transport to match: jump the scrubber to the note under the cursor,
  // or highlight the range a selection will play (and cue its start).
  _syncTransportToSelection(from, to);

  // Audition: a collapsed cursor landing on a note sounds it (debounced so
  // skimming with held arrow keys doesn't machine-gun; per-note dedupe inside).
  if (from === to && !state.abcPlaying &&
      (state.activeDslId ?? state.data?.dslType) === 'abcjs') {
    _auditionSoon(Math.max(0, from - _sectionOffset));
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
  // Clicking a note in the preview cues the transport to that note.
  _syncTransportToSelection(from, from);
  // …and sounds it (forced: re-clicking the same note plays it again).
  _auditionAt(Math.max(0, from - _sectionOffset), { force: true });
});

// A note letter (or an octave mark extending one) typed in the editor is
// auditioned — but its pitch only exists after the debounced re-render re-parses
// the tune, so just record it here; render() consumes it once the fresh timing
// table is up.  Accidentals (^ _ =) precede the letter in ABC, so the letter
// keystroke completes the note and the audition includes them.
state.on('editor-type', ({ pos, ch }) => {
  if ((state.activeDslId ?? state.data?.dslType) !== 'abcjs') return;
  if (!/[A-Ga-g,']/.test(ch)) return;
  _pendingTypeAudition = { pos, at: performance.now() };
  // Create/unlock the AudioContext now, inside the keystroke (a user gesture) —
  // the audition itself runs from the debounced re-render, outside the gesture,
  // where a first-ever AudioContext would be blocked by the autoplay policy.
  if (!_resolveMidiOut()) { try { _acquireAudioContext(); } catch { /* no audio */ } }
});

// Voice mute/solo toggled → re-fade the score, and if we're mid-playback restart
// from the current position so the newly muted/soloed voices take effect at once.
state.on('abc-voices-change', () => {
  _applyVoiceFade();
  if (state.abcPlaying) {
    const ms = _currentMs();
    stopPlayback({ keepPosition: true });
    startPlayback({ startMs: ms });
  }
});

// Loading a different document (checkout / branch switch) clears voice selections
// so stale voice ids don't silence the new tune.
state.on('checkout',      () => state.clearVoiceSelections());
state.on('branch-switch', () => state.clearVoiceSelections());

// ---------------------------------------------------------------------------
// Note audition — sound a single note/chord when it is written or selected
//
// Triggers:
//   • editor cursor lands on a note (collapsed cursor, 'editor-select')
//   • a note is clicked in the rendered score ('dsl-select')
//   • a note letter / octave mark is typed ('editor-type', consumed by render()
//     via _consumePendingTypeAudition once the new timing table exists)
//
// Output follows the playback routing: the selected external MIDI port when one
// is set (single note on/off, default channel — per-voice channel/keyswitch
// state is a playback concern), else abcjs.synth.playEvent on the persistent
// AudioContext (the bundled offline piano). Muted / non-soloed voices stay
// silent. Never fires during playback.
// ---------------------------------------------------------------------------

let _lastAuditionChar    = -1;    // startChar last auditioned by a cursor move (dedupe)
let _auditionTimer       = 0;     // trailing debounce for cursor-move audition
let _pendingTypeAudition = null;  // { pos: doc-relative char, at: timestamp }
let _auditionFlashTimer  = 0;     // clears the green "now sounding" flash

/** Playback-style highlight on the audited note for `durMs`: green glyphs in
 *  the score and the green play-cursor colour in the editor, exactly as
 *  _highlightEvent does during playback — but for this one note only (a
 *  timing *moment* spans every voice sounding at once; the audition sounds
 *  just the note under the cursor). Cleared on a timer; a real playback
 *  started mid-flash owns the highlight and the clear stands down. */
function _auditionFlash(startChar, endChar, durMs) {
  const doc  = state.currentContent ?? '';
  const to   = endChar + _sectionOffset;
  const from = _trimToNoteStart(doc, startChar + _sectionOffset, to);

  // abcjs-engraver fallback (escape hatch / %%tablature): the note's own SVG
  // groups, green via the container's playback palette class.
  const groups = [];
  for (const ev of _noteEvents) {
    const starts = ev.startCharArray ?? [ev.startChar];
    (ev.elements ?? []).forEach((els, i) => {
      if (starts[i] === startChar) groups.push(...(els ?? []));
    });
  }
  _playEl?.classList.add('abc-playing');
  groups.forEach(el => el?.classList?.add('abcjs-note_playing'));

  _a2sScore?.setPlaying([{ from: startChar, to: endChar }]);
  state.emit('abc-play-cursor', from < to ? [{ from, to }] : null);

  clearTimeout(_auditionFlashTimer);
  _auditionFlashTimer = setTimeout(() => {
    if (state.abcPlaying) return;   // playback started mid-flash — leave its highlight
    _playEl?.classList.remove('abc-playing');
    _playEl?.querySelectorAll('.abcjs-note_playing').forEach(el =>
      el.classList.remove('abcjs-note_playing'));
    _a2sScore?.setPlaying(null);
    state.emit('abc-play-cursor', null);
  }, durMs);
}

/** Debounced cursor-move audition (skimming lines doesn't machine-gun). */
function _auditionSoon(adjChar) {
  clearTimeout(_auditionTimer);
  _auditionTimer = setTimeout(() => _auditionAt(adjChar), 80);
}

/** All unmuted midiPitches sounding the note/chord starting at `startChar`
 *  (a chord's pitches share one startChar), plus the tempo for duration. */
function _pitchesAtStart(startChar) {
  const pitches = [];
  let msPerMeasure = 1000;
  for (const ev of _noteEvents) {
    for (const p of ev.midiPitches ?? []) {
      if (p?.pitch == null || p.startChar !== startChar) continue;
      if (_isMutedAtChar(p.startChar)) continue;
      pitches.push(p);
      msPerMeasure = ev.millisecondsPerMeasure || msPerMeasure;
    }
  }
  return { pitches, msPerMeasure };
}

/** Sound the note/chord whose source token covers section-relative `adjChar`.
 *  Strictly covering — a cursor between notes plays nothing (no "nearest note"
 *  fallback; that would audition a half-typed accidental as the NEXT note).
 *  Consecutive cursor events inside the same token play once; `force` (preview
 *  click, fresh keystroke) always plays. */
function _auditionAt(adjChar, { force = false } = {}) {
  if (state.abcPlaying || !_noteEvents.length) return;
  const note = _flatNotes().find(n => n.startChar <= adjChar && adjChar < n.endChar);
  if (!note) { _lastAuditionChar = -1; return; }
  if (!force && note.startChar === _lastAuditionChar) return;
  _lastAuditionChar = note.startChar;

  const { pitches, msPerMeasure } = _pitchesAtStart(note.startChar);
  if (!pitches.length) return;   // rest, or the whole chord is muted

  // Green "now sounding" flash for roughly the note's sounding length,
  // regardless of which output route makes the sound.
  const flashMs = Math.min(1500, Math.max(150,
    ...pitches.map(p => (p.duration ?? 0.25) * msPerMeasure / _meterSize)));
  _auditionFlash(note.startChar, note.endChar, flashMs);

  const out = _resolveMidiOut();
  if (out) {
    for (const p of pitches) {
      const pitch = Math.round(p.pitch);
      const vel   = Math.max(1, Math.min(127, Math.round(p.volume ?? 92)));
      const durMs = Math.min(1500, Math.max(60, (p.duration ?? 0.25) * msPerMeasure / _meterSize));
      try { out.send([0x90, pitch, vel]); } catch { return; }
      setTimeout(() => { try { out.send([0x80, pitch, 0]); } catch { /* port vanished */ } }, durMs);
    }
    return;
  }

  try {
    // Same iOS rules as playback: persistent context, media-style session.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }
    _acquireAudioContext();
    abcjs.synth.registerAudioContext(_audioContext);
    // playEvent builds a throwaway one-moment synth; with no soundFontUrl it
    // resolves through the overridden load-note → the bundled offline piano.
    abcjs.synth.playEvent(pitches, undefined, msPerMeasure).catch(() => { /* no audio */ });
  } catch { /* audio unavailable — audition is best-effort */ }
}

/** Called at the end of render(): play the note the user just typed, now that
 *  the fresh timing table can resolve its pitch (key signature, accidentals,
 *  octave marks included). Staleness-guarded so an unrelated later render
 *  (resize re-engrave, checkout) doesn't replay an old keystroke. */
function _consumePendingTypeAudition() {
  if (!_pendingTypeAudition) return;
  const { pos, at } = _pendingTypeAudition;
  _pendingTypeAudition = null;
  if (performance.now() - at > 2000) return;
  _auditionAt(Math.max(0, pos - _sectionOffset), { force: true });
}

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
function _scheduleOscillators(noteEvents, startSeconds, stopMs) {
  const scheduleBase = _audioContext.currentTime + 0.05;

  for (let i = 0; i < noteEvents.length; i++) {
    const event      = noteEvents[i];
    const offsetSec  = event.milliseconds / 1000 - startSeconds;
    if (offsetSec < 0) continue;

    // Range mode: stop by time (voice-independent).  A char-based stop would
    // skip whole voices, since one voice's char offsets never straddle another's.
    if (stopMs !== null && event.milliseconds >= stopMs - 0.5) continue;

    const nextEv     = noteEvents[i + 1];
    const gapSec     = nextEv ? (nextEv.milliseconds - event.milliseconds) / 1000 : 1.0;
    const noteDurSec = Math.max(0.05, gapSec * 0.92);

    for (const p of (event.midiPitches ?? [])) {
      if (p?.pitch == null) continue;
      if (_isMutedAtChar(p.startChar)) continue; // muted / non-soloed voice

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
 * look-ahead pump.  `startSeconds` is the playback offset; `stopMs` (or null)
 * bounds a range selection by time.  `meterSize` converts note durations → ms.
 */
// ---------------------------------------------------------------------------
// Keyswitches → articulations (MIDI-out only)
//
// A document can declare a map of articulation name → MIDI action in its global
// front matter, and mark notes/passages with `!name!` decorations (sticky until
// the next mark).  When routed to an external instrument we fire the mapped
// keyswitch note / CC / program-change just before the note whose articulation
// changed, so a library that understands keyswitches plays the right articulation.
//
//   ---
//   midi:
//     keyswitches:
//       legato: 24                    # note number or name (C-1 = 0)
//       staccato: 25
//       pizzicato: { cc: 32, value: 6 }
//       arco: { program: 1 }
//     lead-ms: 20
//     hold: momentary                 # momentary | held
//   ---
// ---------------------------------------------------------------------------

/**
 * Parse a keyswitch note value: a raw MIDI number (always literal, 0–127), or a
 * note name whose octave numbering depends on `midMidiOctave` — the octave that
 * middle C (MIDI 60) is called.  Kontakt's default is C3, so with octave=3,
 * `F-1` → 17 (matching Kontakt's display); the scientific convention is C4.
 */
function _parseKsNote(v, midMidiOctave = 3) {
  const s = String(v).trim();
  if (/^-?\d+$/.test(s)) { const n = +s; return n >= 0 && n <= 127 ? n : null; }
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(s);
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  const acc  = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  // C{midMidiOctave} must equal MIDI 60 → octave offset = 5 − midMidiOctave.
  const n = base + acc + (parseInt(m[3], 10) + (5 - midMidiOctave)) * 12;
  return n >= 0 && n <= 127 ? n : null;
}

// abcjs marking symbols → canonical names used in the map.
const MARK_ALIAS = { '>': 'accent', '^': 'marcato', '.': 'staccato' };

/** Parse a `velocity:` value → { velAbs | velScale | velBump }. */
function _parseVel(v) {
  const s = String(v).trim();
  if (/^[+-]\d+$/.test(s)) return { velBump: parseInt(s, 10) };           // accent bump (per-note)
  if (/^\d+$/.test(s))     return { velAbs: Math.max(0, Math.min(127, +s)) }; // dynamic level (sticky)
  const f = parseFloat(s);
  if (!Number.isNaN(f))    return { velScale: f };                        // scale of abcjs default
  return {};
}

/**
 * Normalise one map entry → an action object that may combine any of:
 *   note (keyswitch), cc {cc,value}, program, and a velocity effect
 *   (velAbs sticky level | velScale | velBump per-note).
 * A bare scalar value is treated as a keyswitch note (back-compat).
 */
function _normalizeEntry(v, octave) {
  const e = {};
  if (v && typeof v === 'object') {
    if (v.note != null)    { const n = _parseKsNote(v.note, octave); if (n != null) e.note = n; }
    if (v.cc != null)      e.cc = { cc: +v.cc, value: v.value != null ? +v.value : 127 };
    if (v.program != null) e.program = +v.program;
    if (v.velocity != null) Object.assign(e, _parseVel(v.velocity));
  } else if (v != null && v !== '') {
    const n = _parseKsNote(v, octave); if (n != null) e.note = n;
  }
  return e;
}

/** Normalise a whole `map`/`keyswitches` table → { name: entry }. */
function _normalizeMap(raw, octave) {
  const map = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const key = String(k).trim().toLowerCase();
    const e = _normalizeEntry(v, octave);
    if (Object.keys(e).length) map[key] = e;
  }
  return map;
}

/** True if an entry switches articulation (fires a keyswitch/CC/program). */
function _isSwitch(e) { return e && (e.note != null || e.cc != null || e.program != null); }
/** True if an entry sets a sticky dynamic level (absolute or scaled velocity). */
function _isLevel(e)  { return e && (e.velAbs != null || e.velScale != null); }

/** Octave that middle C is called, from `midi.octave` (e.g. `c3`, `4`). Default 3 (Kontakt). */
function _midiOctaveBase(midi) {
  const m = /(-?\d+)/.exec(String(midi?.octave ?? ''));
  return m ? parseInt(m[1], 10) : 3;
}

/**
 * Build the keyswitch / voice-routing plan from the document front matter + the
 * rendered ABC source.  Returns null when neither keyswitches nor voices are
 * declared (feature off).
 *
 * Each ABC voice (in score order) → a 1-based voice number → a MIDI channel
 * (`midi.voices.<n>.channel`, default = the voice number) and its own keyswitch
 * map (`midi.voices.<n>.keyswitches`, default = top-level `midi.keyswitches`).
 */
function _buildKeyswitchPlan(tune) {
  let meta;
  try { meta = parseGlobalFrontMatter(state.currentContent ?? '').meta; } catch { return null; }
  const midi = meta?.midi;
  if (!midi || typeof midi !== 'object') return null;
  const hasVoices = midi.voices && typeof midi.voices === 'object';
  const hasMap = (midi.map && typeof midi.map === 'object') ||
                 (midi.keyswitches && typeof midi.keyswitches === 'object');
  if (!hasVoices && !hasMap) return null;

  const octave = _midiOctaveBase(midi);
  const leadMs = Math.max(0, Number(midi['lead-ms'] ?? midi.leadMs ?? 20) || 0);
  const hold   = String(midi.hold ?? 'momentary').toLowerCase() === 'held' ? 'held' : 'momentary';
  const slurName = midi.slur != null ? String(midi.slur).trim().toLowerCase() : null;
  // `map` is the general table; `keyswitches` is the legacy alias (merged under it).
  const globalMap = { ..._normalizeMap(midi.keyswitches, octave), ..._normalizeMap(midi.map, octave) };

  // Per-voice config keyed by voice number: channel, mix (volume/pan/velScale),
  // and a map that merges voice overrides over the global map.
  const voiceConfig = new Map();
  if (hasVoices) {
    for (const [k, v] of Object.entries(midi.voices)) {
      const vn = parseInt(k, 10);
      if (!Number.isFinite(vn) || !v || typeof v !== 'object') continue;
      const vMap = { ..._normalizeMap(v.keyswitches, octave), ..._normalizeMap(v.map, octave) };
      voiceConfig.set(vn, {
        channel: v.channel != null ? +v.channel : vn,
        volume:  v.volume   != null ? Math.max(0, Math.min(127, +v.volume)) : null,
        pan:     v.pan      != null ? Math.max(0, Math.min(127, +v.pan))    : null,
        velScale: v.velocity != null ? (parseFloat(v.velocity) || 1) : 1,
        map: { ...globalMap, ...vMap },
      });
    }
  }
  const cfg             = (vn) => voiceConfig.get(vn);
  const entryFor        = (vn, name) => cfg(vn)?.map[name] ?? globalMap[name];
  const channelForVoice = (vn) => ((cfg(vn)?.channel ?? vn) - 1) & 0x0f;
  const velScaleForVoice = (vn) => cfg(vn)?.velScale ?? 1;

  // Walk the tune → notes (staff/voice identity, startChar/endChar, decorations).
  // Voice number = score order of distinct (staff,voice) pairs.
  const notes = [];
  const svKeys = new Set();
  try {
    for (const line of tune.lines || [])
      for (let si = 0; si < (line.staff || []).length; si++)
        for (let vi = 0; vi < (line.staff[si].voices || []).length; vi++)
          for (const el of line.staff[si].voices[vi]) {
            if (el.el_type !== 'note' || el.startChar == null) continue;
            const sv = si * 100 + vi;
            svKeys.add(sv);
            notes.push({ startChar: el.startChar, endChar: el.endChar ?? el.startChar + 2, sv, decoration: el.decoration });
          }
  } catch { /* tolerate unexpected shapes */ }
  const svToVoice = new Map([...svKeys].sort((a, b) => a - b).map((k, i) => [k, i + 1]));
  const charToVoice = (sc) => svToVoice.get(notes.find(n => n.startChar === sc)?.sv) ?? 1;

  // Assign each token to the note whose span contains it (else the next note),
  // so a `!name!` in one voice's line doesn't leak to another.
  const byStart = notes.slice().sort((a, b) => a.startChar - b.startChar);
  const noteForIndex = (idx) =>
    byStart.find(n => n.startChar <= idx && idx < n.endChar) ??
    byStart.find(n => n.startChar >= idx) ??
    byStart[byStart.length - 1] ?? null;

  // Per-note marking sets, keyed by the note's startChar.
  const noteMarks = new Map();
  const addMark = (sc, name) => {
    if (sc == null) return;
    let s = noteMarks.get(sc); if (!s) { s = new Set(); noteMarks.set(sc, s); }
    s.add(name);
  };
  // (a) `!name!` tokens scanned from source (abcjs drops unknown decorations).
  const re = /!([^!\n]+)!/g;
  for (let m; (m = re.exec(_lastAbcSource)); ) {
    const name = (MARK_ALIAS[m[1].trim()] ?? m[1].trim().toLowerCase());
    const n = noteForIndex(m.index);
    if (n) addMark(n.startChar, name);
  }
  // (b) decorations abcjs DOES attach (notably `.` → "staccato").
  for (const n of notes) {
    if (!Array.isArray(n.decoration)) continue;
    for (const d of n.decoration) addMark(n.startChar, MARK_ALIAS[d] ?? String(d).toLowerCase());
  }

  return {
    leadMs, hold, slurName, globalMap,
    charToVoice, channelForVoice, velScaleForVoice, entryFor,
    noteMarks,
    voiceMix: voiceConfig,   // Map<vn,{channel,volume,pan,velScale,map}>
  };
}

/** Emit the switch parts (keyswitch note / CC / program) of a map entry at `at`. */
function _emitSwitchEntry(msgs, entry, at, ch, hold, st) {
  if (entry.note != null) {
    if (hold === 'held' && st.heldKs != null) msgs.push({ at, status: 0x80 | ch, pitch: st.heldKs, vel: 0 });
    msgs.push({ at, status: 0x90 | ch, pitch: entry.note, vel: 100 });
    if (hold === 'held') st.heldKs = entry.note;
    else msgs.push({ at: at + 15, status: 0x80 | ch, pitch: entry.note, vel: 0 });
  }
  if (entry.cc) msgs.push({ at, status: 0xB0 | ch, pitch: entry.cc.cc, vel: Math.max(0, Math.min(127, entry.cc.value)) });
  if (entry.program != null) msgs.push({ at, bytes: [0xC0 | ch, Math.max(0, Math.min(127, entry.program))] });
}

function _startMidiPlayback(out, noteEvents, startSeconds, stopMs, meterSize, ksPlan) {
  _midiOut = out;
  _midiActiveNotes.clear();
  const t0 = performance.now() + MIDI_PREROLL_MS;
  const msgs = [];

  // Per-voice state: sticky articulation (switch) + sticky dynamic level +
  // held keyswitch + which note we last processed marks for (chord de-dupe).
  const vstate = new Map();
  const vget = (vn) => {
    let s = vstate.get(vn);
    if (!s) { s = { artic: null, lastArtic: undefined, level: null, heldKs: null, lastSc: -1 }; vstate.set(vn, s); }
    return s;
  };

  // Per-voice mix: send volume (CC7) / pan (CC10) once at the start on the channel.
  if (ksPlan?.voiceMix) {
    for (const [vn, c] of ksPlan.voiceMix) {
      const ch = ksPlan.channelForVoice(vn);
      if (c.volume != null) msgs.push({ at: t0, status: 0xB0 | ch, pitch: 7,  vel: c.volume });
      if (c.pan    != null) msgs.push({ at: t0, status: 0xB0 | ch, pitch: 10, vel: c.pan });
    }
  }

  for (const ev of noteEvents) {
    const evSec = ev.milliseconds / 1000;
    const played = evSec >= startSeconds - 1e-6;
    const msPerMeasure = ev.millisecondsPerMeasure || 1000;
    const onAt = t0 + (evSec - startSeconds) * 1000;

    for (const p of (ev.midiPitches ?? [])) {
      if (p?.pitch == null) continue;
      const sc = p.startChar;
      if (_isMutedAtChar(sc)) continue; // muted / non-soloed voice
      const voice = ksPlan ? ksPlan.charToVoice(sc) : 1;
      const ch = ksPlan ? ksPlan.channelForVoice(voice) : 0;
      const st = ksPlan ? vget(voice) : null;

      // Per-note velocity bumps (accents) accumulate here; sticky state below.
      let bump = 0;
      if (ksPlan && sc !== st.lastSc) {
        // Process this note's markings once (not per chord-pitch), in source order.
        st.lastSc = sc;
        for (const name of ksPlan.noteMarks.get(sc) ?? []) {
          const e = ksPlan.entryFor(voice, name);
          if (!e) continue;
          if (_isSwitch(e)) st.artic = name;       // sticky articulation switch
          if (_isLevel(e))  st.level = e;          // sticky dynamic level
        }
      }
      // Accent-type bumps apply to THIS note only (re-read each pitch is fine).
      if (ksPlan) {
        for (const name of ksPlan.noteMarks.get(sc) ?? []) {
          const e = ksPlan.entryFor(voice, name);
          if (e?.velBump) bump += e.velBump;
        }
      }

      // Range mode: skip notes at/after the selection end by time (state already
      // updated).  Time-based so a range in one voice doesn't drop the others.
      if (stopMs !== null && ev.milliseconds >= stopMs - 0.5) continue;
      if (!played) continue; // before the entry point — no output, state is current

      // Fire the articulation keyswitch on change (force on first played note).
      if (ksPlan && st.artic !== st.lastArtic) {
        const e = st.artic ? ksPlan.entryFor(voice, st.artic) : null;
        if (e && _isSwitch(e)) {
          const at = Math.max(performance.now(), onAt - ksPlan.leadMs);
          _emitSwitchEntry(msgs, e, at, ch, ksPlan.hold, st);
        }
        st.lastArtic = st.artic;
      }

      // Velocity: dynamic level (abs/scaled) overrides abcjs default, + accent
      // bump, × per-voice velocity scale.
      const abcVol = p.volume ?? 92;
      let base = abcVol;
      if (st?.level?.velAbs   != null) base = st.level.velAbs;
      else if (st?.level?.velScale != null) base = abcVol * st.level.velScale;
      const scale = ksPlan ? ksPlan.velScaleForVoice(voice) : 1;
      const vel = Math.max(1, Math.min(127, Math.round((base + bump) * scale)));

      const pitch = Math.round(p.pitch);
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
    const bytes = m.bytes ?? [m.status, m.pitch, m.vel];
    try { _midiOut.send(bytes, m.at); } catch { /* port vanished */ }
    // Track sounding notes (incl. held keyswitch notes) so panic can release them.
    const st = m.status ?? bytes[0];
    if ((st & 0xf0) === 0x90)      _midiActiveNotes.add((st & 0x0f) + ':' + bytes[1]);
    else if ((st & 0xf0) === 0x80) _midiActiveNotes.delete((st & 0x0f) + ':' + bytes[1]);
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
/** Advance `from` past leading whitespace, `!…!` decorations and `.` so the
 *  play-cursor highlight lands on the note itself, not its preceding marks. */
function _trimToNoteStart(content, from, to) {
  let i = from;
  while (i < to) {
    const ch = content[i];
    if (ch === '!') {
      const end = content.indexOf('!', i + 1);
      if (end === -1 || end >= to) break;
      i = end + 1; continue;
    }
    if (ch === '.' || /\s/.test(ch)) { i++; continue; }
    break;
  }
  return i;
}

// Highlight one timing "moment" (its simultaneous notes) in the SVG and emit its
// char ranges for the editor's green play-cursor.  `event` is a noteTimings entry
// (or null to clear).  Driven by the wall-clock visual loop below.
function _highlightEvent(event) {
  if (_playEl) {
    _playEl.querySelectorAll('.abcjs-note_playing').forEach(el =>
      el.classList.remove('abcjs-note_playing')
    );
  }
  if (!event) {
    _a2sScore?.setPlaying(null);
    state.emit('abc-play-cursor', null);
    return;
  }

  // Editor: emit all voice char ranges for green text-colour highlighting.
  // abcjs char indices are section-relative → add _sectionOffset to map them to
  // document positions; and trim leading decorations/whitespace so the green
  // covers the note, not its `!legato!`/`.` marks (abcjs's startChar can point
  // at the decoration that precedes the note).  Muted / non-soloed voices are
  // skipped entirely — neither the SVG note nor the editor cursor lights up
  // (`elements[i]` parallels `startCharArray[i]`, one entry per sounding voice).
  const doc    = state.currentContent ?? '';
  const starts = event.startCharArray ?? [event.startChar];
  const ends   = event.endCharArray   ?? [event.endChar];
  const groups = event.elements ?? [];
  const ranges = [];
  const secPairs = [];   // section-relative pairs for the abc2svg score
  starts.forEach((s, i) => {
    if (s === undefined || ends[i] === undefined) return;
    if (_isMutedAtChar(s)) return;
    if (_playEl) (groups[i] ?? []).forEach(el => el?.classList?.add('abcjs-note_playing'));
    secPairs.push({ from: s, to: ends[i] });
    const to   = ends[i] + _sectionOffset;
    const from = _trimToNoteStart(doc, s + _sectionOffset, to);
    if (from < to) ranges.push({ from, to });
  });
  _a2sScore?.setPlaying(secPairs.length ? secPairs : null);
  state.emit('abc-play-cursor', ranges.length ? ranges : null);
}

// Wall-clock visual driver.  abcjs's own TimingCallbacks fire the cursor on a
// clock that can trail the audio (rAF granularity plus the 60ms setTimeout
// jogger fallback when a frame is dropped), so the highlight was landing
// slightly BEHIND the sound.  We drive the highlight from the transport's
// wall-clock progress loop instead, and fire it a small lead ahead of the audio
// position so the note lights up as it sounds rather than just after.  The lead
// compensates render + audio-output latency; tune on-device if needed.
const VISUAL_LEAD_MS = 40;
let _visualStopMs   = null;  // range-end ms while playing (null = whole tune)
let _visualIdx      = -1;    // last-highlighted event index (skip redundant work)

// ── Score-level cursor + range overlay (render pane) ───────────────────────
// A separate <svg> layered over the abcjs SVG (kept OUT of the dark-mode invert
// filter so its colours are correct) sharing the abcjs viewBox, so note-timing
// x-coordinates map 1:1.  Holds a vertical playback bar that tracks the scrubber
// position across the staves, plus a translucent band + edge bars for the
// currently selected playback range.
let _overlaySvg     = null;  // our overlay <svg class="uf-abc-overlay-svg">
let _abcSvgEl       = null;  // the abcjs <svg> (for per-line getBBox lookups)
let _cursorLine     = null;  // <line> playback position bar
let _rangeGroup     = null;  // <g> range band + edge bars
let _lineExtents    = null;  // Map<lineIndex, {y, h}> — cached per render
let _overlayResizeObs = null;// keeps the overlay box aligned to the responsive SVG

/** Highlight the note(s) sounding at `targetMs` (= audio position + lead). */
function _applyVisualAt(targetMs) {
  if (!_noteEvents.length) return;
  // Events are sorted by onset: the active moment is the last one at/before now.
  let idx = -1;
  for (let i = 0; i < _noteEvents.length; i++) {
    if (_noteEvents[i].milliseconds <= targetMs) idx = i; else break;
  }
  // Range mode: never light a note at/after the range end (matches playback stop).
  if (_visualStopMs !== null) {
    while (idx >= 0 && _noteEvents[idx].milliseconds >= _visualStopMs - 0.5) idx--;
  }
  if (idx === _visualIdx) return;
  _visualIdx = idx;
  _highlightEvent(idx >= 0 ? _noteEvents[idx] : null);
}

// abcjs TimingCallbacks still runs during playback to detect the end of the tune
// and the range stop point; the visual cursor is handled by _applyVisualAt.
function _makeVisualEventCallback(stopMs) {
  return (event) => {
    if (!event) { stopPlayback(); return; }
    // Range mode: stop once the moment's onset reaches the selection end (time-
    // based, so a range confined to one voice still stops all voices together).
    if (stopMs !== null && event.milliseconds >= stopMs - 0.5) { stopPlayback(); return; }
  };
}

const _SVG_NS = 'http://www.w3.org/2000/svg';

/** Build the overlay <svg> over the freshly-rendered abcjs SVG. */
function _setupScoreCursor(container) {
  _overlaySvg = _abcSvgEl = _cursorLine = _rangeGroup = null;
  _lineExtents = new Map();
  _overlayResizeObs?.disconnect();
  _overlayResizeObs = null;

  // abc2svg mode: the cursor bar is the score object's own positioned div
  // (see abc2svg-render.js cursorAt) — no abcjs-viewBox overlay to build.
  if (_a2sScore) return;

  const svg = container?.querySelector('svg');
  const viewBox = svg?.getAttribute('viewBox');
  if (!svg || !viewBox) return;
  _abcSvgEl = svg;

  const ov = document.createElementNS(_SVG_NS, 'svg');
  ov.setAttribute('class', 'uf-abc-overlay-svg');
  ov.setAttribute('viewBox', viewBox);
  ov.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  ov.setAttribute('aria-hidden', 'true');

  const rg = document.createElementNS(_SVG_NS, 'g');
  rg.setAttribute('class', 'uf-abc-range');
  const ln = document.createElementNS(_SVG_NS, 'line');
  ln.setAttribute('class', 'uf-abc-cursor');
  ln.style.display = 'none';
  ov.appendChild(rg);   // band behind
  ov.appendChild(ln);   // cursor in front
  container.appendChild(ov);

  _overlaySvg = ov;
  _rangeGroup = rg;
  _cursorLine = ln;

  // Keep the overlay box exactly over the abcjs SVG (which scales responsively).
  // SVG elements have no offset* geometry, so measure with getBoundingClientRect
  // relative to the shared parent (the positioned .abc-preview-wrap container).
  const sync = () => {
    if (!_overlaySvg || !_abcSvgEl) return;
    const pr = container.getBoundingClientRect();
    const sr = _abcSvgEl.getBoundingClientRect();
    if (!sr.width || !sr.height) return;   // not laid out yet
    _overlaySvg.style.left   = (sr.left - pr.left) + 'px';
    _overlaySvg.style.top    = (sr.top  - pr.top)  + 'px';
    _overlaySvg.style.width  = sr.width  + 'px';
    _overlaySvg.style.height = sr.height + 'px';
  };
  sync();
  try {
    _overlayResizeObs = new ResizeObserver(sync);
    _overlayResizeObs.observe(_abcSvgEl);
  } catch { /* ResizeObserver unsupported — box set once above */ }
}

/** Vertical extent {y, h} (viewBox units) of a system.  abcjs already reports
 *  each note event's `top`/`height` = the extent of the system (all staves) it
 *  sits in, so use that first: it's authoritative and needs no DOM/getBBox, which
 *  avoids the whole-page cursor bug where an early `_lineExtent` call (before the
 *  SVG had laid out → getBBox height 0) cached the full-viewBox fallback for a
 *  system permanently.  Falls back to the rendered `.abcjs-l{line}` group's bbox
 *  only when no event geometry is available. */
function _lineExtentFor(line) {
  for (const e of _noteEvents) {
    if (e.line === line && e.top != null && e.height > 0) return { y: e.top, h: e.height };
  }
  return _lineExtent(line);
}

/** Vertical extent {y, h} (viewBox units) of a rendered line/system, from the DOM. */
function _lineExtent(line) {
  if (_lineExtents?.has(line)) return _lineExtents.get(line);
  let ext = null;
  try {
    const g = _abcSvgEl?.querySelector(`.abcjs-l${line}`);
    if (g) { const b = g.getBBox(); if (b.height > 0) ext = { y: b.y, h: b.height }; }
  } catch { /* getBBox can throw if not laid out */ }
  if (!ext) {
    const vb = _abcSvgEl?.getAttribute('viewBox')?.split(/\s+/).map(Number);
    // Only memoise a real measurement; a fallback (SVG not laid out yet) must not
    // stick, or the cursor would span the whole page for that system forever.
    return (vb && vb.length === 4) ? { y: vb[1], h: vb[3] } : { y: 0, h: 100 };
  }
  _lineExtents?.set(line, ext);
  return ext;
}

/** Leftmost rendered x (viewBox units) of a note event's glyphs. abcjs's `left`
 *  is the notehead; leading accidentals / grace notes render further left but are
 *  part of the same note group (`ev.elements`), so union their bounding boxes. */
function _noteGlyphLeft(ev) {
  let x = ev.left;
  for (const el of (ev.elements ?? []).flat()) {
    try {
      const b = el?.getBBox?.();
      if (b && b.width > 0 && b.x < x) x = b.x;
    } catch { /* element not laid out yet */ }
  }
  return x;
}

/** Horizontal center (viewBox units) of a note event's notehead(s) — the point a
 *  cursor should sit dead-on. Targets the notehead glyph so a leading accidental
 *  (part of the same group) doesn't bias the center left.
 *
 *  A whole/half rest is engraved CENTERED in its measure, far right of a note that
 *  onsets on the same beat. If an event mixes real notes with a resting voice (e.g.
 *  a bass chord on the downbeat while the top voice holds a whole rest), unioning
 *  the rest's bbox drags the center to mid-measure and floats the cursor off the
 *  notes that actually sound. So center on the NOTEHEADS only when any exist, and
 *  fall back to rest/other glyph geometry (then abcjs's `left`) only for an event
 *  that is entirely rests. */
function _noteCenterX(ev) {
  let min = Infinity, max = -Infinity;       // notehead extent
  let rMin = Infinity, rMax = -Infinity;     // fallback: rest/other glyph extent
  for (const g of (ev.elements ?? []).flat()) {
    if (!g?.getBBox) continue;
    const heads = [];
    if (g.matches?.('.abcjs-notehead')) heads.push(g);
    g.querySelectorAll?.('.abcjs-notehead').forEach(h => heads.push(h));
    if (heads.length) {
      for (const t of heads) {
        try {
          const b = t.getBBox();
          if (b.width > 0) { min = Math.min(min, b.x); max = Math.max(max, b.x + b.width); }
        } catch { /* element not laid out yet */ }
      }
    } else {
      try {
        const b = g.getBBox();
        if (b.width > 0) { rMin = Math.min(rMin, b.x); rMax = Math.max(rMax, b.x + b.width); }
      } catch { /* element not laid out yet */ }
    }
  }
  if (max > min)   return (min + max) / 2;    // notes present → ignore resting voices
  if (rMax > rMin) return (rMin + rMax) / 2;  // all-rest moment → center on the rest
  return ev.left;
}

/** Score position {x, y, h} of the note/rest that would sound at `ms`: the last
 *  event whose onset is at/before ms (the note playback continues from), or the
 *  first event when ms precedes it. x is the glyph's center, so the cursor snaps
 *  dead onto a note rather than floating in the gap between onsets; y/h are the
 *  extent of the system that note sits in, so the cursor stays confined to the
 *  currently-playing system rather than spanning the page. */
function _scoreSnapForMs(ms) {
  if (!_noteEvents.length) return null;
  const placed = e => e.left != null;      // skip bar/end entries without geometry
  let ev = null;
  for (const e of _noteEvents) {
    if (!placed(e)) continue;
    if (e.milliseconds <= ms + 0.5) ev = e; else break;
  }
  if (!ev) ev = _noteEvents.find(placed);  // before the first note → snap to it
  if (!ev) return null;
  const { y, h } = _lineExtentFor(ev.line ?? 0);
  return { x: _noteCenterX(ev), y, h };
}

/** Last placed note event at/before `ms` (or the first, when ms precedes it). */
function _eventAtMs(ms) {
  let ev = null;
  for (const e of _noteEvents) {
    if (e.left == null) continue;                // skip bar/end entries
    if (e.milliseconds <= ms + 0.5) ev = e; else break;
  }
  return ev ?? _noteEvents.find(e => e.left != null) ?? null;
}

/** The unmuted section-relative char pairs of a note event (for the a2s score). */
function _eventCharPairs(ev, { includeMuted = false } = {}) {
  if (!ev) return null;
  const starts = ev.startCharArray ?? [ev.startChar];
  const ends   = ev.endCharArray   ?? [ev.endChar];
  const pairs  = [];
  starts.forEach((s, i) => {
    if (s == null || ends[i] == null) return;
    if (!includeMuted && _isMutedAtChar(s)) return;
    pairs.push({ from: s, to: ends[i] });
  });
  return pairs.length ? pairs : null;
}

/** Char pairs of the last AUDIBLE event at/before `ms`. Events whose every
 *  voice is muted are skipped — the cursor bar parks on the previous sounding
 *  note instead of blinking out on each silenced onset (the timeline behaves
 *  as if only the unmuted voices exist). Falls forward to the first audible
 *  event when `ms` precedes them all; null when everything is muted. */
function _audiblePairsAtMs(ms) {
  let pairs = null;
  for (const e of _noteEvents) {
    if (e.left == null) continue;                // skip bar/end entries
    if (e.milliseconds > ms + 0.5) break;
    pairs = _eventCharPairs(e) ?? pairs;
  }
  if (pairs) return pairs;
  for (const e of _noteEvents) {
    if (e.left == null) continue;
    const p = _eventCharPairs(e);
    if (p) return p;
  }
  return null;
}

/** Position the playback cursor bar at `ms` (the true scrubber position). */
function _updateScoreCursor(ms) {
  if (_a2sScore) { _a2sScore.cursorAt(_audiblePairsAtMs(ms)); return; }
  if (!_cursorLine) return;
  const p = _scoreSnapForMs(ms);
  if (!p) { _cursorLine.style.display = 'none'; return; }
  const { y, h } = p;
  _cursorLine.setAttribute('x1', p.x);
  _cursorLine.setAttribute('x2', p.x);
  _cursorLine.setAttribute('y1', y);
  _cursorLine.setAttribute('y2', y + h);
  _cursorLine.style.display = '';
}

/** Draw (or clear) the selected-range band + start/end edge bars in the score. */
function _updateScoreRange() {
  if (_a2sScore) {
    const r = _selRangeMs;
    if (!r || !_noteEvents.length) { _a2sScore.setRange(null); return; }
    // Every voice's chars of every note that will play (onset in [start, end)) —
    // the band covers all voices; muting shows through the uf-muted fade instead.
    const pairs = [];
    for (const e of _noteEvents) {
      if (e.left == null) continue;
      if (e.milliseconds < r.startMs - 0.5 || e.milliseconds >= r.endMs - 0.5) continue;
      pairs.push(...(_eventCharPairs(e, { includeMuted: true }) ?? []));
    }
    _a2sScore.setRange(pairs.length ? pairs : null);
    return;
  }
  if (!_rangeGroup) return;
  while (_rangeGroup.firstChild) _rangeGroup.removeChild(_rangeGroup.firstChild);
  const r = _selRangeMs;
  if (!r || !_noteEvents.length) return;

  // Notes that will actually play (onset within [startMs, endMs)); the stop note
  // at endMs is excluded so the band ends where playback stops.
  const inRange = _noteEvents.filter(
    e => e.left != null && e.milliseconds >= r.startMs - 0.5 && e.milliseconds < r.endMs - 0.5
  );
  // One band per line the range spans (handles line wraps), in line order.
  const byLine = new Map();
  for (const e of inRange) {
    const c = byLine.get(e.line) ?? { min: Infinity, max: -Infinity };
    c.min = Math.min(c.min, e.left);
    c.max = Math.max(c.max, e.endX ?? e.left);
    byLine.set(e.line, c);
  }
  // Extend the band's opening edge to the first note's full glyph extent so any
  // leading accidental / grace note (drawn left of the notehead `left`) is inside
  // the highlight — those marks belong to the note that plays. Interior notes'
  // accidentals already fall within the band; only the first note's lead escapes.
  const firstEv = inRange[0];
  if (firstEv) {
    const band = byLine.get(firstEv.line);
    if (band) band.min = Math.min(band.min, _noteGlyphLeft(firstEv));
  }
  const lines = [...byLine.entries()]
    .filter(([, c]) => c.max > c.min)
    .sort((a, b) => a[0] - b[0]);
  for (const [line, c] of lines) {
    const { y, h } = _lineExtentFor(line);
    const rect = document.createElementNS(_SVG_NS, 'rect');
    rect.setAttribute('class', 'uf-abc-range-band');
    rect.setAttribute('x', c.min);
    rect.setAttribute('y', y);
    rect.setAttribute('width', c.max - c.min);
    rect.setAttribute('height', h);
    _rangeGroup.appendChild(rect);
  }
  // Start + end markers drawn as framing brackets ([ … ]) so the span's bounds
  // read as more than just the highlight, without a busy dashed line. Anchor them
  // to the band's own edges (not the stop-note onset, which sits past the band).
  if (!lines.length) return;
  const CAP = 9;   // viewBox units — length of each bracket end-cap
  const bracket = (line, x, dir) => {   // dir: +1 → opening "[" (start), -1 → closing "]" (end)
    const { y, h } = _lineExtentFor(line);
    const path = document.createElementNS(_SVG_NS, 'path');
    path.setAttribute('class', 'uf-abc-range-edge');
    path.setAttribute('d', `M${x + dir * CAP} ${y} L${x} ${y} L${x} ${y + h} L${x + dir * CAP} ${y + h}`);
    _rangeGroup.appendChild(path);
  };
  const [firstLine, firstC] = lines[0];
  const [lastLine,  lastC]  = lines[lines.length - 1];
  bracket(firstLine, firstC.min, 1);   // opening "[" at the band's left edge
  bracket(lastLine,  lastC.max, -1);   // closing "]" at the band's right edge
}

// ---------------------------------------------------------------------------
// Transport: duration, progress bar, play/pause, seek
// ---------------------------------------------------------------------------

let _totalMs       = 0;   // total tune duration (ms) — drives the scrubber
let _meterSize     = 1;   // meter fraction (num/den) of the rendered tune — note duration→ms for audition
let _pausedAtMs    = 0;   // remembered position when paused / sought (ms)
let _progressRaf   = 0;   // rAF id for progress emission
let _progressJog   = 0;   // setTimeout id: jogger fallback when rAF is throttled
let _playOffsetMs  = 0;   // ms position where the current run started
let _playWallStart = 0;   // performance.now() at the current run's start
// {startMs,endMs} of the range the current editor selection will play, or null.
// Drives the scrubber's highlighted band and lets ▶ replay just the range.
let _selRangeMs    = null;
let _scrubbing     = false;  // true while the user drags the scrubber (live bar preview)

/** Play a 1-sample silent buffer to unlock audio on iOS within a user gesture. */
function _unlockAudio(ctx) {
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* ignore */ }
}

/** Return a live, unlocked AudioContext, rebuilding it if a prior one was killed
 *  by an iOS background interruption (or closed). MUST be called inside a user
 *  gesture: a freshly-created context can only be unlocked from a gesture on iOS,
 *  and a dead-context rebuild is exactly what recovers audio after backgrounding.
 *  We still reuse ONE context across normal plays (recreating per play is what
 *  silenced the iOS PWA originally) — only a real interruption forces a rebuild. */
function _acquireAudioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  const dead = _audioContext &&
    (_audioInterrupted || _audioContext.state === 'closed' || _audioContext.state === 'interrupted');
  if (_audioContext && dead) {
    try { _audioContext.close(); } catch { /* ignore */ }
    _audioContext = null;
  }
  if (!_audioContext) {
    _audioContext = new Ctor();
    // 'interrupted' is iOS-only; flag it so the next play rebuilds rather than
    // trusting a resume() that quietly yields silence.
    _audioContext.onstatechange = () => {
      if (_audioContext && _audioContext.state === 'interrupted') _audioInterrupted = true;
    };
    _unlockAudio(_audioContext);   // silent buffer, within the gesture
  }
  _audioInterrupted = false;
  return _audioContext;
}


/** Build the note-timing table for a tune and cache it in `_noteEvents`.
 *  setUpAudio() populates midiPitches; TimingCallbacks turns them into events
 *  carrying `milliseconds` + section-relative startChar/endChar (or the *Array
 *  forms for multi-voice moments). */
function _buildNoteEvents(tune) {
  try {
    tune.setUpAudio({});
    const tc = new abcjs.TimingCallbacks(tune, { eventCallback: () => {} });
    _noteEvents = (tc.noteTimings ?? []).filter(e => e.type === 'event');
    const mf = tune.getMeterFraction?.() ?? { num: 4, den: 4 };
    _meterSize = (mf.num / mf.den) || 1;
  } catch { _noteEvents = []; }
  _lastAuditionChar = -1;   // fresh table — cursor audition dedupe restarts
}

/** Total tune duration (ms) from the cached events, for the transport display. */
function _durationFromEvents() {
  if (!_noteEvents.length) return 0;
  const last = _noteEvents[_noteEvents.length - 1];
  // `milliseconds` is the start of the last event; add ~one beat so the bar
  // reaches the end as the final note rings out.
  const beat = last.millisecondsPerMeasure ? last.millisecondsPerMeasure / 4 : 400;
  return Math.round(last.milliseconds + beat);
}

// Flatten multi-voice note events into per-voice { startChar, endChar, ms }
// entries sorted by startChar.  A timing `event` is a *moment* whose
// startCharArray/endCharArray hold one entry per simultaneous voice — and those
// voices live in completely different regions of the source (V:1's body, then
// V:2's body far below).  Matching a document char with a cross-voice
// `.some(c => c >= char)` therefore conflates regions: V:2's large offsets
// satisfy a comparison meant for a V:1 char, so the "first note at/after char"
// resolves to the wrong voice (usually the very first moment) and the range
// collapses to the whole tune.  Flattening + sorting by startChar lets a char
// map to the nearest note *in source order*, which is always the same voice.
// Memoised on the current _noteEvents array (rebuilt each render).
let _flatNotesCache = { src: null, list: [] };
function _flatNotes() {
  if (_flatNotesCache.src === _noteEvents) return _flatNotesCache.list;
  const list = [];
  for (const e of _noteEvents) {
    const ss = e.startCharArray ?? (e.startChar !== undefined ? [e.startChar] : []);
    const nn = e.endCharArray   ?? (e.endChar   !== undefined ? [e.endChar]   : []);
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      if (s == null) continue;
      list.push({ startChar: s, endChar: nn[i] ?? s + 1, ms: e.milliseconds });
    }
  }
  list.sort((a, b) => a.startChar - b.startChar || a.ms - b.ms);
  _flatNotesCache = { src: _noteEvents, list };
  return list;
}

/** Section-relative char offset → playback ms: the note spanning `char`, else
 *  the first note starting at/after it (in source order, same voice).  null when
 *  no event matches. */
function _charToMs(char) {
  const flat = _flatNotes();
  if (!flat.length) return null;
  const ev = flat.find(n => n.startChar <= char && char < n.endChar)
          ?? flat.find(n => n.startChar >= char);
  return ev ? ev.ms : null;
}

/** The ms position playback is cued to for the current selection — where ▶ would
 *  begin: a range's start, the note under a collapsed cursor (a single-note
 *  click), else the tune start. A natural end re-cues here so pressing ▶ again
 *  replays from the same spot rather than jumping back to the beginning. Reads
 *  the live selection, so moving the cursor mid-playback updates the re-cue. */
function _cueStartMs() {
  if (_selRangeMs) return _selRangeMs.startMs;
  const { from, to } = _lastEditorSel;
  if (from === to) {
    const ms = _charToMs(Math.max(0, from - _sectionOffset));
    if (ms != null) return ms;
  }
  return 0;
}

/** Map a section-relative char selection [from, to) → { startMs, endMs } in time,
 *  or null when the selection overlaps no notes.  Uses the notes the selection
 *  actually touches (interval overlap) rather than resolving the `to` char in
 *  isolation: with multiple voices the char at `to` can fall past one voice's
 *  region and into the *next* voice — whose first note sounds back at ms 0 —
 *  which would collapse the range to the whole tune.  `endMs` is the onset of
 *  the first note (any voice) that sounds strictly after the last selected note,
 *  so playback/highlight stops right after the selected span; the tune end when
 *  nothing follows. */
function _selectionMsRange(from, to) {
  const flat = _flatNotes();
  if (!flat.length) return null;
  const inSel = flat.filter(n => n.startChar < to && n.endChar > from);
  if (!inSel.length) return null;
  let startMs = Infinity, lastMs = -Infinity;
  for (const n of inSel) { if (n.ms < startMs) startMs = n.ms; if (n.ms > lastMs) lastMs = n.ms; }
  let endMs = _totalMs;
  for (const n of flat) {
    if (n.ms > lastMs + 0.5 && n.ms < endMs) endMs = n.ms;
  }
  // Distinct notes the selection spans (a chord shares one startChar). Only two or
  // more make it a *range*; selecting the chars of a single note/chord (e.g. `^d`)
  // is a single-item selection and should play from there to the end, like a
  // collapsed cursor or a preview note-click — not "play only this note".
  const count = new Set(inSel.map(n => n.startChar)).size;
  return { startMs, endMs, count };
}

/**
 * Project the current editor/preview selection onto the transport bar:
 *   • collapsed cursor → jump the scrubber to the note at the cursor.
 *   • range selection  → highlight [startMs, endMs] on the scrubber (the span
 *     that ▶ will play) and cue the position to the range start.
 * No-op while playing (don't fight the moving cursor) or off the abcjs DSL.
 * `from`/`to` are full-document offsets.
 */
function _syncTransportToSelection(from, to) {
  if (state.abcPlaying) return;
  if ((state.activeDslId ?? state.data?.dslType) !== 'abcjs') return;
  if (!_noteEvents.length) return;

  const selFrom = Math.max(0, from - _sectionOffset);
  const selTo   = Math.max(0, to   - _sectionOffset);

  const range = to > from ? _selectionMsRange(selFrom, selTo) : null;
  if (range && range.count > 1) {
    const { startMs, endMs } = range;
    _selRangeMs = { startMs, endMs };
    _pausedAtMs = startMs;
    _emitProgress(startMs);
    state.emit('abc-range', { startMs, endMs, total: _totalMs });
  } else {
    _selRangeMs = null;
    state.emit('abc-range', null);
    // Cursor or single-note/chord selection → cue to the note it lands on (so ▶
    // plays from there to the end); the start of the tune when it doesn't land on
    // a note (e.g. parked in the front matter or a header) so ▶ plays from the
    // beginning by default rather than from a stale position.
    const ms = (range ? range.startMs : _charToMs(selFrom)) ?? 0;
    _pausedAtMs = ms;
    _emitProgress(ms);
  }
  // Reflect the new (or cleared) range in the score overlay.
  _updateScoreRange();
}

function _emitProgress(ms) {
  state.abcPositionMs = ms;
  state.emit('abc-progress', { ms, total: _totalMs });
  // The score-level playback bar tracks the true scrubber position (no lead).
  // While the user is dragging the scrubber, the bar follows the drag preview
  // instead (see 'abc-seek-preview'), so don't let the progress loop fight it.
  if (!_scrubbing) _updateScoreCursor(ms);
}

function _startProgress(offsetMs) {
  _playOffsetMs  = offsetMs;
  _playWallStart = performance.now();
  _visualIdx     = -1;
  cancelAnimationFrame(_progressRaf);
  clearTimeout(_progressJog);
  const tick = () => {
    const ms = _playOffsetMs + (performance.now() - _playWallStart);
    const clamped = _totalMs ? Math.min(ms, _totalMs) : ms;
    _emitProgress(clamped);
    // Drive the note highlight a small lead ahead of the audio position.
    _applyVisualAt(clamped + VISUAL_LEAD_MS);
  };
  const raf = () => { tick(); if (state.abcPlaying) _progressRaf = requestAnimationFrame(raf); };
  // setTimeout jogger: keeps the cursor + highlight moving when rAF is throttled
  // (background tab / some mobile states), mirroring abcjs's TimingCallbacks.
  const jog = () => { if (!state.abcPlaying) return; tick(); _progressJog = setTimeout(jog, 60); };
  _progressRaf = requestAnimationFrame(raf);
  _progressJog = setTimeout(jog, 60);
}

function _stopProgress() {
  cancelAnimationFrame(_progressRaf); _progressRaf = 0;
  clearTimeout(_progressJog);         _progressJog = 0;
}

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
  // Play whenever an abcjs tune is loaded.  The cursor may be parked in the front
  // matter or a non-abcjs section (activeDslId !== 'abcjs'); that must NOT disable
  // the transport — startPlayback falls back to the beginning when nothing is cued.
  if (!_tuneObjects?.[0]) return;
  if (state.abcPlaying) {
    _pausedAtMs = _currentMs();
    stopPlayback({ keepPosition: true });
  } else if (_selRangeMs && _pausedAtMs <= _selRangeMs.startMs + 1) {
    // A range is selected and we're still cued to its start → play just the range
    // (startPlayback derives start + stop from the editor selection when no
    // explicit startMs is given).
    startPlayback();
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

  // ── 2.  Determine start seconds and optional stop ms ─────────────────────

  let startSeconds = 0;
  let stopMs       = null;

  let previewTc;
  try {
    previewTc = new abcjs.TimingCallbacks(tune, { eventCallback: () => {} });
  } catch {
    return; // tune may be malformed
  }

  const noteEvents = (previewTc.noteTimings ?? []).filter(e => e.type === 'event');

  // Char→ms mapping (via the flattened per-voice note list) is voice-aware: a
  // selection in ANY voice resolves to the right note in source order, and the
  // stop is a time bound so all voices sounding in the span play together.
  if (opts.startMs != null) {
    // Transport seek / resume: play the whole tune from an absolute position.
    startSeconds = Math.max(0, opts.startMs / 1000);
  } else if (selFrom !== selTo && selTo > selFrom) {
    // Text selection: a multi-note range starts at its first note and stops after
    // its last; a single note/chord (count <= 1) plays from there to the end with
    // no stop bound, matching a preview note-click / collapsed cursor.
    const range = _selectionMsRange(selFrom, selTo);
    if (range && range.count > 1) {
      startSeconds = range.startMs / 1000;
      stopMs = range.endMs;
    } else if (range) {
      startSeconds = range.startMs / 1000;
    } else {
      const sMs = _charToMs(selFrom);
      if (sMs != null) startSeconds = sMs / 1000;
    }
  } else if (selFrom > 0) {
    // Cursor inside document: play from the note under it to the end.
    const sMs = _charToMs(selFrom);
    if (sMs != null) startSeconds = sMs / 1000;
  }
  // else: cursor at 0 / no selection → play from beginning

  // Bound the wall-clock visual driver to the same range end as the audio.
  _visualStopMs = stopMs;

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
      eventCallback: _makeVisualEventCallback(stopMs),
    });

    _playEl?.classList.add('abc-playing');
    state.abcPlaying = true;
    state.emit('abc-play-state', { playing: true });

    const ksPlan = _buildKeyswitchPlan(tune);
    _startMidiPlayback(midiOut, noteEvents, startSeconds, stopMs, meterSize, ksPlan);
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

  // iOS: by default Web Audio is "ambient" and is silenced by the hardware mute
  // switch.  Declaring a 'playback' audio session makes it behave like a media
  // player (plays through the mute switch), matching user expectation for music.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }

  try {
    // Reuse ONE persistent AudioContext across plays (recreating per play is what
    // silenced the iOS PWA); _acquireAudioContext only rebuilds it when a prior
    // context was killed by an iOS background interruption, recovering audio that
    // would otherwise stay dead until the app is force-quit.
    _acquireAudioContext();
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
      // Muted / non-soloed voices → drop them from the synth sequence by their
      // score-order index (abcjs's `voicesOff`), so the internal piano plays only
      // the audible voices. Highlighting is filtered separately (_highlightEvent).
      const voicesOff = _mutedVoiceIndices();
      await synth.init({
        audioContext: _audioContext,
        visualObj:    tune,
        options: {
          // Omit soundFontUrl to use abcjs's default FluidR3 base — for which
          // this build serves acoustic_grand_piano from the bundle offline.
          ...(soundfontUrl ? { soundFontUrl: soundfontUrl } : {}),
          ...(voicesOff.length ? { voicesOff } : {}),
          // Only react to a NATURAL end.  Manually stopping the synth (pause /
          // seek / stop) also fires onEnded; guarding on abcPlaying stops that
          // re-entrant call from wiping the remembered pause position.
          onEnded:      () => { if (state.abcPlaying) stopPlayback(); },
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
      _synth = null;
      // Keep the persistent context; just make sure it's running for oscillators.
      try { await _audioContext.resume(); } catch { /* ignore */ }
    }
  }

  if (!_synth) {
    // ── 3b.  Web Audio oscillator path (offline, no soundfont) ───────────
    _scheduleOscillators(noteEvents, startSeconds, stopMs);
    _synth = { stop: () => {} };
  }

  // ── 4.  Timing callbacks (visual feedback only) ──────────────────────────

  _timingCallbacks = new abcjs.TimingCallbacks(tune, {
    eventCallback: _makeVisualEventCallback(stopMs),
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
  // Re-entrancy guard: stopping the synth below can synchronously fire its
  // onEnded (→ stopPlayback again) while we're still mid-teardown.  Without this
  // the nested call would run with keepPosition unset and reset _pausedAtMs to 0,
  // losing the pause position.
  if (_stopping) return;
  _stopping = true;
  try {
  try { _timingCallbacks?.stop(); } catch { /* ignore */ }
  _timingCallbacks = null;
  _stopProgress();
  _visualStopMs   = null;
  _visualIdx      = -1;

  // Silence + cancel any external MIDI routing.
  _stopMidiPlayback();

  // Stop all pre-scheduled oscillators immediately.
  for (const osc of _scheduledOscs) {
    try { osc.stop(); } catch { /* already stopped — ignore */ }
  }
  _scheduledOscs = [];

  try { _synth?.stop?.(); } catch { /* ignore */ }
  _synth = null;

  // Keep the persistent AudioContext alive (do NOT close it) — closing and
  // recreating per play is exactly what breaks audio on iOS.

  if (_playEl) {
    _playEl.querySelectorAll('.abcjs-note_playing').forEach(el =>
      el.classList.remove('abcjs-note_playing')
    );
  }
  _a2sScore?.setPlaying(null);
  _playEl?.classList.remove('abc-playing');

  state.abcPlaying = false;
  state.emit('abc-play-state', { playing: false });
  state.emit('abc-play-cursor', null);

  // Transport position: a real stop / natural end re-cues to where ▶ would begin
  // for the current selection (a range's start, a clicked note, else the tune
  // start), so finishing playback leaves it ready to replay from the same spot.
  // A pause or seek (keepPosition) leaves _pausedAtMs where the caller set it.
  if (!opts.keepPosition) {
    const resetMs = _cueStartMs();
    _pausedAtMs = resetMs;
    _emitProgress(resetMs);
  }

  // Restore range-selection highlight if the user had a text range selected.
  // For note-click selections (collapsed _lastEditorSel), abcjs's own
  // abcjs-note_selected fill survives naturally — don't call rangeHighlight(0,0)
  // which would erase it.
  if (_lastEditorSel.from !== _lastEditorSel.to) {
    const adjFrom = Math.max(0, _lastEditorSel.from - _sectionOffset);
    const adjTo   = Math.max(0, _lastEditorSel.to   - _sectionOffset);
    _rangeHighlightNow(adjFrom, adjTo);
  }
  } finally {
    _stopping = false;
  }
}

// Transport controls (emitted by the persistent abc footer).
state.on('abc-play', () => togglePlay());
state.on('abc-seek', ({ ms }) => { _scrubbing = false; seekTo(ms); });
// Live drag: move the score playback bar to the dragged position without
// committing an audio seek (that happens on release via 'abc-seek').
state.on('abc-seek-preview', ({ ms }) => { _scrubbing = true; _updateScoreCursor(ms); });

// iOS PWA audio recovery: leaving the app (backgrounding) interrupts the audio
// session; on return the AudioContext is often dead until it's rebuilt. Mark it
// interrupted while hidden so the next play recreates it inside its gesture, and
// on return best-effort resume + re-assert the 'playback' session in case it was
// only a recoverable suspend (no gesture needed for that path).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (_audioContext) _audioInterrupted = true;
      return;
    }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }
    if (_audioContext && _audioContext.state !== 'running') {
      _audioContext.resume().catch(() => { /* rebuilt on next play */ });
    }
  });
}

/**
 * For exports (no click-mapping), safely inject `T:<document title>` after the
 * `X:` line when the ABC has no explicit `T:`, so exported sheets carry the same
 * derived title the preview shows. An explicit `T:` is left untouched.
 */
function _withDerivedTitle(content) {
  if (/^\s*T:/m.test(content)) return content;
  const t = (state.title || '').trim();
  if (!t || /^untitled/i.test(t)) return content;
  const line = `T:${t}`;
  const m = content.match(/^\s*X:.*$/m);
  if (m) {
    const idx = m.index + m[0].length;
    return content.slice(0, idx) + '\n' + line + content.slice(idx);
  }
  return line + '\n' + content;
}

async function renderToString(content) {
  content = _withDerivedTitle(content);
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
  content = _withDerivedTitle(content);
  const tablature = parseTabDirectives(content);
  // abc2svg engraving for exports too (same engine as the on-screen score);
  // falls through to abcjs on failure, %%tablature docs, or the escape hatch.
  if (useAbc2svg() && !tablature) {
    const svg = abc2svgExportSvg(content);
    if (svg) return new Blob([svg], { type: 'image/svg+xml' });
  }
  const tmp = document.createElement('div');
  document.body.appendChild(tmp);
  abcjs.renderAbc(tmp, content, { ...(tablature ? { tablature } : {}) });
  const svgContent = tmp.innerHTML;
  document.body.removeChild(tmp);
  return new Blob([svgContent], { type: 'image/svg+xml' });
}

async function exportPDF(content) {
  content = _withDerivedTitle(content);
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
  const tablature = parseTabDirectives(content);
  let bodyHtml = null;

  // abc2svg engraving for print/PDF (it naturally emits one SVG per system —
  // exactly the per-system page-break structure this export needs).
  // %%tablature docs stay on abcjs (see render()).
  if (useAbc2svg() && !tablature) bodyHtml = abc2svgExportPrintBody(content);

  if (bodyHtml == null) {
    const tmp = document.createElement('div');
    tmp.style.cssText = `position:fixed;left:-9999px;top:0;width:${STAFF_W}px;visibility:hidden;`;
    document.body.appendChild(tmp);

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

    bodyHtml = tmp.innerHTML;
    document.body.removeChild(tmp);
  }

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
  // The window title becomes the browser's suggested PDF filename — use the
  // document's real title so "Save as PDF" lands as "Silence Speaks.pdf",
  // not "Sheet Music.pdf".
  const docTitle = (state.data?.title || 'Sheet Music')
    .replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const printHtml = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>${docTitle}</title>
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
// Editor intelligence — front-matter schema, autocomplete, lint, hover docs
// ---------------------------------------------------------------------------

/**
 * Declarative front-matter schema for ABC documents.  The shared engine
 * (core/fm-schema.js) turns this into completions + diagnostics; ABC owns the
 * whole thing (core doc keys + the midi.* routing tree) per the single-DSL model.
 */
const abcFrontMatterSchema = {
  title:  { type: 'string', doc: 'Document title — shown in the top bar and rendered by the layout.' },
  model:  { type: 'enum', values: ['flow', 'grid', 'spatial', 'timeline', 'graph'],
            doc: 'Document model (how the layout arranges content). `flow` is the default.' },
  layout: { type: 'enum', values: ['webpage', 'document', 'slides'],
            doc: 'Presentation of a flow document.' },
  midi: { type: 'map', doc: 'MIDI playback and external-instrument routing.', children: {
    octave:    { type: 'string', doc: 'Octave name for middle C (MIDI 60). `c3` = Kontakt (default), `c4` = scientific.' },
    'lead-ms': { type: 'number', doc: 'Milliseconds a keyswitch/CC is sent ahead of its note. Default 20.' },
    hold:      { type: 'enum', values: ['momentary', 'held'],
                 doc: 'Keyswitch notes fire momentarily or stay held until the next switch.' },
    slur:      { type: 'string', doc: 'Marking name applied across slurred notes (e.g. legato).' },
    map:         { type: 'map', freeform: true, doc: 'Marking name → MIDI action (velocity / note keyswitch / cc / program).' },
    keyswitches: { type: 'map', freeform: true, doc: 'Legacy alias for `map` (merged into it).' },
    voices: { type: 'map', freeform: true, doc: 'Per-voice overrides, keyed by voice number.', valueSchema: {
      channel:     { type: 'number', doc: 'MIDI channel for this voice (default = voice number).' },
      volume:      { type: 'number', doc: 'CC7 volume 0–127, emitted once at start.' },
      pan:         { type: 'number', doc: 'CC10 pan 0–127, emitted once at start.' },
      velocity:    { type: 'string', doc: 'Velocity scale for this voice (e.g. 0.8).' },
      map:         { type: 'map', freeform: true, doc: 'Voice-specific marking map (merged over the global map).' },
      keyswitches: { type: 'map', freeform: true, doc: 'Legacy alias for the voice map.' },
    } },
  } },
};

// ABC header fields → short docs (used by completion + hover).
const ABC_HEADER_DOCS = {
  X: 'Tune number — required, first line of each tune.',
  T: 'Title.',
  C: 'Composer.',
  O: 'Origin.',
  R: 'Rhythm (e.g. reel, jig).',
  M: 'Meter, e.g. 4/4, 6/8, or C.',
  L: 'Default note length, e.g. 1/8.',
  Q: 'Tempo, e.g. 1/4=120.',
  K: 'Key signature — required, ends the tune header. e.g. K:C, K:Gm, K:D dorian.',
  V: 'Voice, e.g. V:1 clef=treble.',
  P: 'Parts ordering.',
  I: 'Instruction / directive.',
  N: 'Notes / annotation.',
  G: 'Group.',
  H: 'History (multi-line).',
  W: 'Words (lyrics after the tune).',
  Z: 'Transcription note.',
  F: 'File URL.',
  U: 'User-defined shorthand.',
};

// Common key signatures and clefs offered after "K:".
const ABC_KEYS = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#',
  'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb',
  'Am', 'Em', 'Bm', 'F#m', 'C#m', 'Dm', 'Gm', 'Cm',
  'C dorian', 'D dorian', 'G mixolydian', 'A minor', 'none',
];
const ABC_CLEFS = ['treble', 'bass', 'alto', 'tenor', 'none', 'treble+8', 'bass-8', 'perc'];

// Standard abcjs !decoration! marks → short docs.
const ABC_DECORATIONS = {
  staccato: 'Detached, shortened note.', tenuto: 'Held for full value.',
  accent: 'Emphasised (>).', marcato: 'Strong accent (^).',
  legato: 'Smoothly connected.', trill: 'Rapid alternation with the note above.',
  turn: 'Ornament turning around the note.', fermata: 'Held / paused.',
  pppp: 'Dynamic.', ppp: 'Dynamic.', pp: 'Very soft.', p: 'Soft.',
  mp: 'Medium soft.', mf: 'Medium loud.', f: 'Loud.', ff: 'Very loud.',
  fff: 'Dynamic.', ffff: 'Dynamic.',
  'crescendo(': 'Start crescendo.', 'crescendo)': 'End crescendo.',
  'diminuendo(': 'Start diminuendo.', 'diminuendo)': 'End diminuendo.',
  upbow: 'Up-bow (strings).', downbow: 'Down-bow (strings).',
  pizzicato: 'Plucked (strings).', arco: 'Bowed (strings).',
  segno: 'Segno sign.', coda: 'Coda sign.', fine: 'End marker.',
  mordent: 'Mordent ornament.', roll: 'Irish roll.',
};

const MARKING_TOKEN_RE = /^[A-Za-z0-9()>^.+-]*$/;

/** Collect marking names offered inside `!…!` — standard decorations + user midi.map keys. */
function abcMarkingNames(docText) {
  const out = Object.entries(ABC_DECORATIONS).map(([label, info]) => ({ label, info }));
  try {
    const midi = parseGlobalFrontMatter(docText).meta?.midi;
    const collect = (m, src) => {
      if (m && typeof m === 'object')
        for (const k of Object.keys(m)) out.push({ label: k, info: `Custom marking (midi.${src})` });
    };
    if (midi && typeof midi === 'object') {
      collect(midi.map, 'map');
      collect(midi.keyswitches, 'keyswitches');
      if (midi.voices && typeof midi.voices === 'object')
        for (const v of Object.values(midi.voices)) { collect(v?.map, 'voices'); collect(v?.keyswitches, 'voices'); }
    }
  } catch { /* front matter mid-edit — ignore */ }
  const seen = new Set();
  return out.filter(o => (seen.has(o.label) ? false : seen.add(o.label)));
}

/**
 * Unified completion source (registered via languageData `autocomplete`).
 * Front-matter region → schema engine; body → ABC-specific completions.
 */
function abcComplete(context) {
  try {
    const doc = context.state.doc.toString();
    const region = getFrontMatterRange(doc);
    if (region && context.pos <= region.bodyFrom) {
      return schemaCompletions(abcFrontMatterSchema, region, context.pos, context.explicit);
    }
    return abcBodyComplete(context);
  } catch { return null; }
}

/** ABC music-body completions: decorations, key sigs/clefs after K:, header fields. */
function abcBodyComplete(context) {
  const { state: cmState } = context;
  const line = cmState.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);

  // Inside a !decoration! token → marking names (standard + midi.map keys).
  const bang = before.lastIndexOf('!');
  if (bang >= 0 && !before.slice(bang + 1).includes('!')) {
    const typed = before.slice(bang + 1);
    if (MARKING_TOKEN_RE.test(typed)) {
      return {
        from: line.from + bang + 1,
        options: abcMarkingNames(cmState.doc.toString())
          .map(n => ({ label: n.label, type: 'keyword', info: n.info, apply: `${n.label}!` })),
        validFor: MARKING_TOKEN_RE,
      };
    }
  }

  // After "K:" → key signatures and clefs.
  const km = before.match(/^\s*K:\s*(\S*)$/);
  if (km) {
    return {
      from: context.pos - km[1].length,
      options: [
        ...ABC_KEYS.map(k => ({ label: k, type: 'constant', detail: 'key' })),
        ...ABC_CLEFS.map(c => ({ label: `clef=${c}`, type: 'property', detail: 'clef' })),
      ],
      validFor: /^[\w#+=-]*$/,
    };
  }

  // Header field letters (X:, T:, K:, …) — explicit only, so it never pops up
  // while typing note letters (C, D, E…) in the music body.
  if (context.explicit && /^[A-Za-z]?$/.test(before)) {
    return {
      from: line.from,
      options: Object.entries(ABC_HEADER_DOCS)
        .map(([letter, info]) => ({ label: `${letter}:`, type: 'keyword', detail: 'header', info })),
      validFor: /^[A-Za-z]?:?$/,
    };
  }
  return null;
}

/** Build a small tooltip DOM node. */
function _hoverDom(title, body) {
  const el = document.createElement('div');
  el.className = 'cm-doc-tooltip';
  const t = document.createElement('strong');
  t.textContent = title;
  el.appendChild(t);
  if (body) { el.appendChild(document.createElement('br')); el.appendChild(document.createTextNode(body)); }
  return el;
}

/** Hover docs for header field letters and !decoration! marks. */
const abcHover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from;

  // Header field letter at the start of a line, e.g. hovering "K" in "K:C".
  const hm = line.text.match(/^([A-Za-z]):/);
  if (hm && col <= 1) {
    const info = ABC_HEADER_DOCS[hm[1].toUpperCase()];
    if (info) return { pos: line.from, end: line.from + 1, above: true,
                       create: () => ({ dom: _hoverDom(`${hm[1]}: field`, info) }) };
  }

  // A !decoration! token under the cursor.
  for (const m of line.text.matchAll(/!([^!\n]+)!/g)) {
    const s = m.index, e = s + m[0].length;
    if (col >= s && col <= e) {
      const name = m[1].trim().toLowerCase();
      const info = ABC_DECORATIONS[name];
      const custom = !info && abcMarkingNames(view.state.doc.toString()).some(x => x.label.toLowerCase() === name);
      if (info || custom) {
        return { pos: line.from + s, end: line.from + e, above: true,
                 create: () => ({ dom: _hoverDom(`!${m[1].trim()}!`, info || 'Custom marking mapped in midi.map.') }) };
      }
    }
  }
  return null;
});

/**
 * Slur/parenthesis balance in the music body — anchored at the exact offending
 * parenthesis.  Decorations (!…!), chord symbols ("…") and comments (%…) are
 * blanked out first, and tuplet markers like `(3` are not slurs.
 */
function _slurIssues(bodyFrom, body) {
  const stripped = body
    .replace(/![^!\n]*!/g, m => ' '.repeat(m.length))   // decorations
    .replace(/"[^"\n]*"/g, m => ' '.repeat(m.length))   // chord symbols
    .replace(/%.*$/gm, m => ' '.repeat(m.length))       // comments
    .replace(/\(\d/g, '  ');                            // tuplets like (3
  const open = [];
  const out = [];
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '(') open.push(i);
    else if (ch === ')') {
      if (open.length) open.pop();
      else out.push({ from: bodyFrom + i, to: bodyFrom + i + 1, severity: 'warning',
                      message: "Unmatched ')' — no opening slur." });
    }
  }
  for (const i of open)
    out.push({ from: bodyFrom + i, to: bodyFrom + i + 1, severity: 'warning',
               message: "Unclosed slur '(' — add a matching ')'." });
  return out;
}

/** midi.map markings that never appear in the score → hint diagnostics. */
function _unusedMarkings(region, body) {
  if (!region) return [];
  const base = region.innerFrom;
  const bodyLower = body.toLowerCase();
  const symbolAlias = { accent: '>', marcato: '^', staccato: '.' };
  const isMapPath = p =>
    (p.length === 2 && p[0] === 'midi' && (p[1] === 'map' || p[1] === 'keyswitches')) ||
    (p.length === 4 && p[0] === 'midi' && p[1] === 'voices' && (p[3] === 'map' || p[3] === 'keyswitches'));
  const out = [];
  for (const e of parseFmEntries(region.innerText)) {
    if (!isMapPath(e.path)) continue;
    const name = e.key.toLowerCase();
    const used = bodyLower.includes(`!${name}!`) || (symbolAlias[name] && body.includes(symbolAlias[name]));
    if (!used) out.push({
      from: base + e.keyFrom, to: base + e.keyTo, severity: 'info',
      message: `midi marking "${e.key}" is never used in the score.`,
    });
  }
  return out;
}

/**
 * Real ABC syntax diagnostics from the abcjs parser (no DOM needed).
 * abcjs.parseOnly returns tunes whose `.warnings` are strings formatted
 * "Music Line:LINE:COL: message:  <echoed source>" — this catches things a
 * hand-rolled check never would (unclosed chords/brackets, bad note lengths,
 * unexpected characters, …).  LINE/COL are relative to the parsed body.
 */
function _abcParseWarnings(view, bodyFrom, body, docLen) {
  let tunes;
  try { tunes = abcjs.parseOnly(body); } catch { return []; }
  if (!Array.isArray(tunes)) return [];

  const bodyLines = body.split('\n');
  const out = [];
  const seen = new Set();
  for (const tune of tunes) {
    for (const w of (tune.warnings || [])) {
      const m = /Music Line:(\d+):(\d+):\s*([\s\S]*)$/.exec(w);
      const lineNo = m ? parseInt(m[1], 10) : 1;
      const col    = m ? parseInt(m[2], 10) : 1;
      // Drop abcjs's trailing ":  <echoed source line>" from the message.
      const message = (m ? m[3] : w).replace(/:\s{2}.*$/, '').trim();

      const li = Math.min(Math.max(lineNo - 1, 0), bodyLines.length - 1);
      let off = 0;
      for (let i = 0; i < li; i++) off += bodyLines[i].length + 1;
      const line = view.state.doc.lineAt(Math.min(bodyFrom + off, docLen));
      const from = Math.min(line.from + Math.max(col - 1, 0), line.to);

      const key = from + '|' + message;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from, to: line.to, severity: 'warning', message: `ABC: ${message}` });
    }
  }
  return out;
}

/** Whole-document linter: front-matter schema + abcjs parser + structural checks. */
function abcLintSource(view) {
  const doc = view.state.doc.toString();
  const docLen = doc.length;
  const region = getFrontMatterRange(doc);
  const diags = [];

  // Front-matter schema diagnostics (unknown key / bad enum / bad number / dup).
  if (region) diags.push(...schemaLint(abcFrontMatterSchema, region));

  const bodyFrom = region ? region.bodyFrom : 0;
  const body = doc.slice(bodyFrom);

  if (body.trim()) {
    // Missing required headers — anchor on the first body line.
    const firstLine = view.state.doc.lineAt(Math.min(bodyFrom, docLen));
    const anchor = { from: firstLine.from, to: Math.min(firstLine.to, firstLine.from + 1) };
    if (!/^\s*X:\s*\d+/m.test(body))
      diags.push({ ...anchor, severity: 'warning', message: 'No X: (tune number) header — every ABC tune needs one.' });
    if (!/^\s*K:/m.test(body))
      diags.push({ ...anchor, severity: 'warning', message: 'No K: (key) header — abcjs needs one to render the tune.' });

    diags.push(..._slurIssues(bodyFrom, body));
    diags.push(..._abcParseWarnings(view, bodyFrom, body, docLen));
  }

  diags.push(..._unusedMarkings(region, body));

  // Clamp defensively and drop anything out of range.
  return diags
    .map(d => ({ ...d, from: Math.max(0, Math.min(d.from, docLen)), to: Math.max(0, Math.min(d.to, docLen)) }))
    .filter(d => d.from <= d.to);
}

// ---------------------------------------------------------------------------
// CodeMirror 6 editor extensions
// ---------------------------------------------------------------------------

function getEditorExtensions() {
  return [
    abcLanguage,
    // Context-aware autocomplete (front-matter schema + ABC body).
    abcLanguage.data.of({ autocomplete: abcComplete }),
    // Live diagnostics (squiggles + hover), debounced.
    linter(abcLintSource, { delay: 500 }),
    // Documentation on hover.
    abcHover,
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

  // Source formatter: pad measures with whitespace so multiple voices (and
  // successive lines) line up vertically. Surfaced via the editor's align
  // command (Alt-Shift-F) and the mobile align button.
  alignLabel: 'Align voices',
  alignSource: alignAbcVoices,

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
   * Extensions modal.  Each slot is a user-configurable input that
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
