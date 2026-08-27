/**
 * WriterEditor — the custom distraction-free plain-text Markdown editor.
 *
 * NOT CodeMirror, on purpose: the defining feature is that a wrapped list item
 * indents its continuation lines to align after the bullet marker ("bullet
 * indent wrap"), which we get by rendering ONE block element per source line
 * and giving list/quote lines a CSS hanging indent
 * (`padding-left: Nch; text-indent: -Nch`).  The editor font is monospaced so
 * `ch` math is exact.
 *
 * Architecture — the DOM is a *view* of a plain-text model:
 *   • Model: `this.lines` (string[]) — the document, source of truth.
 *   • View:  a contenteditable root with one `<div class="wr-line t-…">` per
 *     line, inner HTML from syntax.js (markers dimmed, text preserved
 *     verbatim — textContent of a line div is exactly the source line).
 *   • The caret is tracked as absolute character offsets into the joined text
 *     and restored positionally after any re-render.
 *
 * iOS is the primary target, which dictates the editing strategy:
 *   • Character-level edits (typing, backspace, autocorrect's
 *     insertReplacementText, dictation) run NATIVELY in the contenteditable —
 *     intercepting them breaks autocorrect/dictation.  After the browser
 *     mutates the DOM we RECONCILE: extract the text back out, diff against
 *     the model, re-render only lines whose rendered HTML changed, restore
 *     the caret by offset.
 *   • Structural edits (Enter, paste, drop, Cmd+B/I, undo/redo) are
 *     intercepted in `beforeinput` and applied to the model directly —
 *     browsers disagree wildly about the DOM these produce natively.
 *   • During IME/marked-text composition (`isComposing`) we NEVER touch the
 *     DOM — mutating composed text detaches the composition (a hard-learned
 *     contenteditable rule).  Reconcile is deferred to `compositionend`.
 *   • Undo/redo is our own snapshot stack: native undo history dies the first
 *     time we re-render a line, so `historyUndo`/`historyRedo` (which iOS's
 *     shake-to-undo and keyboard undo key also emit) are intercepted.
 */

import { classifyDoc, renderLineHtml, lineClass } from './syntax.js';

const UNDO_LIMIT = 500;
const UNDO_COALESCE_MS = 900;

export class WriterEditor {
  /**
   * @param {HTMLElement} host      element the editor mounts into
   * @param {object}   opts
   * @param {Function} [opts.onChange]  fired (debounced by caller) after any model change
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.onChange = opts.onChange || (() => {});
    this.onSlash = opts.onSlash || null;   // ctx|null → app's insertion menu
    this.lines = [''];
    this.infos = classifyDoc(this.lines);
    this._cache = [];            // rendered inner HTML per line (dirty check)
    this._undo = [];
    this._redo = [];
    this._lastUndoAt = 0;
    this._lastUndoKind = null;
    this._composing = false;
    this._pendingReconcile = false;
    this.focusMode = false;

    host.innerHTML = '';
    this.root = document.createElement('div');
    this.root.className = 'wr-editor';
    this.root.setAttribute('contenteditable', 'true');
    this.root.setAttribute('role', 'textbox');
    this.root.setAttribute('aria-multiline', 'true');
    this.root.setAttribute('aria-label', 'Document text');
    this.root.setAttribute('autocapitalize', 'sentences');
    this.root.setAttribute('autocorrect', 'on');
    this.root.setAttribute('spellcheck', 'true');
    host.appendChild(this.root);

    this._render(true);
    this._bind();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getValue() { return this.lines.join('\n'); }

  setValue(text, { resetUndo = true } = {}) {
    this.lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    if (resetUndo) { this._undo = []; this._redo = []; }
    this._render(true);
    this.onChange();
    this.onSlash?.(null);
  }

  focus() { this.root.focus(); }

  /** { words, chars, minutes } for the footer counter. */
  getStats() {
    const text = this.getValue();
    const words = (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
    return { words, chars: text.length, minutes: Math.max(1, Math.round(words / 220)) };
  }

  setFocusMode(on) {
    this.focusMode = !!on;
    this.root.classList.toggle('wr-focus', this.focusMode);
    this._updateFocusPara();
  }

  // ----- formatting commands (toolbar / shortcuts) --------------------------

  /** Toggle an inline wrapper (e.g. '**', '*', '`', '~~') around the selection. */
  wrapSelection(marker) {
    const sel = this._selOffsets();
    if (!sel) return;
    const text = this.getValue();
    let { start, end } = sel;
    // Collapsed caret: wrap the word under the caret (or insert an empty pair).
    if (start === end) {
      let a = start, b = end;
      while (a > 0 && /[\p{L}\p{N}'’-]/u.test(text[a - 1])) a--;
      while (b < text.length && /[\p{L}\p{N}'’-]/u.test(text[b])) b++;
      if (a === b) {
        this._applyEdit(start, end, marker + marker, start + marker.length, start + marker.length, 'format');
        return;
      }
      start = a; end = b;
    }
    const before = text.slice(start - marker.length, start);
    const after = text.slice(end, end + marker.length);
    const inner = text.slice(start, end);
    if (before === marker && after === marker) {
      // Unwrap (markers just outside the selection).
      this._applyEdit(start - marker.length, end + marker.length, inner,
        start - marker.length, end - marker.length, 'format');
    } else if (inner.startsWith(marker) && inner.endsWith(marker) && inner.length >= marker.length * 2) {
      // Unwrap (markers inside the selection).
      const stripped = inner.slice(marker.length, inner.length - marker.length);
      this._applyEdit(start, end, stripped, start, start + stripped.length, 'format');
    } else {
      this._applyEdit(start, end, marker + inner + marker,
        start + marker.length, start + marker.length + inner.length, 'format');
    }
  }

  /** Cycle heading level on the caret line: text → # → ## → ### → text. */
  cycleHeading() {
    const sel = this._selOffsets(); if (!sel) return;
    const { lineIdx, lineStart } = this._lineAt(sel.start);
    const line = this.lines[lineIdx];
    const m = /^(#{1,6})\s+/.exec(line);
    let repl;
    if (!m) repl = '# ' + line;
    else if (m[1].length >= 3) repl = line.slice(m[0].length);
    else repl = '#' + line;
    const delta = repl.length - line.length;
    this._applyEdit(lineStart, lineStart + line.length, repl,
      Math.max(lineStart, sel.start + delta), Math.max(lineStart, sel.start + delta), 'format');
  }

  /** Toggle a line prefix on every line the selection touches. */
  toggleLinePrefix(kind /* 'bullet' | 'ordered' | 'task' | 'quote' */) {
    const sel = this._selOffsets(); if (!sel) return;
    const a = this._lineAt(sel.start).lineIdx;
    const b = this._lineAt(sel.end).lineIdx;
    const src = this.lines.slice(a, b + 1);
    // Blank lines don't vote — and a lone blank line must GAIN the prefix,
    // not count as "already prefixed" and strip to nothing.
    const nonBlank = src.filter(l => l.trim());
    const all = nonBlank.length > 0 && nonBlank.every(l => this._hasPrefix(l, kind));
    const out = src.map((l, i) => {
      if (!l.trim() && src.length > 1) return l;
      return all ? this._stripPrefix(l, kind) : this._addPrefix(this._stripAnyPrefix(l), kind, i);
    });
    const start = this._lineStart(a);
    const end = this._lineStart(b) + this.lines[b].length;
    const repl = out.join('\n');
    this._applyEdit(start, end, repl, start, start + repl.length, 'format');
  }

  _hasPrefix(l, kind) {
    if (kind === 'bullet') return /^\s*[-*+]\s+(?!\[[ xX]\]\s)/.test(l);
    if (kind === 'ordered') return /^\s*\d{1,9}[.)]\s+/.test(l);
    if (kind === 'task') return /^\s*[-*+]\s+\[[ xX]\]\s/.test(l);
    if (kind === 'quote') return /^\s*>/.test(l);
    return false;
  }

  _stripPrefix(l, kind) {
    if (kind === 'quote') return l.replace(/^(\s*)(?:>\s?)+/, '$1');
    if (kind === 'task') return l.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, '$1');
    return l.replace(/^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/, '$1');
  }

  _stripAnyPrefix(l) {
    return l
      .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, '$1')
      .replace(/^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/, '$1')
      .replace(/^(\s*)(?:>\s?)+/, '$1');
  }

  _addPrefix(l, kind, i) {
    const m = /^(\s*)([\s\S]*)$/.exec(l);
    if (kind === 'bullet') return `${m[1]}- ${m[2]}`;
    if (kind === 'ordered') return `${m[1]}${i + 1}. ${m[2]}`;
    if (kind === 'task') return `${m[1]}- [ ] ${m[2]}`;
    if (kind === 'quote') return `${m[1]}> ${m[2]}`;
    return l;
  }

  /** Indent / outdent the selected list lines (or insert spaces outside lists). */
  shiftIndent(dir /* +1 | -1 */) {
    const sel = this._selOffsets(); if (!sel) return;
    const a = this._lineAt(sel.start).lineIdx;
    const b = this._lineAt(sel.end).lineIdx;
    const listish = (l) => /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(l) || /^\s*>/.test(l);
    if (dir > 0 && a === b && sel.start === sel.end && !listish(this.lines[a])) {
      this._applyEdit(sel.start, sel.end, '  ', sel.start + 2, sel.start + 2, 'type');
      return;
    }
    const out = [];
    for (let i = a; i <= b; i++) {
      const l = this.lines[i];
      out.push(dir > 0 ? '  ' + l : l.replace(/^ {1,2}|^\t/, ''));
    }
    const start = this._lineStart(a);
    const end = this._lineStart(b) + this.lines[b].length;
    const repl = out.join('\n');
    this._applyEdit(start, end, repl, start, start + repl.length, 'format');
  }

  /**
   * Indent (+1) / outdent (-1) lines [a,b] directly — no DOM selection needed.
   * The swipe gesture calls this: unlike shiftIndent it must work while the
   * editor is unfocused WITHOUT restoring a selection afterwards (programmatic
   * selection focuses the contenteditable, which would pop the iOS keyboard
   * mid-swipe).  When focused, the caret rides along with the shifted text.
   * `coalesce` skips the undo snapshot so a multi-level swipe is one undo step
   * (the caller sets it after its first committed level).
   * Returns true if any line actually changed.
   */
  indentLines(a, b, dir, { coalesce = false } = {}) {
    a = Math.max(0, Math.min(a, this.lines.length - 1));
    b = Math.max(a, Math.min(b, this.lines.length - 1));
    const next = [];
    const deltas = [];
    let changed = false;
    for (let i = a; i <= b; i++) {
      const l = this.lines[i];
      const nl = dir > 0 ? '  ' + l : l.replace(/^ {1,2}|^\t/, '');
      next.push(nl);
      deltas.push(nl.length - l.length);
      if (nl !== l) changed = true;
    }
    if (!changed) return false;
    const focused = document.activeElement === this.root;
    const sel = focused ? this._selOffsets() : null;
    // Shift caret offsets by the per-line prefix deltas (an outdent never pulls
    // an offset past the start of its own line).
    const adj = (off) => {
      const { lineIdx, col } = this._lineAt(off);
      let n = off;
      for (let i = a; i <= Math.min(b, lineIdx - 1); i++) n += deltas[i - a];
      if (lineIdx >= a && lineIdx <= b) n += Math.max(deltas[lineIdx - a], -col);
      return n;
    };
    const selAfter = sel && { start: adj(sel.start), end: adj(sel.end) };
    if (!coalesce) this._pushUndo('format');
    this._lastUndoKind = 'format';
    for (let i = a; i <= b; i++) this.lines[i] = next[i - a];
    this._render();
    if (selAfter) this._setSelOffsets(selAfter.start, selAfter.end);
    this.onChange();
    this._notifySlash();
    return true;
  }

  /** Toggle the [ ]/[x] state of the task item on the caret line. */
  toggleTask() {
    const sel = this._selOffsets(); if (!sel) return;
    const { lineIdx, lineStart } = this._lineAt(sel.start);
    const line = this.lines[lineIdx];
    const m = /^(\s*[-*+]\s+\[)([ xX])(\])/.exec(line);
    if (!m) { this.toggleLinePrefix('task'); return; }
    const pos = lineStart + m[1].length;
    this._applyEdit(pos, pos + 1, m[2] === ' ' ? 'x' : ' ', sel.start, sel.end, 'format');
  }

  /** Insert a Markdown link around the selection (or an empty template). */
  insertLink() {
    const sel = this._selOffsets(); if (!sel) return;
    const text = this.getValue();
    const inner = text.slice(sel.start, sel.end);
    const repl = `[${inner}](url)`;
    const urlAt = sel.start + 1 + inner.length + 2;
    this._applyEdit(sel.start, sel.end, repl, urlAt, urlAt + 3, 'format');
  }

  undo() { this._history(this._undo, this._redo); }
  redo() { this._history(this._redo, this._undo); }

  // -------------------------------------------------------------------------
  // Model editing core
  // -------------------------------------------------------------------------

  /** Replace [start,end) of the document with `insert`; set selection; render.
   *  undoKind 'none' skips the undo snapshot (the slash menu's query-removal —
   *  recording it would make the menu's own Undo action restore the query). */
  _applyEdit(start, end, insert, selStart, selEnd, undoKind) {
    if (undoKind !== 'none') this._pushUndo(undoKind);
    const text = this.getValue();
    const next = text.slice(0, start) + insert + text.slice(end);
    this.lines = next.split('\n');
    this._render();
    this._setSelOffsets(selStart, selEnd ?? selStart);
    this.onChange();
    this._notifySlash();
  }

  _pushUndo(kind) {
    const now = Date.now();
    if (kind === 'type' && this._lastUndoKind === 'type' && now - this._lastUndoAt < UNDO_COALESCE_MS) {
      this._lastUndoAt = now;
      return;
    }
    const sel = this._selOffsets() || { start: 0, end: 0 };
    this._undo.push({ text: this.getValue(), sel });
    if (this._undo.length > UNDO_LIMIT) this._undo.shift();
    this._redo.length = 0;
    this._lastUndoAt = now;
    this._lastUndoKind = kind;
  }

  _history(from, to) {
    if (!from.length) return;
    const sel = this._selOffsets() || { start: 0, end: 0 };
    to.push({ text: this.getValue(), sel });
    const snap = from.pop();
    this.lines = snap.text.split('\n');
    this._lastUndoKind = null;
    this._render();
    this._setSelOffsets(snap.sel.start, snap.sel.end);
    this.onChange();
    this._notifySlash();
  }

  // -------------------------------------------------------------------------
  // Slash-command context
  //
  // The app's insertion menu opens when the caret sits right after a `/` that
  // was typed "correctly": at the start of a line or after whitespace (so
  // `and/or`, URLs and file paths never trigger), never on code / fence /
  // front-matter lines, never mid-composition, and only with a collapsed
  // caret.  Whatever [\w-]* follows the slash is the live filter query.
  // Recomputed after every edit AND caret move, so typing filters, and
  // backspacing the `/` (or tapping elsewhere) closes the menu naturally.
  // -------------------------------------------------------------------------

  /**
   * @returns {null | { start: number, caret: number, query: string, atLineStart: boolean }}
   *   start = offset of the `/`; [start, caret) is what the menu removes on pick.
   */
  slashContext() {
    if (this._composing) return null;
    const sel = this._selOffsets();
    if (!sel || sel.start !== sel.end) return null;
    const { lineIdx, col } = this._lineAt(sel.start);
    const type = this.infos[lineIdx]?.type;
    if (type === 'code' || type === 'fence' || type === 'fm' || type === 'fm-fence') return null;
    const before = this.lines[lineIdx].slice(0, col);
    const m = /(^|\s)\/([\w-]{0,24})$/.exec(before);
    if (!m) return null;
    const start = sel.start - m[2].length - 1;
    return {
      start,
      caret: sel.start,
      query: m[2],
      atLineStart: /^\s*$/.test(before.slice(0, before.length - m[2].length - 1)),
    };
  }

  _notifySlash() {
    this.onSlash?.(this.slashContext());
  }

  /** Viewport rect of the caret (falls back to its line's rect on empty lines). */
  caretRect() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(true);
    let rect = r.getClientRects()[0] || r.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      const div = this._lineDivOf(r.startContainer) ||
        (r.startContainer === this.root ? this.root.children[Math.min(r.startOffset, this.root.children.length - 1)] : null);
      rect = div?.getBoundingClientRect() || null;
    }
    return rect;
  }

  /** Replace the caret's whole line with `text`; caret lands at `caretRel` within it. */
  replaceCurrentLine(text, caretRel = text.length) {
    const sel = this._selOffsets(); if (!sel) return;
    const { lineIdx, lineStart } = this._lineAt(sel.start);
    const line = this.lines[lineIdx];
    this._applyEdit(lineStart, lineStart + line.length, text,
      lineStart + caretRel, lineStart + caretRel, 'format');
  }

  /** Set the caret line's heading level exactly (0 removes the heading). */
  setHeading(level) {
    const sel = this._selOffsets(); if (!sel) return;
    const { lineIdx, lineStart } = this._lineAt(sel.start);
    const line = this.lines[lineIdx];
    const rest = line.replace(/^#{1,6}\s+/, '');
    const repl = level > 0 ? '#'.repeat(level) + ' ' + rest : rest;
    this._applyEdit(lineStart, lineStart + line.length, repl,
      lineStart + repl.length, lineStart + repl.length, 'format');
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Sync the DOM to the model.  Only lines whose rendered HTML or class
   * changed are touched, so a keystroke normally re-renders exactly one div.
   * @param {boolean} full  force a full rebuild
   */
  _render(full = false) {
    this.infos = classifyDoc(this.lines);
    const kids = this.root.children;

    // Trim surplus line divs.
    while (kids.length > this.lines.length) this.root.lastElementChild.remove();

    for (let i = 0; i < this.lines.length; i++) {
      const info = this.infos[i];
      const html = renderLineHtml(this.lines[i], info) || '<br>';
      const cls = lineClass(info);
      const hang = info.hang ? `--hang:${info.hang}ch` : '';
      const key = cls + '\u0000' + hang + '\u0000' + html;

      let div = kids[i];
      if (!div) {
        div = document.createElement('div');
        this.root.appendChild(div);
      } else if (!full && this._cache[i] === key && div._wrKey === key) {
        continue;
      }
      div.className = cls;
      if (info.hang) div.style.setProperty('--hang', info.hang + 'ch');
      else div.style.removeProperty('--hang');
      div.innerHTML = html;
      div._wrKey = key;
      this._cache[i] = key;
    }
    this._cache.length = this.lines.length;
    if (this.focusMode) this._updateFocusPara();
  }

  // -------------------------------------------------------------------------
  // Selection ↔ absolute offsets
  // -------------------------------------------------------------------------

  _lineStart(idx) {
    let n = 0;
    for (let i = 0; i < idx; i++) n += this.lines[i].length + 1;
    return n;
  }

  _lineAt(offset) {
    let n = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const len = this.lines[i].length;
      if (offset <= n + len) return { lineIdx: i, lineStart: n, col: offset - n };
      n += len + 1;
    }
    const last = this.lines.length - 1;
    return { lineIdx: last, lineStart: this._lineStart(last), col: this.lines[last].length };
  }

  /** Find which top-level line div contains `node`. */
  _lineDivOf(node) {
    while (node && node !== this.root) {
      if (node.parentNode === this.root) return node.nodeType === 1 ? node : null;
      node = node.parentNode;
    }
    return null;
  }

  /** Current selection as absolute [start,end] offsets (null if outside editor). */
  _selOffsets() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.startContainer)) return null;
    const point = (node, off) => {
      if (node === this.root) {
        // Selection at root level: resolve to start of the off-th line.
        let n = 0;
        const idx = Math.min(off, this.root.children.length);
        for (let i = 0; i < idx; i++) n += (this.root.children[i].textContent || '').length + 1;
        return n;
      }
      const div = this._lineDivOf(node);
      if (!div) return 0;
      let base = 0;
      for (let el = this.root.firstElementChild; el && el !== div; el = el.nextElementSibling) {
        base += (el.textContent || '').length + 1;
      }
      const r = document.createRange();
      r.selectNodeContents(div);
      try { r.setEnd(node, off); } catch { return base; }
      return base + r.toString().length;
    };
    return {
      start: point(range.startContainer, range.startOffset),
      end: point(range.endContainer, range.endOffset),
    };
  }

  _setSelOffsets(start, end = start) {
    const place = (offset) => {
      const { lineIdx, col } = this._lineAt(Math.max(0, Math.min(offset, this.getValue().length)));
      const div = this.root.children[lineIdx];
      if (!div) return { node: this.root, off: 0 };
      // Walk text nodes accumulating length until we reach col.
      const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      let acc = 0;
      let node;
      while ((node = walker.nextNode())) {
        const len = node.nodeValue.length;
        if (col <= acc + len) return { node, off: col - acc };
        acc += len;
      }
      return { node: div, off: div.childNodes.length };
    };
    const a = place(start);
    const b = start === end ? a : place(end);
    const sel = window.getSelection();
    const range = document.createRange();
    try {
      range.setStart(a.node, a.off);
      range.setEnd(b.node, b.off);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* stale nodes — next interaction re-establishes */ }
  }

  // -------------------------------------------------------------------------
  // DOM → model reconciliation (after native edits)
  // -------------------------------------------------------------------------

  /** Extract the document text back out of the (possibly browser-mangled) DOM. */
  _extractLines() {
    const out = [];
    const pushBlock = (el) => {
      // A block the browser nested (rare — we intercept Enter) flattens to lines.
      const nested = el.querySelectorAll(':scope > div');
      if (nested.length && el.childNodes.length === nested.length) {
        for (const child of nested) pushBlock(child);
      } else {
        // NBSP: contenteditable swaps trailing/consecutive spaces for &nbsp;.
        out.push((el.textContent || '').replace(/\u00A0/g, ' '));
      }
    };
    for (const node of this.root.childNodes) {
      if (node.nodeType === 1) pushBlock(node);
      else if (node.nodeType === 3 && node.nodeValue) {
        // Stray root-level text (shouldn't happen, but never lose input).
        out.push(node.nodeValue.replace(/\u00A0/g, ' '));
      }
    }
    return out.length ? out : [''];
  }

  _reconcile() {
    if (this._composing) { this._pendingReconcile = true; return; }
    const domLines = this._extractLines();
    const old = this.lines;

    // Cheap equality fast-path.
    if (domLines.length === old.length && domLines.every((l, i) => l === old[i])) return;

    this._pushUndo('type');
    // The undo snapshot must be the PRE-edit text, but _pushUndo reads
    // this.lines via getValue() — which is still the old model here. Good.
    const sel = this._selOffsetsFromDom(domLines);
    this.lines = domLines;
    this._render();
    if (sel) this._setSelOffsets(sel.start, sel.end);
    this.onChange();
    this._notifySlash();
  }

  /** Selection offsets measured against the freshly-extracted DOM lines. */
  _selOffsetsFromDom(domLines) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.startContainer)) return null;
    const point = (node, off) => {
      const div = this._lineDivOf(node);
      if (!div) return 0;
      let idx = 0;
      for (let el = this.root.firstElementChild; el && el !== div; el = el.nextElementSibling) idx++;
      let base = 0;
      for (let i = 0; i < idx && i < domLines.length; i++) base += domLines[i].length + 1;
      const r = document.createRange();
      r.selectNodeContents(div);
      try { r.setEnd(node, off); } catch { return base; }
      // NBSP normalisation shifts nothing (1:1 replacement).
      return base + r.toString().length;
    };
    return { start: point(range.startContainer, range.startOffset), end: point(range.endContainer, range.endOffset) };
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  _bind() {
    this.root.addEventListener('beforeinput', (e) => this._onBeforeInput(e));
    this.root.addEventListener('input', (e) => {
      // Everything we didn't preventDefault lands here after the browser edit.
      if (e.isComposing) { this._pendingReconcile = true; return; }
      this._reconcile();
    });
    this.root.addEventListener('compositionstart', () => { this._composing = true; });
    this.root.addEventListener('compositionend', () => {
      this._composing = false;
      // Give WebKit a beat to settle the composed text before we touch the DOM.
      requestAnimationFrame(() => { if (!this._composing) this._reconcile(); });
    });
    this.root.addEventListener('keydown', (e) => this._onKeydown(e));
    this.root.addEventListener('paste', (e) => {
      // Safety net for browsers that fire paste without insertFromPaste.
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') ?? '';
      this._insertPlainText(text);
    });
    this.root.addEventListener('drop', (e) => e.preventDefault());
    document.addEventListener('selectionchange', () => {
      if (document.activeElement !== this.root) return;
      if (this.focusMode) this._updateFocusPara();
      // Caret moves without an edit must also open/close the slash menu.
      this._notifySlash();
    });
    this.root.addEventListener('blur', () => this.onSlash?.(null));
    this._bindSwipe();
  }

  // -------------------------------------------------------------------------
  // Swipe indent — the iOS-Notes gesture, for touch devices
  //
  // One-finger horizontal drag on a list/quote line: right = indent, left =
  // outdent.  Vertical-first movement is a scroll and cancels the gesture; a
  // plain tap has no movement, so caret placement is untouched (touchstart
  // stays passive).  The drag never slides freely: once latched, the line
  // snaps between 2ch DETENTS — the indent grid itself, since one level is
  // two spaces in a monospaced editor — with one detent per STEP px of drag,
  // clamped so an impossible outdent never previews.  Nothing is edited while
  // the finger is down; the whole preview lands as ONE edit (one undo step)
  // on release, and because translateX(2ch·level) is exactly where the
  // re-indented text renders, swapping the transform for the real edit is
  // pixel-identical — no jump.  A multi-line selection that includes the
  // touched line swipes as a block.  Uses `infos[].type` as the gate, so a
  // `- item` inside a code fence or front matter never triggers.
  //
  // Yielding to iOS text interactions (the swipe must NEVER win these):
  //   • a touch starting on/near the caret is a CARET DRAG — never armed;
  //   • a touch near either END of a selection is a selection-HANDLE drag —
  //     never armed (the middle of a selection still block-swipes);
  //   • a swipe is a FLICK: if the finger hasn't latched within LATCH_MS it's
  //     a long-press (loupe / word-select) — abandoned;
  //   • iOS moving the selection mid-gesture (long-press select, autocorrect
  //     bubble…) cancels an unlatched gesture — once latched we preventDefault
  //     so the two can't interleave.
  // -------------------------------------------------------------------------

  _bindSwipe() {
    const LATCH = 16;     // px of horizontal travel before the gesture claims the touch
    const STEP = 48;      // px of drag per detent (indent level)
    const MAXLVL = 6;     // sanity cap on preview levels per drag
    const LATCH_MS = 300; // must latch this soon after touchstart — slower = long-press
    const NEAR = 32;      // px around the caret / selection handles that never swipes
    const SWIPABLE = new Set(['bullet', 'ordered', 'task', 'quote']);
    let sw = null;

    // iOS changing the selection under an unlatched gesture (long-press
    // word-select, caret placement…) means the touch belongs to the text
    // system, not to us.
    document.addEventListener('selectionchange', () => {
      if (sw && !sw.latched) sw = null;
    });

    const near = (t, rect) =>
      rect && t.clientX > rect.left - NEAR && t.clientX < rect.right + NEAR &&
      t.clientY > rect.top - NEAR / 2 && t.clientY < rect.bottom + NEAR / 2;

    this.root.addEventListener('touchstart', (e) => {
      sw = null;
      if (e.touches.length !== 1 || this._composing) return;
      const t = e.touches[0];
      let div = this._lineDivOf(e.target);
      if (!div) {
        const el = document.elementFromPoint(t.clientX, t.clientY);
        div = el && this._lineDivOf(el);
      }
      if (!div) return;
      const idx = Array.prototype.indexOf.call(this.root.children, div);
      if (idx < 0 || idx >= this.lines.length) return;
      // A selection spanning the touched line swipes as one block.
      let a = idx, b = idx;
      const sel = this._selOffsets();
      const focused = document.activeElement === this.root;
      if (sel && sel.start !== sel.end) {
        const la = this._lineAt(sel.start).lineIdx;
        const lb = this._lineAt(sel.end).lineIdx;
        if (idx >= la && idx <= lb) { a = la; b = lb; }
      }
      // Yield to the iOS text system: a touch on the caret is a caret drag,
      // a touch near a selection endpoint is a handle drag.
      if (focused) {
        const domSel = window.getSelection();
        if (domSel && domSel.rangeCount) {
          const range = domSel.getRangeAt(0);
          if (range.collapsed) {
            if (near(t, this.caretRect())) return;
          } else {
            const rects = range.getClientRects();
            if (rects.length && (near(t, rects[0]) && t.clientX < rects[0].left + NEAR
              || near(t, rects[rects.length - 1]) && t.clientX > rects[rects.length - 1].right - NEAR)) return;
          }
        }
      }
      let anySwipable = false;
      // Outdent detents are bounded by what the leading whitespace can give up
      // (the most any affected line can, so a lone line previews exactly).
      let maxOut = 0;
      for (let i = a; i <= b; i++) {
        if (SWIPABLE.has(this.infos[i]?.type)) anySwipable = true;
        let lead = /^[ \t]*/.exec(this.lines[i])[0];
        let n = 0;
        while (lead) { lead = lead.replace(/^ {1,2}|^\t/, ''); n++; }
        maxOut = Math.max(maxOut, n);
      }
      if (!anySwipable) return;
      sw = {
        id: t.identifier, x0: t.clientX, y0: t.clientY, t0: performance.now(), a, b, maxOut,
        divs: Array.prototype.slice.call(this.root.children, a, b + 1),
        // Any edit replaces this.lines (autocorrect commit, composition…) —
        // the captured indexes would then point at the WRONG lines, so the
        // gesture dies with the model it was aimed at.
        linesRef: this.lines,
        latched: false, level: 0,
      };
    }, { passive: true });

    this.root.addEventListener('touchmove', (e) => {
      if (!sw) return;
      let t = null;
      for (const x of e.touches) if (x.identifier === sw.id) t = x;
      if (!t) return;
      const dx = t.clientX - sw.x0;
      const dy = t.clientY - sw.y0;
      if (sw.linesRef !== this.lines) {   // the document changed under the gesture
        for (const d of sw.divs) d.style.transform = '';
        sw = null;
        return;
      }
      if (!sw.latched) {
        // A swipe is a flick — a touch still unlatched after LATCH_MS is a
        // long-press (selection loupe), not an indent.
        if (performance.now() - sw.t0 > LATCH_MS) { sw = null; return; }
        if (Math.abs(dy) > LATCH && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }  // it's a scroll
        if (Math.abs(dx) < LATCH || Math.abs(dx) < 2 * Math.abs(dy)) return;
        sw.latched = true;
      }
      e.preventDefault();
      const lvl = Math.max(-sw.maxOut, Math.min(MAXLVL, Math.round(dx / STEP)));
      if (lvl !== sw.level) {
        sw.level = lvl;
        // .wr-line's transform transition animates the snap between detents.
        for (const d of sw.divs) d.style.transform = lvl ? `translateX(${lvl * 2}ch)` : '';
      }
    }, { passive: false });

    const end = (commit) => {
      if (!sw) return;
      const { a, b, level, divs } = sw;
      const stale = sw.linesRef !== this.lines;
      sw = null;
      if (commit && level && !stale) {
        // The preview already sits at the final text position: clear the
        // transform transition-less in the same frame the edit re-renders.
        for (const d of divs) { d.style.transition = 'none'; d.style.transform = ''; }
        const dir = level > 0 ? 1 : -1;
        for (let i = 0; i < Math.abs(level); i++) this.indentLines(a, b, dir, { coalesce: i > 0 });
        requestAnimationFrame(() => { for (const d of divs) d.style.transition = ''; });
      } else {
        for (const d of divs) d.style.transform = '';   // animated snap home
      }
    };
    this.root.addEventListener('touchend', () => end(true));
    this.root.addEventListener('touchcancel', () => end(false));
  }

  _onBeforeInput(e) {
    switch (e.inputType) {
      case 'insertParagraph':
        e.preventDefault();
        this._insertNewline(true);
        return;
      case 'insertLineBreak':
        e.preventDefault();
        this._insertNewline(false);
        return;
      case 'historyUndo':
        e.preventDefault();
        this.undo();
        return;
      case 'historyRedo':
        e.preventDefault();
        this.redo();
        return;
      case 'insertFromPaste':
      case 'insertFromDrop': {
        e.preventDefault();
        const text = e.dataTransfer?.getData('text/plain') ?? '';
        this._insertPlainText(text);
        return;
      }
      case 'formatBold':
        e.preventDefault();
        this.wrapSelection('**');
        return;
      case 'formatItalic':
        e.preventDefault();
        this.wrapSelection('*');
        return;
      case 'insertText':
        // Multi-line insertText (rare; some IMEs/autofill) → handle ourselves.
        if (e.data && e.data.includes('\n')) {
          e.preventDefault();
          this._insertPlainText(e.data);
        }
        return;
      default:
        // deleteContentBackward/Forward, insertText, insertCompositionText,
        // insertReplacementText (iOS autocorrect), deleteByCut … run natively
        // and are reconciled in the input handler.
    }
  }

  _onKeydown(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Tab' && !mod) {
      e.preventDefault();
      this.shiftIndent(e.shiftKey ? -1 : 1);
      return;
    }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (k === 'y') { e.preventDefault(); this.redo(); return; }
      if (k === 'b') { e.preventDefault(); this.wrapSelection('**'); return; }
      if (k === 'i') { e.preventDefault(); this.wrapSelection('*'); return; }
      if (k === 'k') { e.preventDefault(); this.insertLink(); return; }
    }
  }

  _insertPlainText(text) {
    const sel = this._selOffsets(); if (!sel) return;
    const clean = String(text).replace(/\r\n?/g, '\n');
    this._applyEdit(sel.start, sel.end, clean, sel.start + clean.length, sel.start + clean.length, 'paste');
  }

  /**
   * Enter behaviour.  `smart` (plain Enter) continues list/quote context:
   *   "- abc<Enter>"      → "- "     (same indent, same marker)
   *   "3. abc<Enter>"     → "4. "
   *   "- [x] abc<Enter>"  → "- [ ] "
   *   "> abc<Enter>"      → "> "
   *   "- <Enter>" (empty item) → removes the prefix (exits the list)
   * Shift+Enter inserts a bare newline.
   */
  _insertNewline(smart) {
    const sel = this._selOffsets(); if (!sel) return;
    const { lineIdx, lineStart, col } = this._lineAt(sel.start);
    const line = this.lines[lineIdx];

    if (smart) {
      const bullet = /^(\s*)([-*+])(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line);
      const ordered = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/.exec(line);
      const quote = /^(\s*(?:>\s?)+)(.*)$/.exec(line);

      let prefix = null;
      let content = null;
      if (bullet) {
        prefix = bullet[1] + bullet[2] + bullet[3] + (bullet[4] ? '[ ] ' : '');
        content = bullet[5];
      } else if (ordered) {
        prefix = ordered[1] + (parseInt(ordered[2], 10) + 1) + ordered[3] + ordered[4];
        content = ordered[5];
      } else if (quote) {
        prefix = quote[1];
        content = quote[2];
      }

      if (prefix !== null) {
        const contentStart = line.length - content.length;
        if (!content.trim() && col >= contentStart && sel.start === sel.end) {
          // Empty item: Enter exits the list — the prefix is removed.
          this._applyEdit(lineStart, lineStart + line.length, '', lineStart, lineStart, 'line');
          return;
        }
        if (col >= contentStart) {
          const insert = '\n' + prefix;
          this._applyEdit(sel.start, sel.end, insert, sel.start + insert.length, sel.start + insert.length, 'line');
          return;
        }
        // Caret inside the marker itself → plain split.
      }
    }
    this._applyEdit(sel.start, sel.end, '\n', sel.start + 1, sel.start + 1, 'line');
  }

  // -------------------------------------------------------------------------
  // Focus mode — dim everything but the caret's paragraph
  // -------------------------------------------------------------------------

  _updateFocusPara() {
    if (!this.focusMode) {
      for (const el of this.root.children) el.classList.remove('wr-away');
      return;
    }
    const sel = this._selOffsets();
    let a = 0, b = this.lines.length - 1;
    if (sel) {
      const idx = this._lineAt(sel.start).lineIdx;
      a = idx; b = idx;
      while (a > 0 && this.lines[a - 1].trim()) a--;
      while (b < this.lines.length - 1 && this.lines[b + 1].trim()) b++;
    }
    const kids = this.root.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('wr-away', i < a || i > b);
    }
  }
}
