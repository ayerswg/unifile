/**
 * Inline comments for the shared custom editor (uPub + uDraft) — the same
 * model and the same manners as the standard shell's `ui/comments.js`:
 *
 *   • Data: `data.commentThreads = { [id]: { id, from, to, createdAtHash,
 *     archived, orphaned, messages: [{ id, author, text, timestamp }] } }` —
 *     absolute char offsets into the document text, so a `.unifile.json`
 *     round-trips its comments between {write}/{draft} and the CodeMirror apps.
 *   • Look: every open thread's text carries a persistent soft highlight.
 *     The editor's hard invariant is textContent(line div) === source line, so
 *     the highlights are NOT spans in the text: they're rects in an OVERLAY
 *     layer under the editor (measured with Range.getClientRects, redrawn on
 *     every edit / resize), exactly how a browser draws its own selection.
 *   • Add: select text → long-press it (phones) or right-click (desktop) →
 *     "Comment" → a CARD opens attached below the selection (positioned in the
 *     sheet, so it scrolls with the text).  A tap on commented text opens its
 *     thread.  Esc / tap elsewhere / editing closes the card.
 *   • Ranges follow the text: the editor's `onEdit({from,to,insertLen})`
 *     reports each change as one replaced span and `mapEdit` moves every
 *     thread like CodeMirror's position mapping would (from sticks right,
 *     to sticks left); a thread whose text is deleted resolves itself, a
 *     thread whose text is replaced wholesale (iOS autocorrect) re-anchors
 *     onto the replacement.
 *   • The "Comments" sheet (`openSheet`) lists open threads (tap → jump) and
 *     the resolved ones.
 */

const LONG_PRESS_MS = 480;
const SLOP = 8;

export class UPubComments {
  /**
   * @param {object} o
   * @param {import('./editor.js').UPubEditor} o.editor
   * @param {HTMLElement} o.sheet       #wr-sheet — the layer and the card live in it
   * @param {HTMLElement} o.scroller    #wr-scroll
   * @param {() => object} o.getData    the app's data object (threads are read / written on it)
   * @param {() => string} o.author     display name for new messages
   * @param {() => string} o.headHash   the VCS head (recorded on new threads)
   * @param {() => void}   o.onChange   persist + redraw hook (called after every mutation)
   * @param {(html:string, cls?:string) => HTMLElement} o.openSheet  the app's bottom sheet
   * @param {() => void}   o.closeSheet
   */
  constructor(o) {
    this.editor = o.editor;
    this.sheet = o.sheet;
    this.scroller = o.scroller;
    this.getData = o.getData;
    this.author = o.author;
    this.headHash = o.headHash;
    this.onChange = o.onChange || (() => {});
    this.openSheet = o.openSheet;
    this.closeSheet = o.closeSheet;

    this.layer = document.createElement('div');
    this.layer.className = 'wr-comment-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.sheet.insertBefore(this.layer, this.sheet.firstChild);

    this.card = null;           // { el, threadId|null, range }
    this._menu = null;
    this._raf = 0;
    this._bind();
    this.refresh();
  }

  // ── data ─────────────────────────────────────────────────────────────────

  _threads() {
    const data = this.getData();
    data.commentThreads ??= {};
    return data.commentThreads;
  }

  listOpen() {
    return Object.values(this._threads())
      .filter(t => !t.archived && t.from !== undefined)
      .sort((a, b) => a.from - b.from || a.to - b.to);
  }

  threadsAt(pos) {
    return this.listOpen().filter(t => t.from === t.to ? t.from === pos : (t.from <= pos && t.to > pos));
  }

  threadsIn(from, to) {
    return this.listOpen().filter(t => (t.from < to && t.to > from) || (t.from === t.to && t.from >= from && t.from <= to));
  }

  _id(p) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

  startThread(from, to, text) {
    const id = this._id('t');
    this._threads()[id] = {
      id, from, to, createdAtHash: this.headHash?.() ?? null, archived: false, orphaned: false,
      messages: [{ id: this._id('m'), author: this.author(), text, timestamp: Date.now() }]
    };
    this.onChange();
    return id;
  }

  reply(id, text) {
    const t = this._threads()[id];
    if (!t) return;
    t.messages.push({ id: this._id('m'), author: this.author(), text, timestamp: Date.now() });
    this.onChange();
  }

  resolve(id) {
    const t = this._threads()[id];
    if (!t) return;
    t.archived = true;
    this.onChange();
  }

  /**
   * Map every open thread through one replaced span [from, to) → insertLen
   * chars (the editor's onEdit).  Call BEFORE redrawing.
   */
  mapEdit({ from, to, insertLen }) {
    const delta = insertLen - (to - from);
    let changed = false;
    for (const t of Object.values(this._threads())) {
      if (t.archived || t.from === undefined) continue;
      let nf, nt;
      if (t.from < t.to && from === t.from && to === t.to && insertLen > 0) {
        // The whole commented text was replaced (autocorrect): follow it.
        nf = from; nt = from + insertLen;
      } else {
        nf = t.from < from ? t.from : t.from <= to ? from + insertLen : t.from + delta;   // assoc +1
        nt = t.to <= from ? t.to : t.to <= to ? from : t.to + delta;                      // assoc −1
        if (nt < nf) nt = nf;
      }
      if (t.from < t.to && nf >= nt) { t.archived = true; t.from = nf; t.to = nf; changed = true; }
      else if (nf !== t.from || nt !== t.to) { t.from = nf; t.to = nt; changed = true; }
    }
    if (this.card?.threadId && this._threads()[this.card.threadId]?.archived) this.close();
    return changed;
  }

  /** The document changed under us as a whole (load / restore): keep offsets, clamp. */
  clamp() {
    const len = this.editor.getValue().length;
    for (const t of Object.values(this._threads())) {
      if (t.from === undefined) continue;
      t.from = Math.min(t.from, len); t.to = Math.min(Math.max(t.to, t.from), len);
    }
    this.close();
    this.refresh();
  }

  // ── drawing ──────────────────────────────────────────────────────────────

  /** Redraw the highlight layer (and re-place the card) on the next frame. */
  refresh() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _draw() {
    const threads = this.listOpen();
    const sheetRect = this.sheet.getBoundingClientRect();
    const frag = document.createDocumentFragment();
    const activeId = this.card?.threadId ?? null;
    const pending = this.card && !this.card.threadId ? this.card.range : null;
    const paint = (from, to, cls) => {
      const range = this.editor.domRange(from, Math.max(to, from));
      if (!range) return;
      if (from === to) {
        // A point comment (no range): a thin marker at the position.
        const r = range.getBoundingClientRect();
        const m = document.createElement('div');
        m.className = 'wr-comment-rect wr-comment-point' + cls;
        m.style.cssText = `left:${r.left - sheetRect.left - 2}px;top:${r.top - sheetRect.top}px;width:4px;height:${r.height}px`;
        frag.appendChild(m);
        return;
      }
      for (const r of range.getClientRects()) {
        if (!r.width && !r.height) continue;
        const d = document.createElement('div');
        d.className = 'wr-comment-rect' + cls;
        d.style.cssText = `left:${r.left - sheetRect.left}px;top:${r.top - sheetRect.top}px;width:${Math.max(r.width, 2)}px;height:${r.height}px`;
        frag.appendChild(d);
      }
    };
    for (const t of threads) paint(t.from, t.to, t.id === activeId ? ' active' : '');
    if (pending) paint(pending.from, pending.to, ' active');
    this.layer.replaceChildren(frag);
    this._placeCard();
  }

  // ── the card ─────────────────────────────────────────────────────────────

  /** Open the composer on `range`, or (threadId) an existing thread. */
  open({ threadId = null, range = null } = {}) {
    this._hideMenu();
    if (threadId) {
      const t = this._threads()[threadId];
      if (!t || t.archived) return;
      range = { from: t.from, to: t.to };
    }
    if (!range) return;
    this.close();
    const el = document.createElement('div');
    el.className = 'wr-comment-card';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Comment');
    // Interacting with the card must never move the editor's caret / close us.
    for (const ev of ['pointerdown', 'mousedown', 'touchstart', 'click']) {
      el.addEventListener(ev, (e) => e.stopPropagation(), { passive: ev === 'touchstart' });
    }
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); } });
    this.sheet.appendChild(el);
    this.card = { el, threadId, range };
    this._renderCard();
    this.refresh();
    if (!threadId) requestAnimationFrame(() => el.querySelector('textarea')?.focus());
  }

  close() {
    if (!this.card) return;
    this.card.el.remove();
    this.card = null;
    this.refresh();
  }

  _renderCard() {
    const { el, threadId, range } = this.card;
    const t = threadId ? this._threads()[threadId] : null;
    const text = this.editor.getValue();
    let excerpt = range.from < range.to ? text.slice(range.from, Math.min(range.to, range.from + 200)).split('\n')[0].trim() : '';
    if (excerpt.length > 60 || range.to - range.from > excerpt.length) excerpt = excerpt.slice(0, 60) + '…';
    el.innerHTML = `
      <div class="wcc-head">
        <span class="wcc-excerpt">${excerpt ? `“${esc(excerpt)}”` : '<em>this line</em>'}</span>
        <button class="wcc-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="wcc-body">
        ${t ? `<div class="wcc-messages">${t.messages.map(m => `
          <div class="wcc-msg">
            <div class="wcc-meta"><span class="wcc-author">${esc(m.author)}</span><span class="wcc-when">${relative(m.timestamp)}</span></div>
            <div class="wcc-text">${esc(m.text)}</div>
          </div>`).join('')}</div>` : ''}
        <div class="wcc-form${t ? ' wcc-reply' : ''}">
          <textarea class="wcc-input" rows="${t ? 1 : 2}" placeholder="${t ? 'Reply…' : 'Comment…'}" aria-label="${t ? 'Reply' : 'Comment'}" enterkeyhint="send"></textarea>
          <div class="wcc-actions">
            ${t ? '<button class="wcc-btn wcc-resolve" type="button">Resolve</button>'
                : '<button class="wcc-btn wcc-cancel" type="button">Cancel</button>'}
            <button class="wcc-btn wcc-primary wcc-send" type="button">${t ? 'Reply' : 'Comment'}</button>
          </div>
        </div>
      </div>`;
    const ta = el.querySelector('.wcc-input');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.addEventListener('input', grow);
    requestAnimationFrame(grow);
    const send = () => {
      const msg = ta.value.trim();
      if (!msg) { ta.focus(); return; }
      if (t) { this.reply(t.id, msg); this._renderCard(); this.refresh(); }
      else {
        const id = this.startThread(range.from, range.to, msg);
        this.card.threadId = id;
        this._renderCard();
        this.refresh();
      }
    };
    el.querySelector('.wcc-send').addEventListener('click', send);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    });
    el.querySelector('.wcc-close').addEventListener('click', () => this.close());
    el.querySelector('.wcc-cancel')?.addEventListener('click', () => this.close());
    el.querySelector('.wcc-resolve')?.addEventListener('click', () => { this.resolve(t.id); this.close(); });
  }

  /** Put the card under the last line of its range, inside the sheet. */
  _placeCard() {
    if (!this.card) return;
    const { el, range } = this.card;
    const r = this.editor.domRange(range.from, Math.max(range.to, range.from));
    if (!r) return;
    const rects = r.getClientRects();
    const last = rects.length ? rects[rects.length - 1] : r.getBoundingClientRect();
    const first = rects.length ? rects[0] : last;
    const sheetRect = this.sheet.getBoundingClientRect();
    const width = Math.min(380, sheetRect.width - 8);
    let left = first.left - sheetRect.left;
    left = Math.max(4, Math.min(left, sheetRect.width - width - 4));
    el.style.width = width + 'px';
    el.style.left = left + 'px';
    el.style.top = (last.bottom - sheetRect.top + 6) + 'px';
  }

  // ── gestures ─────────────────────────────────────────────────────────────

  _bind() {
    const root = this.editor.root;

    // Tap/click on commented text (collapsed caret inside a range) → its card.
    // A tap elsewhere in the text closes the card.
    root.addEventListener('click', () => {
      if (this._menu) return;
      requestAnimationFrame(() => {
        const sel = this.editor.selection();
        if (!sel || sel.start !== sel.end) return;
        const hit = this.threadsAt(sel.start);
        if (hit.length) {
          if (this.card?.threadId !== hit[0].id) this.open({ threadId: hit[0].id });
        } else if (this.card) {
          this.close();
        }
      });
    });

    // Right-click on SELECTED text → our menu.  With no selection the native
    // menu stays (it carries the spell-check suggestions a writer needs).
    root.addEventListener('contextmenu', (e) => {
      const sel = this.editor.selection();
      if (!sel || sel.start === sel.end) return;
      e.preventDefault();
      this._showMenu(e.clientX, e.clientY, sel);
    });

    // Long-press on selected text (iOS fires no contextmenu).  Only inside an
    // existing selection — elsewhere the long-press is iOS's own select gesture.
    let press = null;
    const cancel = () => { if (press) { clearTimeout(press.timer); press = null; } };
    root.addEventListener('pointerdown', (e) => {
      cancel();
      if (e.pointerType === 'mouse') return;
      const sel = this.editor.selection();
      if (!sel || sel.start === sel.end) return;
      const r = this.editor.domRange(sel.start, sel.end);
      if (!r) return;
      let inside = false;
      for (const rect of r.getClientRects()) {
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) { inside = true; break; }
      }
      if (!inside) return;
      const x = e.clientX, y = e.clientY;
      press = { x, y, timer: setTimeout(() => {
        press = null;
        this._showMenu(x, y, sel);
        const stop = (ev) => ev.preventDefault();
        root.addEventListener('dragstart', stop, { once: true });
        setTimeout(() => root.removeEventListener('dragstart', stop), 1200);
      }, LONG_PRESS_MS) };
    });
    root.addEventListener('pointermove', (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) cancel(); });
    root.addEventListener('pointerup', cancel);
    root.addEventListener('pointercancel', cancel);
    document.addEventListener('selectionchange', () => { if (press) cancel(); });

    // Keyboard: Mod-Alt-M comments on the selection / word.
    root.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); this.commentSelection(); }
    });

    // Re-measure when the text reflows (viewport / keyboard / font load).
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.refresh()).observe(root);
    window.addEventListener('resize', () => this.refresh());
  }

  /** Comment on the selection, else the word at the caret, else the caret's line. */
  commentSelection() {
    const sel = this.editor.selection();
    if (!sel) return false;
    let range = sel.start < sel.end ? { from: sel.start, to: sel.end } : null;
    if (!range) {
      const existing = this.threadsAt(sel.start);
      if (existing.length) { this.open({ threadId: existing[0].id }); return true; }
      const w = this.editor.wordAt(sel.start);
      if (w) range = { from: w.start, to: w.end };
      else {
        const text = this.editor.getValue();
        let a = sel.start, b = sel.start;
        while (a > 0 && text[a - 1] !== '\n') a--;
        while (b < text.length && text[b] !== '\n') b++;
        range = { from: a, to: b };
      }
    }
    this.open({ range });
    return true;
  }

  _showMenu(x, y, sel) {
    this._hideMenu();
    const text = this.editor.getValue().slice(sel.start, sel.end);
    const items = [
      { label: 'Comment', glyph: '❝', run: () => this.open({ range: { from: sel.start, to: sel.end } }) },
      { label: 'Copy', run: () => navigator.clipboard?.writeText(text).catch(() => {}) },
      { label: 'Cut', run: () => {
        navigator.clipboard?.writeText(text).catch(() => {});
        this.editor._applyEdit(sel.start, sel.end, '', sel.start, sel.start, 'paste');
      } },
    ];
    const menu = document.createElement('div');
    menu.className = 'wr-ctx-menu';
    menu.setAttribute('role', 'menu');
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wr-ctx-item';
      b.innerHTML = `<span class="wr-ctx-glyph">${it.glyph ?? ''}</span><span></span>`;
      b.lastChild.textContent = it.label;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { this._hideMenu(); it.run(); });
      menu.appendChild(b);
    }
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    document.body.appendChild(menu);
    this._menu = menu;
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
    const dismiss = (e) => {
      if (menu.contains(e.target)) return;
      this._hideMenu();
    };
    this._dismiss = dismiss;
    setTimeout(() => {
      document.addEventListener('pointerdown', dismiss, true);
      document.addEventListener('keydown', dismiss, true);
    }, 0);
  }

  _hideMenu() {
    if (!this._menu) return;
    this._menu.remove();
    this._menu = null;
    document.removeEventListener('pointerdown', this._dismiss, true);
    document.removeEventListener('keydown', this._dismiss, true);
  }

  // ── the Comments sheet ───────────────────────────────────────────────────

  showSheet() {
    const all = Object.values(this._threads()).filter(t => t.from !== undefined);
    const open = this.listOpen();
    const done = all.filter(t => t.archived);
    const text = this.editor.getValue();
    const row = (t) => {
      const ex = t.from < t.to ? text.slice(t.from, Math.min(t.to, t.from + 80)).split('\n')[0] : '';
      const m = t.messages[0];
      return `<button class="wr-cmt-row" data-id="${esc(t.id)}" ${t.archived ? 'disabled' : ''}>
        <span class="wr-cmt-excerpt">${ex ? `“${esc(ex)}${t.to - t.from > ex.length ? '…' : ''}”` : '<em>line</em>'}</span>
        <span class="wr-cmt-text"><b>${esc(m?.author ?? '')}</b> ${esc(m?.text ?? '')}${t.messages.length > 1 ? ` <i>+${t.messages.length - 1}</i>` : ''}</span>
      </button>`;
    };
    const modal = this.openSheet(`
      <div class="wr-sheet-body wr-cmt-sheet">
        <h3>Comments</h3>
        ${open.length ? open.map(row).join('') : '<p class="wr-mut">No open comments. Select some text and long-press it (or right-click) to add one.</p>'}
        ${done.length ? `<h4>Resolved</h4>${done.map(row).join('')}` : ''}
      </div>`);
    modal.addEventListener('click', (e) => {
      const id = e.target.closest('.wr-cmt-row')?.dataset.id;
      if (!id) return;
      this.closeSheet();
      const t = this._threads()[id];
      if (!t) return;
      this.editor.setSelection(t.from, t.from);
      this.open({ threadId: id });
      requestAnimationFrame(() => this.card?.el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    });
  }
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relative(ts) {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
