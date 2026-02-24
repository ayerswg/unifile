/**
 * Line-level comments system
 *
 * Data model:  data.commentThreads = { [threadId]: Thread }
 *
 * Thread = {
 *   id: string,
 *   lineNum: number,          // line number when created (may drift on large edits)
 *   createdAtHash: string,    // head commit hash at creation (context only)
 *   archived: boolean,        // soft-deleted; still stored for history
 *   messages: Message[]
 * }
 *
 * Message = { id, author, text, timestamp }
 *
 * CONSTRAINT: Only ONE active (non-archived) thread per line at a time.
 * Archive the existing thread to start a new one.
 *
 * Threads are NOT keyed by commit hash — they persist across commits.
 */

import { state, PANELS } from './state.js';
import { loadUserPrefs, saveUserPrefs } from '../core/storage.js';
import { shortHash } from '../core/hash.js';

// ---------------------------------------------------------------------------
// Public helpers (used by editor gutter)
// ---------------------------------------------------------------------------

/** Returns the single active (non-archived) thread for a line, or null. */
export function getActiveThreadForLine(lineNum) {
  const threads = state.data?.commentThreads ?? {};
  return Object.values(threads).find(t => t.lineNum === lineNum && !t.archived) ?? null;
}

// ---------------------------------------------------------------------------
// CommentsPanel
// ---------------------------------------------------------------------------

export class CommentsPanel {
  constructor(container, handlers = {}) {
    this.el = container;
    this.handlers = handlers;
    this._unsub = [];

    this._unsub.push(state.on('panel-change', (panel) => {
      if (panel === PANELS.COMMENTS) this.show();
      else this.hide();
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  /** Open the panel for a specific line (called by editor gutter click). */
  openForLine(lineNum) {
    state.focusedLine = lineNum;
    state.openPanel(PANELS.COMMENTS);
  }

  show() {
    const lineNum = state.focusedLine;
    if (lineNum == null) {
      this._renderNoLine();
    } else {
      this._renderForLine(lineNum);
    }
    this.el.style.display = '';
  }

  hide() {
    this.el.innerHTML = '';
    this.el.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  _renderNoLine() {
    this.el.innerHTML = `
      <div class="panel-sidebar comments-panel">
        <div class="panel-header">
          <h3 class="panel-title">Comments</h3>
          <button class="dialog-close" id="comments-close">&times;</button>
        </div>
        <p class="comments-empty">
          Click a line number in the editor to view or add a comment for that line.
        </p>
      </div>
    `;
    this.el.querySelector('#comments-close')
      ?.addEventListener('click', () => state.closePanel());
  }

  _renderForLine(lineNum) {
    const thread = getActiveThreadForLine(lineNum);
    const prefs = loadUserPrefs();

    this.el.innerHTML = `
      <div class="panel-sidebar comments-panel">
        <div class="panel-header">
          <h3 class="panel-title">
            Comments
            <span class="comments-line-badge">Line ${lineNum}</span>
          </h3>
          <button class="dialog-close" id="comments-close">&times;</button>
        </div>

        <div class="ct-threads-list" id="ct-threads-list">
          ${thread
            ? this._renderThread(thread)
            : '<p class="comments-empty">No comment on this line yet.</p>'
          }
        </div>

        ${!thread ? `
          <div class="ct-new-thread-section">
            <div class="ct-new-thread-label">Add comment</div>
            <input class="form-input ct-author-input" id="ct-author" type="text"
              value="${escHtml(prefs.name ?? '')}" placeholder="Your name" required>
            <textarea class="form-input form-textarea" id="ct-body"
              placeholder="Write a comment… (Ctrl+Enter to submit)" rows="3"></textarea>
            <div class="ct-actions">
              <button class="btn btn-primary btn-sm" id="ct-submit">Add comment</button>
            </div>
            <p id="ct-error" class="form-error" hidden></p>
          </div>
        ` : ''}
      </div>
    `;

    this._bindEvents(lineNum);
  }

  _renderThread(thread) {
    const msgWord = thread.messages.length === 1 ? 'comment' : 'comments';
    return `
      <div class="ct-thread" data-thread-id="${escHtml(thread.id)}">
        <div class="ct-thread-header">
          <span class="ct-thread-meta">
            <span class="ct-thread-hash">${shortHash(thread.createdAtHash)}</span>
            <span class="ct-msg-count">${thread.messages.length} ${msgWord}</span>
          </span>
          <button class="ct-archive-btn" data-thread-id="${escHtml(thread.id)}"
            title="Archive this thread — removes the line highlight and lets you start a fresh thread">
            Archive
          </button>
        </div>
        <div class="ct-messages">
          ${thread.messages.map(m => this._renderMessage(m)).join('')}
        </div>
        <div class="ct-reply-form">
          <textarea class="form-input form-textarea ct-reply-body"
            placeholder="Reply… (Ctrl+Enter to send)"
            rows="2"
            data-thread-id="${escHtml(thread.id)}"></textarea>
          <div class="ct-reply-actions">
            <button class="btn btn-sm ct-reply-submit"
              data-thread-id="${escHtml(thread.id)}">Reply</button>
          </div>
        </div>
      </div>
    `;
  }

  _renderMessage(msg) {
    return `
      <div class="ct-message" data-msg-id="${escHtml(msg.id)}">
        <div class="ct-msg-header">
          <span class="ct-msg-author">${escHtml(msg.author)}</span>
          <span class="ct-msg-date">${formatRelative(msg.timestamp)}</span>
        </div>
        <div class="ct-msg-body">${escHtml(msg.text)}</div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  _bindEvents(lineNum) {
    this.el.querySelector('#comments-close')
      ?.addEventListener('click', () => state.closePanel());

    // Start new thread
    this.el.querySelector('#ct-submit')
      ?.addEventListener('click', () => this._startThread(lineNum));

    this.el.querySelector('#ct-body')
      ?.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') this._startThread(lineNum);
      });

    // Archive button
    this.el.querySelector('.ct-archive-btn')
      ?.addEventListener('click', (e) => {
        const threadId = e.currentTarget.dataset.threadId;
        this._archiveThread(threadId, lineNum);
      });

    // Reply button + Ctrl+Enter
    const replyBtn = this.el.querySelector('.ct-reply-submit');
    if (replyBtn) {
      replyBtn.addEventListener('click', () =>
        this._replyToThread(replyBtn.dataset.threadId, lineNum)
      );
    }
    const replyBody = this.el.querySelector('.ct-reply-body');
    if (replyBody) {
      replyBody.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          this._replyToThread(replyBody.dataset.threadId, lineNum);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  _startThread(lineNum) {
    const authorEl = this.el.querySelector('#ct-author');
    const bodyEl   = this.el.querySelector('#ct-body');
    const errEl    = this.el.querySelector('#ct-error');

    const author = authorEl?.value.trim();
    const text   = bodyEl?.value.trim();

    if (!author) { this._showError(errEl, 'Name is required.'); return; }
    if (!text)   { this._showError(errEl, 'Comment text is required.'); return; }
    errEl.hidden = true;

    saveUserPrefs({ name: author });

    const threadId = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const msgId    = `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const thread = {
      id: threadId,
      lineNum,
      createdAtHash: state.headHash,
      archived: false,
      messages: [{ id: msgId, author, text, timestamp: Date.now() }]
    };

    const data = state.data;
    data.commentThreads ??= {};
    data.commentThreads[threadId] = thread;
    state.update({ data, isDirty: true });
    state.emit('comments-change', { lineNum });

    this._renderForLine(lineNum);
  }

  _replyToThread(threadId, lineNum) {
    const textarea = this.el.querySelector(`.ct-reply-body[data-thread-id="${CSS.escape(threadId)}"]`);
    if (!textarea) return;

    const text = textarea.value.trim();
    if (!text) return;

    const author = loadUserPrefs().name || 'Anonymous';
    const msgId  = `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const data = state.data;
    data.commentThreads ??= {};
    if (data.commentThreads[threadId]) {
      data.commentThreads[threadId].messages.push({ id: msgId, author, text, timestamp: Date.now() });
    }
    state.update({ data, isDirty: true });
    state.emit('comments-change', { lineNum });

    this._renderForLine(lineNum);
  }

  _archiveThread(threadId, lineNum) {
    const data = state.data;
    if (data.commentThreads?.[threadId]) {
      data.commentThreads[threadId].archived = true;
    }
    state.update({ data, isDirty: true });
    state.emit('comments-change', { lineNum });

    // Re-render — no active thread means new-thread form appears
    this._renderForLine(lineNum);
  }

  _showError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
