/**
 * Commit diff view (read-only).
 *
 * Clicking a non-current commit opens this: a side-by-side line diff comparing
 * two versions of the document.  Each side is a commit hash or the sentinel
 * 'WORKING' (the live editor content).  The DiffBar (bottom) lets you change
 * which two versions are shown and return to the working editor.
 *
 *   DiffView  → the two-column diff overlay (covers #uf-main)
 *   DiffBar   → the bottom controls (two pickers + "Return to working")
 */

import { state } from './state.js';
import { shortHash } from '../core/hash.js';
import { lineDiff } from '../core/diff.js';

const WORKING = 'WORKING';

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

export class DiffBar {
  /** @param {HTMLElement} el */
  constructor(el) {
    this.el = el;
    state.on('diff-change', () => this.render());
    state.on('change',      () => { if (state.diff) this.render(); });
    this.render();
  }

  render() {
    const diff = state.diff;
    if (!diff) { this.el.innerHTML = ''; return; }

    const opts = (selected) => {
      const log = state.vcs?.log?.() ?? [];
      const items = [{ v: WORKING, label: 'Working state' },
        ...log.map(c => ({ v: c.hash, label: `${shortHash(c.hash)} · ${c.message || '(no message)'}` }))];
      return items.map(o =>
        `<option value="${_esc(o.v)}"${o.v === selected ? ' selected' : ''}>${_esc(o.label)}</option>`).join('');
    };

    this.el.innerHTML = `
      <div class="db">
        <span class="db-label">Comparing</span>
        <select class="db-pick" id="db-left" aria-label="Left side">${opts(diff.left)}</select>
        <span class="db-swap" title="Left ↔ right">↔</span>
        <select class="db-pick" id="db-right" aria-label="Right side">${opts(diff.right)}</select>
        <button class="db-return" id="db-return" type="button">Return to working</button>
      </div>`;

    const left  = this.el.querySelector('#db-left');
    const right = this.el.querySelector('#db-right');
    left?.addEventListener('change',  () => state.openDiff(left.value, right.value));
    right?.addEventListener('change', () => state.openDiff(left.value, right.value));
    this.el.querySelector('#db-return')?.addEventListener('click', () => state.closeDiff());
  }
}
