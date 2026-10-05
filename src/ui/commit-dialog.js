/**
 * Save dialog — "Save with message…"
 *
 * The plain Save (Ctrl+S, the Save pill, the phone bubble) snapshots with no
 * message; this dialog is for the saves you want to label.  Fields:
 *   Author / Email  – shown until an identity is cached (both optional: an
 *                     unnamed save is still a save; Settings changes them later)
 *   Message         – optional
 *   SemVer tag      – optional
 *
 * On submit → calls handler with the save data.
 */

import { state, PANELS } from './state.js';
import { loadUserPrefs, saveUserPrefs } from '../core/storage.js';

export class CommitDialog {
  /**
   * @param {HTMLElement} container – the panel/overlay container
   * @param {{ onCommit: (opts) => Promise<void> }} handlers
   */
  constructor(container, handlers = {}) {
    this.el = container;
    this.handlers = handlers;
    this._unsub = [];

    this._unsub.push(state.on('panel-change', (panel) => {
      if (panel === PANELS.COMMIT) this.show();
      else this.hide();
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  show() {
    const prefs = loadUserPrefs();
    const hasCachedIdentity = !!(prefs.name || prefs.email);
    const head = state.vcs?.headCommit;
    const suggestedTag = head?.tag ? incrementPatch(head.tag) : '';

    // Carry over a message/version typed in the history pane's pending node
    // before this dialog was opened.
    const pending = state.pendingCommit;
    state.pendingCommit = null;
    const draftMsg = pending?.message ?? '';
    const draftTag = pending?.tag ?? suggestedTag;

    // ── Identity section ───────────────────────────────────────────────────
    const identitySection = hasCachedIdentity
      ? `<div class="commit-identity-row">
           <span class="commit-identity-avatar">${initials(prefs.name)}</span>
           <div class="commit-identity-info">
             <strong>${escHtml(prefs.name || 'anonymous')}</strong>
             <span>${escHtml(prefs.email || '')}</span>
           </div>
         </div>`
      : `<div class="form-row">
           <label class="form-label" for="commit-author">
             Author name <span class="form-hint">(optional)</span>
           </label>
           <input class="form-input" id="commit-author" type="text"
             value="${escHtml(prefs.name ?? '')}"
             placeholder="Your Name" autocomplete="name">
         </div>
         <div class="form-row">
           <label class="form-label" for="commit-email">
             Email <span class="form-hint">(optional)</span>
           </label>
           <input class="form-input" id="commit-email" type="email"
             value="${escHtml(prefs.email ?? '')}"
             placeholder="you@example.com" autocomplete="email">
         </div>`;

    this.el.innerHTML = `
      <div class="dialog-overlay" id="commit-overlay">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="commit-title">
          <div class="dialog-header">
            <h2 class="dialog-title" id="commit-title">Save with message</h2>
            <button class="dialog-close" id="commit-close" aria-label="Close">&times;</button>
          </div>

          <div class="dialog-body">
            <div class="diff-summary">
              ${this._renderDiffSummary()}
            </div>

            ${identitySection}

            <div class="form-row">
              <label class="form-label" for="commit-message">
                Message
                <span class="form-hint">(optional)</span>
              </label>
              <textarea class="form-input form-textarea" id="commit-message"
                placeholder="Describe your changes…" rows="3">${escHtml(draftMsg)}</textarea>
            </div>

            <div class="form-row">
              <label class="form-label" for="commit-tag">
                Version
                <span class="form-hint">(optional, e.g. 1.2.3)</span>
              </label>
              <input class="form-input" id="commit-tag" type="text"
                value="${escHtml(draftTag)}"
                placeholder="1.0.0" pattern="\\d+\\.\\d+\\.\\d+.*">
            </div>

            <p id="commit-error" class="form-error" hidden></p>
          </div>

          <div class="dialog-footer">
            <button class="btn btn-ghost" id="commit-cancel">Cancel</button>
            <button class="btn btn-primary" id="commit-submit">
              ${iconCommit()} Save
            </button>
          </div>
        </div>
      </div>
    `;

    this.el.style.display = '';

    setTimeout(() => this.el.querySelector('#commit-message')?.focus(), 50);

    this._bindEvents(hasCachedIdentity);
  }

  hide() {
    this.el.innerHTML = '';
    this.el.style.display = 'none';
  }

  _renderDiffSummary() {
    const vcs = state.vcs;
    if (!vcs || !state.isDirty) return '<p class="diff-none">Nothing changed since the last save.</p>';

    const oldContent = vcs.headContent;
    const newContent = state.currentContent;

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const added = Math.max(0, newLines.length - oldLines.length);
    const removed = Math.max(0, oldLines.length - newLines.length);

    return `
      <div class="diff-stats">
        <span class="diff-added">+${added} line${added !== 1 ? 's' : ''}</span>
        <span class="diff-removed">−${removed} line${removed !== 1 ? 's' : ''}</span>
        <span class="diff-from">from ${state.shortHeadHash || '(new)'}</span>
      </div>
    `;
  }

  _bindEvents(hasCachedIdentity) {
    const closeBtn = this.el.querySelector('#commit-close');
    const cancelBtn = this.el.querySelector('#commit-cancel');
    const submitBtn = this.el.querySelector('#commit-submit');
    const overlay = this.el.querySelector('#commit-overlay');

    closeBtn?.addEventListener('click', () => state.closePanel());
    cancelBtn?.addEventListener('click', () => state.closePanel());

    // Close on overlay click
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) state.closePanel();
    });

    // ESC to close
    document.addEventListener('keydown', this._escHandler = (e) => {
      if (e.key === 'Escape') state.closePanel();
    }, { once: true });

    submitBtn?.addEventListener('click', () => this._submit(hasCachedIdentity));

    // Ctrl/Cmd+Enter in the message field to submit
    this.el.querySelector('#commit-message')?.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') this._submit(hasCachedIdentity);
    });
  }

  async _submit(hasCachedIdentity) {
    const prefs = loadUserPrefs();
    const errEl = this.el.querySelector('#commit-error');

    const setError = (msg) => {
      errEl.textContent = msg;
      errEl.hidden = false;
    };

    // Identity
    let author, email;
    if (hasCachedIdentity) {
      author = prefs.name;
      email = prefs.email;
    } else {
      author = this.el.querySelector('#commit-author')?.value.trim() || '';
      email = this.el.querySelector('#commit-email')?.value.trim() || '';
      if (email && !email.includes('@')) { setError('That email doesn’t look right.'); return; }
    }

    const message = this.el.querySelector('#commit-message')?.value.trim() || '';
    const tag = this.el.querySelector('#commit-tag')?.value.trim();

    if (tag && !/^\d+\.\d+\.\d+/.test(tag)) {
      setError('Tag must be a valid SemVer string (e.g. 1.2.3).');
      return;
    }

    errEl.hidden = true;
    const submitBtn = this.el.querySelector('#commit-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    // Cache identity for next time (skip if already cached)
    if (!hasCachedIdentity && (author || email)) {
      saveUserPrefs({ name: author, email });
    }

    try {
      await this.handlers.onCommit?.({
        author,
        email,
        message,
        tag: tag || null,
      });
      state.closePanel();
    } catch (err) {
      setError(`Save failed: ${err.message}`);
      submitBtn.disabled = false;
      submitBtn.innerHTML = `${iconCommit()} Save`;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iconCommit() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/>
    <line x1="1" y1="8" x2="5" y2="8" stroke="currentColor" stroke-width="2"/>
    <line x1="11" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="2"/>
  </svg>`;
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function incrementPatch(semver) {
  const m = semver.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return '';
  return `${m[1]}.${m[2]}.${+m[3] + 1}`;
}

/** Generate 1-2 initials from a display name. */
function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');
}
