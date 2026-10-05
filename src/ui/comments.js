/**
 * Inline comments — range-anchored, the way a word processor does them.
 *
 * Data model:  data.commentThreads = { [threadId]: Thread }
 *
 * Thread = {
 *   id: string,
 *   from: number,          // char offset, inclusive
 *   to: number,            // char offset, exclusive (from === to: a point — the
 *                          //   pre-v0.5 line comments; shown as a small marker)
 *   createdAtHash: string,
 *   archived: boolean,     // "resolved" in the UI
 *   orphaned: boolean,
 *   messages: Message[]
 * }
 *
 * Message = { id, author, text, timestamp }
 *
 * How it looks and works (editor.js wires the gestures):
 *   • Every open thread's text carries a persistent soft highlight
 *     (`.cm-comment-range`, `commentHighlightField`) — comments are visible in
 *     the text itself, there is no gutter and no line-level anchor.
 *   • Select text → right-click / long-press (or the phone bubble's Comment,
 *     or Mod-Alt-M) → "Comment" → a CARD opens attached to the selection
 *     (`commentCardField`, a CodeMirror tooltip below the range, flipping above
 *     when there is no room; it rides along with the text while scrolling).
 *     The card holds the composer; once posted it shows the thread with a
 *     reply box and Resolve.
 *   • Click / tap a highlight → its card.  Esc, clicking elsewhere in the
 *     text, or editing the document closes the card.
 *   • Thread offsets are mapped through every document change
 *     (`mapThreadPositions`, called from editor.js's updateListener); a thread
 *     whose text is deleted entirely is resolved automatically.
 */

import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, showTooltip } from '@codemirror/view';

import { state } from './state.js';
import { loadUserPrefs } from '../core/storage.js';
import { shortHash } from '../core/hash.js';

// ---------------------------------------------------------------------------
// StateEffects
// ---------------------------------------------------------------------------

/**
 * openCommentEffect.of({ threadId }) — open an existing thread's card, or
 * openCommentEffect.of({ range: { from, to } }) — open the composer for a new
 * thread on that range.
 */
export const openCommentEffect = StateEffect.define();

/** Close the card unconditionally. */
export const closeCommentEffect = StateEffect.define();

/** Thread data changed (new / reply / resolve / positions mapped) — rebuild. */
export const refreshCommentsEffect = StateEffect.define();

// Bumped on every thread mutation so the card and highlights rebuild.
let _threadDataVersion = 0;
export function bumpThreadVersion() { _threadDataVersion++; }

// ---------------------------------------------------------------------------
// Public data helpers
// ---------------------------------------------------------------------------

function _threads() { return state.data?.commentThreads ?? {}; }

/** All open (non-resolved) threads, in document order. */
export function listOpenThreads() {
  return Object.values(_threads())
    .filter(t => !t.archived && t.from !== undefined)
    .sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Open threads whose range contains `pos` (a point thread matches its own offset). */
export function getThreadsForPos(pos) {
  return listOpenThreads().filter(t =>
    t.from === t.to ? t.from === pos : (t.from <= pos && t.to > pos)
  );
}

/** Open threads overlapping [from, to) — used to find a thread under a selection. */
export function getThreadsInRange(from, to) {
  return listOpenThreads().filter(t => t.from < to && t.to > from || (t.from === t.to && t.from >= from && t.from <= to));
}

// ---------------------------------------------------------------------------
// Thread mutations
// ---------------------------------------------------------------------------

function _author() { return loadUserPrefs().name || state.user?.name || 'Anonymous'; }
function _id(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function _commit() {
  state.update({ data: state.data, isDirty: true });
  bumpThreadVersion();
  state.emit('comments-change');
}

export function startThread(from, to, text) {
  const threadId = _id('t');
  const thread = {
    id: threadId,
    from,
    to,
    createdAtHash: state.headHash,
    archived: false,
    orphaned: false,
    messages: [{ id: _id('m'), author: _author(), text, timestamp: Date.now() }]
  };
  const data = state.data;
  data.commentThreads ??= {};
  data.commentThreads[threadId] = thread;
  _commit();
  return threadId;
}

export function replyToThread(threadId, text) {
  const t = state.data?.commentThreads?.[threadId];
  if (!t) return;
  t.messages.push({ id: _id('m'), author: _author(), text, timestamp: Date.now() });
  _commit();
}

/** Resolve (archive) a thread — it leaves the text and lands in Resolved comments. */
export function archiveThread(threadId) {
  const t = state.data?.commentThreads?.[threadId];
  if (!t) return;
  t.archived = true;
  _commit();
}

// ---------------------------------------------------------------------------
// Position mapping (called from editor.js's updateListener on docChanged)
// ---------------------------------------------------------------------------

export function mapThreadPositions(changes) {
  const threads = state.data?.commentThreads;
  if (!threads) return false;

  // A change that replaces EXACTLY a thread's text with new text (autocorrect,
  // an accepted completion) re-anchors the thread onto the replacement instead
  // of collapsing it — plain mapping would resolve it as "deleted".
  const replaced = new Map();
  changes.iterChanges((fromA, toA, fromB, toB) => { if (toA > fromA && toB > fromB) replaced.set(`${fromA}:${toA}`, { from: fromB, to: toB }); });

  let resolved = false, moved = false;
  for (const t of Object.values(threads)) {
    if (t.from === undefined || t.archived) continue;
    const whole = t.from < t.to ? replaced.get(`${t.from}:${t.to}`) : null;
    const newFrom = whole ? whole.from : changes.mapPos(t.from, 1);
    const newTo   = whole ? whole.to : Math.max(newFrom, changes.mapPos(t.to, -1));

    if (t.from < t.to && newFrom >= newTo) {
      // The commented text was deleted entirely — the thread resolves itself.
      t.archived = true;
      t.from = newFrom;
      t.to   = newFrom;
      resolved = true;
    } else if (newFrom !== t.from || newTo !== t.to) {
      t.from = newFrom;
      t.to   = newTo;
      moved = true;
    }
  }
  if (resolved) {
    bumpThreadVersion();
    // Persist the auto-resolve with the next save / commit.
    state.update({ data: state.data, isDirty: true });
  }
  return resolved || moved;
}

/**
 * The whole document was swapped (checkout / branch switch / open): the
 * threads keep their offsets (mapping a full replacement would resolve every
 * one of them), clamped to the new length.
 */
export function clampThreadPositions(docLen) {
  for (const t of Object.values(state.data?.commentThreads ?? {})) {
    if (t.from === undefined) continue;
    t.from = Math.min(t.from, docLen);
    t.to   = Math.min(Math.max(t.to, t.from), docLen);
  }
  bumpThreadVersion();
}

// ---------------------------------------------------------------------------
// Migration: lineNum-based → {from, to} offsets (pre-v0.0.6 data)
// ---------------------------------------------------------------------------

export function migrateCommentThreads(doc) {
  const threads = state.data?.commentThreads;
  if (!threads) return;

  let changed = false;
  for (const t of Object.values(threads)) {
    if (t.lineNum !== undefined && t.from === undefined) {
      const lineNum = Math.max(1, Math.min(t.lineNum, doc.lines));
      const line    = doc.line(lineNum);
      t.from    = line.from;
      t.to      = line.from; // point
      t.orphaned = false;
      delete t.lineNum;
      changed = true;
    }
  }
  if (changed) bumpThreadVersion();
}

// ---------------------------------------------------------------------------
// The card — a CodeMirror tooltip anchored to the thread's text
// ---------------------------------------------------------------------------

const _closedCard = () => ({ threadId: null, range: null, version: -1, tooltip: null });

/**
 * One stable `create` function: CodeMirror matches tooltips by it, so a new
 * tooltip object (different thread, bumped version) REUSES the card's DOM and
 * calls its `update()` instead of rebuilding — the composer keeps its focus
 * while typing, and a reply re-renders in place.
 */
function _createCard(view) { return new CommentCard(view); }

export const commentCardField = StateField.define({
  create: _closedCard,

  update(value, tr) {
    let { threadId, range } = value;
    let changed = false;

    if (tr.docChanged) {
      // Editing the text closes the card (its anchor may no longer mean the same thing).
      if (threadId !== null || range) { threadId = null; range = null; changed = true; }
    }
    for (const e of tr.effects) {
      if (e.is(openCommentEffect)) {
        threadId = e.value.threadId ?? null;
        range    = e.value.range ?? null;
        changed = true;
      } else if (e.is(closeCommentEffect)) {
        if (threadId !== null || range) changed = true;
        threadId = null; range = null;
      } else if (e.is(refreshCommentsEffect)) {
        changed = true;
      }
    }
    if (!changed && value.version === _threadDataVersion) return value;

    // Resolve the anchor: an existing thread's current range, or the pending one.
    let anchor = range;
    if (threadId !== null) {
      const t = state.data?.commentThreads?.[threadId];
      if (!t || t.archived) return _closedCard();
      anchor = { from: t.from, to: t.to };
    }
    if (!anchor) return _closedCard();

    const docLen = tr.state.doc.length;
    const from = Math.min(anchor.from, docLen);
    const to   = Math.min(Math.max(anchor.to, from), docLen);
    return {
      threadId, range: { from, to }, version: _threadDataVersion,
      tooltip: { pos: from, end: to, above: false, strictSide: false, arrow: false, create: _createCard }
    };
  },

  provide: f => showTooltip.from(f, v => v.tooltip)
});

class CommentCard {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'uf-comment-card';
    this.dom.setAttribute('role', 'dialog');
    this.dom.setAttribute('aria-label', 'Comment');
    // Clicks inside the card must not reach the editor's "click elsewhere
    // closes the card" handler, nor move the caret.
    for (const ev of ['mousedown', 'pointerdown', 'touchstart', 'click']) {
      this.dom.addEventListener(ev, (e) => e.stopPropagation(), { passive: ev === 'touchstart' });
    }
    this.dom.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this._close(); }
    });
    this._key = null;
    this._render();
  }

  // Only the composer takes focus by itself — opening an existing thread by
  // tapping its highlight must not pop the phone keyboard.
  mount() { if (this.view.state.field(commentCardField, false)?.threadId === null) this._focusInput(); }

  update() {
    const v = this.view.state.field(commentCardField, false);
    if (!v) return;
    const key = `${v.threadId}|${v.range?.from}|${v.range?.to}|${v.version}`;
    if (key === this._key) return;
    const wasThread = this._key?.split('|')[0];
    this._render();
    // Switched to the composer for a new range: focus it.
    if (v.threadId === null && wasThread !== 'null') this._focusInput();
  }

  _close() {
    this.view.dispatch({ effects: closeCommentEffect.of(null) });
    this.view.focus();
  }

  _focusInput() {
    requestAnimationFrame(() => this.dom.querySelector('textarea')?.focus());
  }

  _render() {
    const v = this.view.state.field(commentCardField, false);
    if (!v || !v.range) return;
    this._key = `${v.threadId}|${v.range.from}|${v.range.to}|${v.version}`;
    const thread = v.threadId !== null ? state.data?.commentThreads?.[v.threadId] : null;
    const excerpt = _excerpt(this.view.state.doc, v.range);
    this.dom.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'ucc-head';
    head.innerHTML = `
      <span class="ucc-excerpt" title="The commented text">${excerpt ? `“${escHtml(excerpt)}”` : '<em>this line</em>'}</span>
      <button class="ucc-close" type="button" aria-label="Close">×</button>`;
    head.querySelector('.ucc-close').addEventListener('click', () => this._close());
    this.dom.appendChild(head);

    if (!thread) this._renderComposer(v.range);
    else this._renderThread(thread);
  }

  _renderComposer(range) {
    const body = document.createElement('div');
    body.className = 'ucc-body';
    body.innerHTML = `
      <textarea class="ucc-input" rows="2" placeholder="Comment…" aria-label="Comment"></textarea>
      <div class="ucc-actions">
        <span class="ucc-hint">⌘↩ to post</span>
        <button class="ucc-btn ucc-cancel" type="button">Cancel</button>
        <button class="ucc-btn ucc-primary ucc-post" type="button">Comment</button>
      </div>`;
    const ta = body.querySelector('.ucc-input');
    _autoGrow(ta);
    const post = () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      const id = startThread(range.from, range.to, text);
      this.view.dispatch({ effects: openCommentEffect.of({ threadId: id }) });
    };
    body.querySelector('.ucc-post').addEventListener('click', post);
    body.querySelector('.ucc-cancel').addEventListener('click', () => this._close());
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); post(); }
    });
    this.dom.appendChild(body);
  }

  _renderThread(thread) {
    const body = document.createElement('div');
    body.className = 'ucc-body';

    const list = document.createElement('div');
    list.className = 'ucc-messages';
    for (const m of thread.messages) {
      const row = document.createElement('div');
      row.className = 'ucc-msg';
      row.innerHTML = `
        <div class="ucc-msg-meta"><span class="ucc-author">${escHtml(m.author)}</span><span class="ucc-when">${formatRelative(m.timestamp)}</span></div>
        <div class="ucc-text">${escHtml(m.text)}</div>`;
      list.appendChild(row);
    }
    body.appendChild(list);

    const reply = document.createElement('div');
    reply.className = 'ucc-reply';
    reply.innerHTML = `
      <textarea class="ucc-input" rows="1" placeholder="Reply…" aria-label="Reply"></textarea>
      <div class="ucc-actions">
        <button class="ucc-btn ucc-resolve" type="button" title="Resolve — hides the highlight; the thread stays under Resolved comments">Resolve</button>
        <button class="ucc-btn ucc-primary ucc-send" type="button">Reply</button>
      </div>`;
    const ta = reply.querySelector('.ucc-input');
    _autoGrow(ta);
    const send = () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      replyToThread(thread.id, text);
      this.view.dispatch({ effects: refreshCommentsEffect.of(null) });
    };
    reply.querySelector('.ucc-send').addEventListener('click', send);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    });
    reply.querySelector('.ucc-resolve').addEventListener('click', () => {
      archiveThread(thread.id);
      this._close();
    });
    body.appendChild(reply);
    this.dom.appendChild(body);
  }
}

/** A one-line excerpt of the commented text (first 60 chars of its first line). */
function _excerpt(doc, range) {
  if (range.from >= range.to) return '';
  const text = doc.sliceString(range.from, Math.min(range.to, range.from + 200)).split('\n')[0].trim();
  if (!text) return '';
  const more = range.to - range.from > text.length || text.length > 60;
  return text.slice(0, 60) + (more ? '…' : '');
}

// ---------------------------------------------------------------------------
// Persistent highlights — every open thread's text
// ---------------------------------------------------------------------------

class PointMarker extends WidgetType {
  constructor(threadId) { super(); this.threadId = threadId; }
  eq(o) { return o.threadId === this.threadId; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-comment-point';
    el.textContent = '❝';
    el.title = 'Comment';
    el.dataset.thread = this.threadId;
    return el;
  }
  ignoreEvent() { return false; }
}

function _buildHighlights(editorState) {
  const docLen = editorState.doc.length;
  const active = editorState.field(commentCardField, false)?.threadId ?? null;
  const decos = [];
  for (const t of listOpenThreads()) {
    const from = Math.min(t.from, docLen), to = Math.min(t.to, docLen);
    if (from < to) {
      decos.push(Decoration.mark({
        class: 'cm-comment-range' + (t.id === active ? ' cm-comment-range-active' : ''),
        attributes: { 'data-thread': t.id }
      }).range(from, to));
    } else {
      decos.push(Decoration.widget({ widget: new PointMarker(t.id), side: -1 }).range(from));
    }
  }
  return decos.length ? Decoration.set(decos, true) : Decoration.none;
}

export const commentHighlightField = StateField.define({
  create: (s) => _buildHighlights(s),
  update(deco, tr) {
    // Any card open/close changes which range is "active"; a refresh means the
    // thread data moved under us; a doc change is mapped here and rebuilt by
    // the refresh editor.js dispatches once the thread offsets are mapped.
    if (tr.effects.some(e => e.is(openCommentEffect) || e.is(closeCommentEffect) || e.is(refreshCommentsEffect))) {
      return _buildHighlights(tr.state);
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: f => EditorView.decorations.from(f)
});

/** The full comments extension set for the editor. */
export const commentsExtension = [commentCardField, commentHighlightField];

// ---------------------------------------------------------------------------
// Resolved comments modal
// ---------------------------------------------------------------------------

export function showArchivedCommentsModal() {
  const list = Object.values(_threads()).filter(t => t.archived);

  const overlay = document.createElement('div');
  overlay.className = 'ath-overlay';

  overlay.innerHTML = `
    <div class="ath-modal" role="dialog" aria-modal="true" aria-label="Resolved comments">
      <div class="ath-header">
        <h3 class="ath-title">Resolved comments</h3>
        <button class="ath-close" aria-label="Close">&times;</button>
      </div>
      <div class="ath-body">
        ${list.length === 0
          ? '<p class="ath-empty">No resolved comments.</p>'
          : list.map(t => `
            <div class="ath-thread">
              <div class="ath-thread-info">
                <div class="ath-thread-meta">
                  ${shortHash(t.createdAtHash)} &middot;
                  ${t.messages.length} message${t.messages.length !== 1 ? 's' : ''}
                </div>
                ${t.messages.map(m => `
                  <div class="ath-msg">
                    <span class="ath-author">${escHtml(m.author)}</span>
                    <span class="ath-date">${formatRelative(m.timestamp)}</span>
                    <p class="ath-text">${escHtml(m.text)}</p>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')
        }
      </div>
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  overlay.querySelector('.ath-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a textarea grow to fit its content. */
function _autoGrow(ta) {
  const resize = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', resize);
  requestAnimationFrame(resize);
}

export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
