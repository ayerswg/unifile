/**
 * Central application state and event bus.
 *
 * Components subscribe to state changes via state.on(event, handler).
 * Mutations go through state.update() which broadcasts to subscribers.
 */

import { shortHash } from '../core/hash.js';

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

class EventBus {
  constructor() {
    this._listeners = {};
  }

  on(event, handler) {
    (this._listeners[event] ??= []).push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(h => h !== handler);
    }
  }

  emit(event, payload) {
    (this._listeners[event] ?? []).forEach(h => h(payload));
    (this._listeners['*'] ?? []).forEach(h => h(event, payload));
  }
}

// ---------------------------------------------------------------------------
// View modes
// ---------------------------------------------------------------------------

export const VIEW_MODES = {
  EDITOR: 'editor',
  PREVIEW: 'preview',
  SPLIT: 'split'
};

// Panel types (secondary panels overlaid on the main view)
export const PANELS = {
  NONE: null,
  HISTORY: 'history',
  BLAME: 'blame',
  MERGE: 'merge',
  EXPORT: 'export',
  COMMIT: 'commit',
  COMMENTS: 'comments',
  SETTINGS: 'settings'
};

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

class AppState extends EventBus {
  constructor() {
    super();

    /** @type {object} Full unifile data (mutable, serialised on save) */
    this.data = null;

    /** @type {import('../core/vcs.js').VCS} */
    this.vcs = null;

    /** @type {string} Current editor content (may differ from committed) */
    this.currentContent = '';

    /** @type {boolean} Whether currentContent differs from head commit */
    this.isDirty = false;

    /** @type {string} Active view mode */
    this.viewMode = VIEW_MODES.SPLIT;

    /** @type {string|null} Active secondary panel */
    this.activePanel = PANELS.NONE;

    /** @type {{ name: string, email: string }} Cached user identity */
    this.user = { name: '', email: '' };

    /** @type {{ content: string, fromHash: string }|null} Single-slot auto-stash */
    this.stash = null;

    /** @type {{ left: string, right: string }|null} Active diff view (hash | 'WORKING') */
    this.diff = null;

    /** @type {{ message: string, tag?: string }|null} Draft carried into the commit dialog */
    this.pendingCommit = null;

    /** @type {FileSystemFileHandle|null} PWA file handle */
    this.fileHandle = null;

    /** @type {string|null} PWA document ID for IDB */
    this.docId = null;

    /** @type {boolean} Whether the DSL libs are ready */
    this.dslReady = false;

    /** @type {object|null} DSL plugin reference */
    this.dsl = null;

    /** @type {boolean} Whether ABC audio is currently playing */
    this.abcPlaying = false;

    /** @type {boolean} Whether a valid ABC tune is loaded and ready to play */
    this.abcHasTune = false;

    /** @type {boolean} Whether a note in the ABC preview is currently selected (red highlight) */
    this.abcNoteSelected = false;

    /** @type {Array<{id:string,name:string}>} Available Web MIDI output ports */
    this.abcMidiOutputs = [];

    /** @type {string|null} Selected MIDI output port id; null → internal piano synth */
    this.abcMidiOutId = null;

    /** @type {boolean} Whether the Web MIDI API is available in this browser */
    this.abcMidiSupported = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;

    /** @type {Set<string>} ABC voice ids explicitly muted (won't play/highlight) */
    this.abcMutedVoices = new Set();

    /** @type {Set<string>} ABC voice ids soloed — when non-empty, only these play */
    this.abcSoloVoices = new Set();

    /** @type {string|null} DSL id at current cursor position; null → use data.dslType */
    this.activeDslId = null;

    /** @type {{ from: number, to: number }|null} Active section content range; null → whole doc */
    this.activeSectionRange = null;

    /** @type {string} Primary model ID (from front matter 'model' key, defaults to 'flow') */
    this.primaryModel = 'flow';

    /** @type {string|null} Secondary model ID (from front matter 'model2' key) */
    this.secondaryModel = null;
  }

  // -------------------------------------------------------------------------
  // Derived properties
  // -------------------------------------------------------------------------

  get headHash() {
    return this.vcs?.headHash ?? null;
  }

  get shortHeadHash() {
    return shortHash(this.headHash);
  }

  get dirtyIndicator() {
    return this.isDirty ? '*' : '';
  }

  get isDetached() {
    return this.vcs?.isDetached ?? false;
  }

  get title() {
    return this.data?.title ?? 'Untitled';
  }

  get currentBranch() {
    return this.vcs?.currentBranch ?? 'main';
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Bulk-update state fields and emit events.
   * @param {object} patch
   * @param {string[]} [events] – additional events to emit
   */
  update(patch, events = []) {
    Object.assign(this, patch);
    this.emit('change', this);
    events.forEach(e => this.emit(e, this));
  }

  setContent(content, { cursorPos } = {}) {
    const wasEmpty = this.currentContent === '';
    this.currentContent = content;
    const headContent = this.vcs?.headContent ?? '';
    this.isDirty = content !== headContent;
    this.emit('content-change', { content, isDirty: this.isDirty, cursorPos });
    if (wasEmpty !== (content === '')) this.emit('change', this);
  }

  setViewMode(mode) {
    if (!Object.values(VIEW_MODES).includes(mode)) return;
    this.viewMode = mode;
    this.emit('view-mode-change', mode);
    this.emit('change', this);
  }

  openPanel(panel) {
    this.activePanel = panel;
    this.emit('panel-change', panel);
    this.emit('change', this);
  }

  closePanel() {
    this.activePanel = PANELS.NONE;
    this.emit('panel-change', PANELS.NONE);
    this.emit('change', this);
  }

  /**
   * Enter the read-only commit-diff view comparing two sides. Each side is a
   * commit hash or the sentinel 'WORKING' (the live editor content).
   */
  openDiff(left, right) {
    this.diff = { left, right };
    this.emit('diff-change', this.diff);
  }

  /** Exit the diff view, back to the working editor. */
  closeDiff() {
    if (!this.diff) return;
    this.diff = null;
    this.emit('diff-change', null);
  }

  // -------------------------------------------------------------------------
  // ABC voice mute / solo
  //
  // Muting silences a voice for the whole song (no sound, no play highlight,
  // faded in the editor + score). Solo is the inverse: when any voice is soloed
  // only the soloed voices play — every other voice is effectively muted.
  // Keyed by voice id (see core/abc-voices.js) so they apply across every
  // `V:` line of that voice.
  // -------------------------------------------------------------------------

  /** Whether a voice is effectively silenced (explicit mute, or solo elsewhere). */
  isVoiceMuted(id) {
    if (id == null) return false;
    if (this.abcMutedVoices.has(id)) return true;
    if (this.abcSoloVoices.size > 0 && !this.abcSoloVoices.has(id)) return true;
    return false;
  }

  toggleVoiceMute(id) {
    if (id == null) return;
    if (this.abcMutedVoices.has(id)) this.abcMutedVoices.delete(id);
    else this.abcMutedVoices.add(id);
    this.emit('abc-voices-change', this);
  }

  toggleVoiceSolo(id) {
    if (id == null) return;
    // Solo is exclusive: soloing a voice replaces any previous solo; toggling
    // the currently soloed voice clears it.
    const wasSolo = this.abcSoloVoices.has(id);
    this.abcSoloVoices.clear();
    if (!wasSolo) this.abcSoloVoices.add(id);
    this.emit('abc-voices-change', this);
  }

  /** Clear all mute/solo selections (e.g. when loading a different document). */
  clearVoiceSelections() {
    if (this.abcMutedVoices.size === 0 && this.abcSoloVoices.size === 0) return;
    this.abcMutedVoices.clear();
    this.abcSoloVoices.clear();
    this.emit('abc-voices-change', this);
  }
}

export const state = new AppState();
