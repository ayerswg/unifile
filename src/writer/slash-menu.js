/**
 * SlashMenu — the `/` insertion menu that replaced the bottom toolbar.
 *
 * The editor reports a slash context (editor.js slashContext(): a `/` typed at
 * line start or after whitespace, outside code/fences/front matter) after
 * every edit and caret move; the app opens/updates/closes this menu from that
 * signal, so filtering-while-typing, backspacing the `/`, and tapping away all
 * behave naturally without any extra bookkeeping here.
 *
 * Block items (heading, lists, code block, …) are only offered when the `/`
 * begins its line — inline items (bold, link, …) are offered everywhere.
 * Picking an item first deletes the `/query` text, then runs the action.
 *
 * Interaction: tap (touchstart is prevented so the editor keeps focus and the
 * iOS keyboard stays up), or ↑/↓ + Enter/Tab, Esc closes — the app routes
 * those keys here via handleKey() while the menu is open.
 */

export class SlashMenu {
  /**
   * @param {HTMLElement} host   positioned ancestor the menu is absolutely placed in
   * @param {object} opts
   * @param {Array}  opts.items  [{ id, label, hint?, block?, keywords? }]
   * @param {Function} opts.onPick  (item) => void
   */
  constructor(host, opts) {
    this.host = host;
    this.items = opts.items;
    this.onPick = opts.onPick;
    this.ctx = null;
    this._filtered = [];
    this._active = 0;

    this.el = document.createElement('div');
    this.el.id = 'wr-slash';
    this.el.setAttribute('role', 'listbox');
    this.el.hidden = true;
    host.appendChild(this.el);

    // Keep editor focus (and the soft keyboard) while picking.
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    this.el.addEventListener('touchstart', (e) => {
      const btn = e.target.closest('button[data-id]');
      if (btn) { e.preventDefault(); this._pick(btn.dataset.id); }
    }, { passive: false });
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-id]');
      if (btn) this._pick(btn.dataset.id);
    });
  }

  get isOpen() { return !this.el.hidden; }

  /** Open (or live-update) for a slash context; rect = caret viewport rect. */
  open(ctx, rect) {
    const q = ctx.query.toLowerCase();
    this._filtered = this.items.filter((it) => {
      if (it.block && !ctx.atLineStart) return false;
      if (!q) return true;
      const words = (it.label + ' ' + (it.keywords || '')).toLowerCase().split(/\s+/);
      return words.some(w => w.startsWith(q));
    });
    if (!this._filtered.length) { this.close(); return; }

    this.ctx = ctx;
    if (this._active >= this._filtered.length) this._active = 0;
    this._renderList();
    this.el.hidden = false;
    this._position(rect);
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.ctx = null;
    this._active = 0;
  }

  /** Route a keydown while open; returns true when the key was consumed. */
  handleKey(e) {
    if (!this.isOpen) return false;
    switch (e.key) {
      case 'ArrowDown':
        this._active = (this._active + 1) % this._filtered.length;
        this._renderList();
        return true;
      case 'ArrowUp':
        this._active = (this._active - 1 + this._filtered.length) % this._filtered.length;
        this._renderList();
        return true;
      case 'Enter':
      case 'Tab':
        this._pick(this._filtered[this._active].id);
        return true;
      case 'Escape':
        this.close();
        return true;
      default:
        return false;   // regular typing falls through and refines the filter
    }
  }

  _pick(id) {
    const item = this.items.find(i => i.id === id);
    const ctx = this.ctx;
    this.close();
    if (item && ctx) this.onPick(item, ctx);
  }

  _renderList() {
    this.el.innerHTML = this._filtered.map((it, i) => `
      <button data-id="${it.id}" role="option"
              class="${i === this._active ? 'active' : ''}" aria-selected="${i === this._active}">
        <span class="sl-label">${it.label}</span>
        ${it.hint ? `<span class="sl-hint">${it.hint}</span>` : ''}
      </button>`).join('');
    this.el.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  /** Place near the caret: below it, flipping above when there's no room. */
  _position(rect) {
    const hostRect = this.host.getBoundingClientRect();
    if (!rect) rect = hostRect;
    const menuH = Math.min(this.el.scrollHeight, 240);
    const menuW = this.el.offsetWidth || 240;
    let top = rect.bottom - hostRect.top + 6;
    if (rect.bottom + menuH + 12 > hostRect.bottom && rect.top - hostRect.top > menuH + 12) {
      top = rect.top - hostRect.top - menuH - 6;   // flip above the caret
    }
    let left = rect.left - hostRect.left;
    left = Math.max(8, Math.min(left, hostRect.width - menuW - 8));
    this.el.style.top = `${Math.max(4, top)}px`;
    this.el.style.left = `${left}px`;
    this.el.style.maxHeight = '240px';
  }
}
