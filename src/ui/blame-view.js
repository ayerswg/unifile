/**
 * Blame view
 *
 * Shows the document line by line, with each line annotated with
 * the commit that last modified it. Clicking a line highlights
 * all lines from the same commit and shows commit details.
 */

import { state, PANELS } from './state.js';
import { shortHash } from '../core/hash.js';

export class BlameView {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this.el = container;
    this._unsub = [];
    this._selectedHash = null;

    this._unsub.push(state.on('panel-change', (panel) => {
      if (panel === PANELS.BLAME) this.show();
      else this.hide();
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  show() {
    const blame = state.vcs?.blame() ?? [];
    const commits = state.vcs?.commits ?? {};

    // Assign a color index to each unique commit (for visual grouping)
    const commitColors = new Map();
    let colorIdx = 0;
    blame.forEach(({ commitHash: h }) => {
      if (h && !commitColors.has(h)) {
        commitColors.set(h, colorIdx++ % 8);
      }
    });

    this.el.innerHTML = `
      <div class="blame-view">
        <div class="blame-header">
          <span class="blame-title">Blame view</span>
          <button class="btn btn-ghost blame-close" id="blame-close">✕ Close</button>
        </div>
        <div class="blame-body">
          <div class="blame-sidebar" id="blame-sidebar">
            <div class="blame-commit-detail" id="blame-commit-detail">
              <p class="blame-hint">Click a line to see commit details</p>
            </div>
          </div>
          <div class="blame-lines" id="blame-lines">
            ${(() => {
              let prevHash;
              return blame.map((item, i) => {
                const commit = commits[item.commitHash];
                const color = commitColors.get(item.commitHash) ?? 0;
                const hash = escHtml(item.commitHash ?? '');
                // A group header precedes the first line of each commit run.
                // It is hidden on desktop (inline meta is shown there instead)
                // and is the primary commit label on mobile.
                const startsGroup = item.commitHash !== prevHash;
                prevHash = item.commitHash;
                const header = startsGroup ? `
                  <button type="button" class="blame-group color-${color}"
                    data-hash="${hash}" data-line="${i + 1}">
                    <span class="blame-hash">${shortHash(item.commitHash)}</span>
                    <span class="blame-author">${escHtml(commit?.author ?? '?')}</span>
                    <span class="blame-msg">${escHtml(commit?.message ?? '')}</span>
                    <span class="blame-date">${formatDate(commit?.timestamp)}</span>
                  </button>` : '';
                return `${header}
                <div class="blame-line color-${color} ${this._selectedHash === item.commitHash ? 'selected' : ''}"
                  data-hash="${hash}"
                  data-line="${i + 1}">
                  <span class="blame-lineno">${i + 1}</span>
                  <span class="blame-meta">
                    <span class="blame-hash">${shortHash(item.commitHash)}</span>
                    <span class="blame-author">${escHtml(commit?.author ?? '?')}</span>
                    <span class="blame-date">${formatDate(commit?.timestamp)}</span>
                  </span>
                  <span class="blame-content">${escHtml(item.line)}</span>
                </div>
              `;
              }).join('');
            })()}
            ${blame.length === 0 ? '<p class="blame-empty">No commits yet — nothing to blame.</p>' : ''}
          </div>
        </div>
      </div>
    `;

    this.el.style.display = '';
    this._bindEvents();
  }

  hide() {
    this.el.innerHTML = '';
    this.el.style.display = 'none';
  }

  _bindEvents() {
    this.el.querySelector('#blame-close')?.addEventListener('click', () => {
      state.closePanel();
    });

    this.el.querySelectorAll('.blame-line, .blame-group').forEach(rowEl => {
      rowEl.addEventListener('click', () => {
        const hash = rowEl.dataset.hash;
        const lineNum = parseInt(rowEl.dataset.line, 10);
        if (!hash) return;

        this._selectedHash = hash;
        this._highlightCommit(hash);
        this._showCommitDetail(hash, lineNum);
        // On mobile the detail sidebar is a bottom sheet, revealed on demand.
        this.el.querySelector('.blame-view')?.classList.add('has-detail');
      });
    });
  }

  _highlightCommit(hash) {
    this.el.querySelectorAll('.blame-line').forEach(el => {
      el.classList.toggle('selected', el.dataset.hash === hash);
    });
  }

  _showCommitDetail(hash, lineNum) {
    const commit = state.vcs?.commits[hash];
    if (!commit) return;

    const detail = this.el.querySelector('#blame-commit-detail');
    if (!detail) return;

    detail.innerHTML = `
      <div class="blame-detail-card">
        <button type="button" class="blame-detail-dismiss" id="blame-detail-dismiss" aria-label="Close commit details">✕</button>
        <div class="blame-detail-hash">${shortHash(hash)}</div>
        ${commit.tag ? `<div class="blame-detail-tag">${escHtml(commit.tag)}</div>` : ''}
        <div class="blame-detail-msg">${escHtml(commit.message)}</div>
        <div class="blame-detail-author">
          <span>${escHtml(commit.author)}</span>
          <span class="blame-detail-email">&lt;${escHtml(commit.email)}&gt;</span>
        </div>
        <div class="blame-detail-date">${formatFullDate(commit.timestamp)}</div>
        <div class="blame-detail-line">Line ${lineNum}</div>
        <div class="blame-detail-actions">
          <button class="btn btn-ghost btn-sm blame-checkout" data-hash="${hash}">
            Checkout this commit
          </button>
        </div>
      </div>
    `;

    detail.querySelector('#blame-detail-dismiss')?.addEventListener('click', () => {
      this.el.querySelector('.blame-view')?.classList.remove('has-detail');
    });

    detail.querySelector('.blame-checkout')?.addEventListener('click', () => {
      if (state.isDirty && !confirm('Uncommitted changes will be lost. Continue?')) return;
      const { content } = state.vcs.checkout(hash);
      state.update({ currentContent: content, isDirty: false });
      state.emit('checkout', { hash, content });
      state.closePanel();
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString();
}

function formatFullDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}
