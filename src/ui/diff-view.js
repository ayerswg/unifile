/**
 * Commit diff view (read-only).
 *
 * Clicking a save in the history opens this: a side-by-side line diff comparing
 * two versions of the document.  Each side is a save's hash or the sentinel
 * 'WORKING' (the live editor content).  The DiffBar (bottom) lets you change
 * which two versions are shown, RESTORE a save's text into the editor (it
 * lands as an unsaved change — Save keeps it; history stays one line) and
 * return to the working editor.
 *
 *   DiffView  → the two-column diff overlay (covers #uf-main)
 *   DiffBar   → the bottom controls (two pickers + Restore + "Return to working")
 */

import { state } from './state.js';
import { shortHash } from '../core/hash.js';
import { lineDiff } from '../core/diff.js';

const WORKING = 'WORKING';

function _isMobile() {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(max-width: 640px), (orientation: landscape) and (max-height: 500px) and (pointer: coarse)').matches;
}

function _sideContent(side) {
  if (side === WORKING) return state.currentContent ?? '';
  return state.vcs?.getContentAt(side) ?? '';
}

function _sideLabel(side) {
  if (side === WORKING) return 'Working' + (state.isDirty ? ' (uncommitted)' : '');
  const c = state.vcs?.commits?.[side];
  const msg = c?.message ? ' · ' + c.message : '';
  return shortHash(side) + msg;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------

export class DiffView {
  /** @param {HTMLElement} el */
  constructor(el) {
    this.el = el;
    state.on('diff-change', () => this.render());
    // Keep the WORKING side live as the user types.
    state.on('content-change', () => { if (state.diff) this.render(); });
    this.render();
  }

  render() {
    const diff = state.diff;
    if (!diff) { this.el.innerHTML = ''; return; }

    const leftText  = _sideContent(diff.left);
    const rightText = _sideContent(diff.right);
    const rows = lineDiff(leftText, rightText);

    const cell = (no, text, side) =>
      `<td class="dv-no">${no ?? ''}</td><td class="dv-code dv-${side}">${_esc(text ?? '')}</td>`;

    const body = rows.map(r =>
      `<tr class="dv-row dv-${r.type}">${cell(r.leftNo, r.left, 'l')}${cell(r.rightNo, r.right, 'r')}</tr>`
    ).join('');

    this.el.innerHTML = `
      <div class="dv-head">
        <span class="dv-head-label dv-head-l">${_esc(_sideLabel(diff.left))}</span>
        <span class="dv-head-label dv-head-r">${_esc(_sideLabel(diff.right))}</span>
      </div>
      <div class="dv-scroll"><table class="dv-table"><tbody>${body}</tbody></table></div>`;
  }
}

// ---------------------------------------------------------------------------

/**
 * Mobile-only single-column diff panes.  The middle pane (`#uf-diff-mid`) shows
 * the LEFT side's content, the right pane (`#uf-diff-right`) the RIGHT side's —
 * each with its own add/del/change tint — so swiping middle↔right reads as a
 * before/after.  Desktop still uses the two-column `DiffView` above.
 */
export class DiffPanes {
  /** @param {HTMLElement} midEl  @param {HTMLElement} rightEl */
  constructor(midEl, rightEl) {
    this.midEl = midEl;
    this.rightEl = rightEl;
    state.on('diff-change', () => this.render());
    state.on('content-change', () => { if (state.diff) this.render(); });
    this.render();
  }

  render() {
    const diff = state.diff;
    if (!diff) { this.midEl.innerHTML = ''; this.rightEl.innerHTML = ''; return; }

    const rows = lineDiff(_sideContent(diff.left), _sideContent(diff.right));

    // side='left'  → skip pure-add rows (no left text); tint del/change.
    // side='right' → skip pure-del rows (no right text); tint add/change.
    const column = (side) => rows.map(r => {
      const text = side === 'left' ? r.left : r.right;
      const no   = side === 'left' ? r.leftNo : r.rightNo;
      if (text == null) return '';                       // line absent on this side
      return `<div class="dvp-line dvp-${r.type}"><span class="dvp-no">${no ?? ''}</span><span class="dvp-code">${_esc(text)}</span></div>`;
    }).join('');

    this.midEl.innerHTML =
      `<div class="dvp-head">${_esc(_sideLabel(diff.left))}</div><div class="dvp-scroll">${column('left')}</div>`;
    this.rightEl.innerHTML =
      `<div class="dvp-head">${_esc(_sideLabel(diff.right))}</div><div class="dvp-scroll">${column('right')}</div>`;
  }
}

// ---------------------------------------------------------------------------

export class DiffBar {
  /**
   * @param {HTMLElement} el
   * @param {{ onRestore?: (hash:string)=>void }} [handlers]
   */
  constructor(el, handlers = {}) {
    this.el = el;
    this.handlers = handlers;
    this._pane = document.getElementById('unifile-app')?.getAttribute('data-mobile-pane') || 'editor';
    state.on('diff-change', () => this.render());
    state.on('change',      () => { if (state.diff) this.render(); });
    state.on('mobile-goto-pane', (p) => { this._pane = p; if (state.diff) this.render(); });
    this.render();
  }

  render() {
    const diff = state.diff;
    if (!diff) { this.el.innerHTML = ''; return; }
    if (_isMobile()) this._renderMobile(diff);
    else this._renderDesktop(diff);
  }

  // ── Desktop: two <select> pickers + return-to-working ──────────────────────
  _renderDesktop(diff) {
    const opts = (selected) => {
      const log = state.vcs?.log?.() ?? [];
      const items = [{ v: WORKING, label: 'Working state' },
        ...log.map(c => ({ v: c.hash, label: `${shortHash(c.hash)} · ${c.message || '(no message)'}` }))];
      return items.map(o =>
        `<option value="${_esc(o.v)}"${o.v === selected ? ' selected' : ''}>${_esc(o.label)}</option>`).join('');
    };

    // The save to restore: the right side when it is a save, else the left.
    const restorable = _restorable(diff);
    this.el.innerHTML = `
      <div class="db">
        <span class="db-label">Comparing</span>
        <select class="db-pick" id="db-left" aria-label="Left side">${opts(diff.left)}</select>
        <span class="db-swap" title="Left ↔ right">↔</span>
        <select class="db-pick" id="db-right" aria-label="Right side">${opts(diff.right)}</select>
        ${restorable ? `<button class="db-btn db-restore" id="db-restore" type="button"
          title="Bring this save's text back into the editor (as an unsaved change)">Restore ${_esc(shortHash(restorable))}</button>` : ''}
        <button class="db-return" id="db-return" type="button">Return to working</button>
      </div>`;

    const left  = this.el.querySelector('#db-left');
    const right = this.el.querySelector('#db-right');
    left?.addEventListener('change',  () => state.openDiff(left.value, right.value));
    right?.addEventListener('change', () => state.openDiff(left.value, right.value));
    this.el.querySelector('#db-return')?.addEventListener('click', () => state.closeDiff());
    this.el.querySelector('#db-restore')?.addEventListener('click', () => this.handlers.onRestore?.(restorable));
  }

  // ── Mobile: contextual action buttons for the active pane ──────────────────
  //   history pane → Exit only
  //   middle pane  → Restore (when the left side is a save) + Exit
  //   right pane   → Restore (the right side, always a save) + Exit
  _renderMobile(diff) {
    const pane = this._pane;
    const exitBtn = `<button class="db-btn db-exit" id="db-exit" type="button">Exit diff</button>`;
    let actions = '';
    let hash = null;

    if (pane === 'editor' && diff.left !== WORKING) hash = diff.left;        // middle pane
    else if (pane === 'render' && diff.right !== WORKING) hash = diff.right; // right pane
    if (hash) {
      actions += `<button class="db-btn db-restore" id="db-restore" type="button">Restore ${_esc(shortHash(hash))}</button>`;
    }

    this.el.innerHTML = `<div class="db db-mobile">${actions}${exitBtn}</div>`;

    this.el.querySelector('#db-exit')?.addEventListener('click', () => state.closeDiff());
    this.el.querySelector('#db-restore')?.addEventListener('click', () => this.handlers.onRestore?.(hash));
  }
}

/** The save a diff can restore: the right side when it is a save, else the left. */
function _restorable(diff) {
  if (diff.right && diff.right !== WORKING) return diff.right;
  if (diff.left && diff.left !== WORKING) return diff.left;
  return null;
}
