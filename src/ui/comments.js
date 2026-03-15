/**
 * Range-anchored comments system
 *
 * Data model:  data.commentThreads = { [threadId]: Thread }
 *
 * Thread = {
 *   id: string,
 *   from: number,          // char offset, inclusive
 *   to: number,            // char offset, exclusive
 *   createdAtHash: string,
 *   archived: boolean,
 *   orphaned: boolean,     // range collapsed to a point after position mapping
 *   messages: Message[]
 * }
 *
 * Message = { id, author, text, timestamp }
 *
 * The accordion widget is a CM6 block decoration rendered below the anchor
 * line.  Thread char-offset positions are mapped through document changes
 * inside editor.js's updateListener (see mapThreadPositions).
 */

import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';

import { state } from './state.js';
import { loadUserPrefs, saveUserPrefs } from '../core/storage.js';
import { shortHash } from '../core/hash.js';

// ---------------------------------------------------------------------------
// StateEffects
// ---------------------------------------------------------------------------

/**
 * openAccordionEffect.of({ anchorPos, threadId, newRange })
 *   anchorPos : line.to position where the widget will be placed
 *   threadId  : existing thread to activate, or null → show new-thread form
 *   newRange  : { from, to } | null — proposed char range for the new thread
 */
export const openAccordionEffect   = StateEffect.define();

/** Close the accordion unconditionally. */
export const closeAccordionEffect  = StateEffect.define();

/** Switch to a different thread without closing. Value: threadId string. */
export const setActiveThreadEffect = StateEffect.define();

// ---------------------------------------------------------------------------
// Version counter
// Bumped on every thread mutation so the gutter re-renders and the accordion
// widget rebuilds.
// ---------------------------------------------------------------------------

let _threadDataVersion = 0;
export function bumpThreadVersion() { _threadDataVersion++; }

// ---------------------------------------------------------------------------
// Public data helpers
// ---------------------------------------------------------------------------

/**
 * Returns all active (non-archived) threads whose `from` offset falls on
 * the same line as `pos` in the given CM6 document.
 */
export function getThreadsForLine(pos, doc) {
  const threads = state.data?.commentThreads ?? {};
  const line = doc.lineAt(pos);
  return Object.values(threads).filter(t =>
    !t.archived &&
    t.from !== undefined &&
    t.from >= line.from &&
    t.from <= line.to
  );
}

/**
 * Returns all active threads whose range strictly contains `pos`.
 */
export function getThreadsForPos(pos) {
  const threads = state.data?.commentThreads ?? {};
  return Object.values(threads).filter(t =>
    !t.archived &&
    t.from !== undefined &&
    t.from <= pos && t.to > pos
  );
}

// ---------------------------------------------------------------------------
// Thread mutations
// ---------------------------------------------------------------------------

export function startThread(from, to, text) {
  const author   = loadUserPrefs().name || state.user?.name || 'Anonymous';
  const threadId = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const msgId    = `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const thread = {
    id: threadId,
    from,
    to,
    createdAtHash: state.headHash,
    archived: false,
    orphaned: false,
    messages: [{ id: msgId, author, text, timestamp: Date.now() }]
  };

  const data = state.data;
  data.commentThreads ??= {};
  data.commentThreads[threadId] = thread;
  state.update({ data, isDirty: true });
  bumpThreadVersion();
  return threadId;
}

export function replyToThread(threadId, text) {
  const author = loadUserPrefs().name || state.user?.name || 'Anonymous';
  const msgId  = `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const data = state.data;
  data.commentThreads ??= {};
  if (data.commentThreads[threadId]) {
    data.commentThreads[threadId].messages.push({
      id: msgId, author, text, timestamp: Date.now()
    });
  }
  state.update({ data, isDirty: true });
  bumpThreadVersion();
}

export function archiveThread(threadId) {
  const data = state.data;
  if (data.commentThreads?.[threadId]) {
    data.commentThreads[threadId].archived = true;
  }
  state.update({ data, isDirty: true });
  bumpThreadVersion();
}

// ---------------------------------------------------------------------------
// Migration: lineNum-based → {from, to} offsets
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
      t.to      = line.from; // point range
      t.orphaned = false;
      delete t.lineNum;
      changed = true;
    }
  }
  if (changed) bumpThreadVersion();
}

// ---------------------------------------------------------------------------
// Archived comments modal
// ---------------------------------------------------------------------------

export function showArchivedCommentsModal() {
  const list = Object.values(state.data?.commentThreads ?? {}).filter(t => t.archived);

  const overlay = document.createElement('div');
  overlay.className = 'ath-overlay';

  overlay.innerHTML = `
    <div class="ath-modal" role="dialog" aria-modal="true" aria-label="Archived comments">
      <div class="ath-header">
        <h3 class="ath-title">Archived comments</h3>
        <button class="ath-close" aria-label="Close">&times;</button>
      </div>
      <div class="ath-body">
        ${list.length === 0
          ? '<p class="ath-empty">No archived comments.</p>'
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
// AccordionWidget — inline block widget
// ---------------------------------------------------------------------------

class AccordionWidget extends WidgetType {
  constructor({ anchorPos, activeThreadId, threads, pendingRange, threadDataVersion }) {
    super();
    this.anchorPos         = anchorPos;
    this.activeThreadId    = activeThreadId;
    this.threads           = threads;
    this.pendingRange      = pendingRange;
    this.threadDataVersion = threadDataVersion;
  }

  eq(other) {
    return (
      this.anchorPos          === other.anchorPos          &&
      this.activeThreadId     === other.activeThreadId     &&
      this.threadDataVersion  === other.threadDataVersion  &&
      this.pendingRange?.from === other.pendingRange?.from &&
      this.pendingRange?.to   === other.pendingRange?.to
    );
  }

  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'cm-accordion';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Comment thread');
    this._render(el, view);
    return el;
  }

  _render(el, view) {
    el.innerHTML = '';

    // Prevent mousedown inside the accordion from closing it
    el.addEventListener('mousedown', (e) => e.stopPropagation());

    const body = document.createElement('div');
    body.className = 'cm-accordion-body';

    if (this.activeThreadId === null) {
      this._renderNewForm(body, view);
    } else {
      const thread = this.threads.find(t => t.id === this.activeThreadId);
      if (thread) {
        this._renderThread(body, thread, view);
      }
    }

    el.appendChild(body);
  }

  _renderNewForm(body, view) {
    body.innerHTML = `
      <textarea class="form-input form-textarea ct-acc-body"
        placeholder="Write a comment… (Ctrl+Enter to submit)" rows="2"></textarea>
      <div class="ct-actions">
        <button class="btn btn-sm ct-acc-cancel">Cancel</button>
        <button class="btn btn-primary btn-sm ct-acc-submit">Add comment</button>
      </div>
      <p class="form-error ct-acc-error" hidden></p>
    `;

    const bodyEl  = body.querySelector('.ct-acc-body');
    const errorEl = body.querySelector('.ct-acc-error');

    _autoGrow(bodyEl);

    const submit = () => {
      const text = bodyEl?.value.trim();
      if (!text) { _showError(errorEl, 'Comment text is required.'); return; }
      errorEl.hidden = true;

      const range    = this.pendingRange ?? { from: this.anchorPos, to: this.anchorPos };
      const threadId = startThread(range.from, range.to, text);
      view.dispatch({ effects: setActiveThreadEffect.of(threadId) });
    };

    body.querySelector('.ct-acc-submit').addEventListener('click', submit);
    bodyEl?.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
    });
    body.querySelector('.ct-acc-cancel').addEventListener('click', () => {
      view.dispatch({ effects: closeAccordionEffect.of(null) });
    });

    setTimeout(() => bodyEl?.focus(), 0);
  }

  _renderThread(body, thread, view) {
    // Messages — compact inline format
    const msgsEl = document.createElement('div');
    msgsEl.className = 'ct-messages';
    for (const msg of thread.messages) {
      const row = document.createElement('div');
      row.className = 'ct-message';
      row.innerHTML = `
        <span class="ct-msg-who"><span class="ct-msg-author">${escHtml(msg.author)}</span><span class="ct-msg-date">${formatRelative(msg.timestamp)}</span></span>
        <span class="ct-msg-body">${escHtml(msg.text)}</span>
      `;
      msgsEl.appendChild(row);
    }
    body.appendChild(msgsEl);

    // Reply + archive row
    const replyEl = document.createElement('div');
    replyEl.className = 'ct-reply-form';
    replyEl.innerHTML = `
      <textarea class="form-input form-textarea ct-reply-body"
        placeholder="Reply… (Ctrl+Enter)" rows="1"></textarea>
      <div class="ct-reply-actions">
        <button class="ct-archive-btn">Archive</button>
        <button class="btn btn-sm ct-reply-submit">Reply</button>
      </div>
    `;

    const textarea = replyEl.querySelector('.ct-reply-body');
    _autoGrow(textarea);
    const sendReply = () => {
      const text = textarea?.value.trim();
      if (!text) return;
      replyToThread(thread.id, text);
      view.dispatch({ effects: setActiveThreadEffect.of(thread.id) });
    };

    replyEl.querySelector('.ct-reply-submit').addEventListener('click', sendReply);
    textarea?.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendReply();
    });
    replyEl.querySelector('.ct-archive-btn').addEventListener('click', () => {
      archiveThread(thread.id);
      view.dispatch({ effects: closeAccordionEffect.of(null) });
    });

    body.appendChild(replyEl);
  }
}

// ---------------------------------------------------------------------------
// accordionField — CM6 StateField
// ---------------------------------------------------------------------------

const _emptyAccordion = () => ({
  anchorPos:      null,
  activeThreadId: null,
  pendingRange:   null,
  decorations:    Decoration.none
});

export const accordionField = StateField.define({
  create: _emptyAccordion,

  update(value, tr) {
    let { anchorPos, activeThreadId, pendingRange } = value;

    // ── Process effects ──────────────────────────────────────────────────────
    for (const e of tr.effects) {
      if (e.is(openAccordionEffect)) {
        anchorPos      = e.value.anchorPos;
        activeThreadId = e.value.threadId  ?? null;
        pendingRange   = e.value.newRange  ?? null;
      } else if (e.is(closeAccordionEffect)) {
        anchorPos = null; activeThreadId = null; pendingRange = null;
      } else if (e.is(setActiveThreadEffect)) {
        activeThreadId = e.value;
        pendingRange   = null;
      }
    }

    // ── Auto-close on document edits ─────────────────────────────────────────
    if (anchorPos !== null && tr.docChanged) {
      anchorPos = null; activeThreadId = null; pendingRange = null;
    }

    // ── Build decorations ────────────────────────────────────────────────────
    let decorations = Decoration.none;
    if (anchorPos !== null) {
      try {
        decorations = _buildDecorations(
          tr.state, anchorPos, activeThreadId, pendingRange
        );
      } catch {
        anchorPos = null; activeThreadId = null; pendingRange = null;
      }
    }

    return { anchorPos, activeThreadId, pendingRange, decorations };
  },

  provide: f => EditorView.decorations.from(f, v => v.decorations)
});

// ---------------------------------------------------------------------------
// Decoration builder
// ---------------------------------------------------------------------------

function _buildDecorations(editorState, anchorPos, activeThreadId, pendingRange) {
  const doc    = editorState.doc;
  const line   = doc.lineAt(anchorPos);
  const threads = getThreadsForLine(anchorPos, doc);
  const sorted  = [...threads].sort((a, b) => a.from - b.from);

  // Collect mark ranges, sort, then add
  const marks = [];

  for (const t of sorted) {
    if (t.from < t.to) {
      marks.push({
        from: t.from,
        to:   t.to,
        cls:  t.id === activeThreadId ? 'cm-comment-range-active' : 'cm-comment-range'
      });
    }
  }

  if (pendingRange && pendingRange.from < pendingRange.to) {
    marks.push({ from: pendingRange.from, to: pendingRange.to, cls: 'cm-comment-range-active' });
  }

  marks.sort((a, b) => a.from !== b.from ? a.from - b.from : a.to - b.to);

  const builder = new RangeSetBuilder();

  for (const m of marks) {
    if (m.from < line.to) {
      builder.add(m.from, Math.min(m.to, doc.length), Decoration.mark({ class: m.cls }));
    }
  }

  // Block widget at end of anchor line
  builder.add(line.to, line.to, Decoration.widget({
    widget: new AccordionWidget({
      anchorPos,
      activeThreadId,
      threads: sorted,
      pendingRange,
      threadDataVersion: _threadDataVersion
    }),
    block: true,
    side: 1
  }));

  return builder.finish();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make a textarea grow to fit its content.
 * Sets the height to scrollHeight on every input event.
 * Uses a rAF for the initial sizing so CM6 has already laid out the widget.
 */
function _autoGrow(ta) {
  const resize = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', resize);
  requestAnimationFrame(resize);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatRelative(ts) {
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

function _showError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}
