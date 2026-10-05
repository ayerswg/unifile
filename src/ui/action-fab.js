/**
 * The phone action button — one round `{glyph}` bubble that does three things:
 *
 *   • TAP        runs the PRIMARY action (play/pause for {compose}, undo elsewhere;
 *                Save in the history view, New document in the library);
 *   • LONG-PRESS opens a grid of the view's actions, alphabetical, with the
 *                primary ringed — each tile runs its action, its ☆ makes it
 *                the primary;
 *   • DRAG       moves the button; it snaps to whichever of the four corners
 *                is nearest.  While dragging, dashed ghosts mark the corners.
 *
 * The bubble is CONTEXTUAL to the pane that is showing (actions.js
 * listBubbleActions): editor = text/music verbs, render = play (ABC) or zoom
 * to fit / in / out (Mermaid) — otherwise the bubble hides, history = Save /
 * Save to device, library = New / Open from device.  File-level operations and
 * settings are NOT here — they're under the title dropdown.
 *
 * Corner + primary choice persist in localStorage (primary per DSL + view).
 * Phone only (CSS hides it on desktop, where the transport bar / top bar remain).
 *
 * Focus: pointerdown is preventDefault()ed so a tap never steals focus from the
 * editor — Undo/Redo/Play keep the caret and the soft keyboard where they were.
 * setPointerCapture is wrapped (throws for stale/synthetic ids — see piano-roll).
 */

import { state } from './state.js';
import { listBubbleActions, defaultPrimary, currentDslId, esc } from './actions.js';

const CORNERS = ['tl', 'tr', 'bl', 'br'];
const CORNER_LABEL = { tl: 'top left', tr: 'top right', bl: 'bottom left', br: 'bottom right' };
const LONG_PRESS_MS = 480;
const DRAG_SLOP = 8;

export class ActionFab {
  /**
   * @param {HTMLElement} root  #unifile-app
   * @param {object} ctx        { handlers, editor, openTopMenu }
   */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this._open = false;
    this._corner = _load('uf_fab_corner', 'br');
    if (!CORNERS.includes(this._corner)) this._corner = 'br';

    // DOM: button + corner ghosts + grid + scrim.
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'uf-fab';
    this.targets = document.createElement('div');
    this.targets.className = 'uf-fab-targets';
    this.targets.setAttribute('aria-hidden', 'true');
    this.targets.innerHTML = CORNERS.map(c => `<span class="uf-fab-target" data-corner="${c}"></span>`).join('');
    this.scrim = document.createElement('div');
    this.scrim.className = 'uf-fab-scrim';
    this.grid = document.createElement('div');
    this.grid.className = 'uf-fab-grid';
    this.grid.setAttribute('role', 'menu');
    this.grid.setAttribute('aria-label', 'All actions');
    root.append(this.targets, this.scrim, this.grid, this.el);

    this._bindPointer();
    this.scrim.addEventListener('click', () => this.close());
    this.grid.addEventListener('click', (e) => this._onGridClick(e));
    // Keep the editor's focus/keyboard when tapping tiles too.
    this.grid.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') e.preventDefault(); });
    this.grid.addEventListener('mousedown', (e) => e.preventDefault());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this._open) this.close(); });

    // Re-render on anything that changes the action list or the primary glyph.
    for (const ev of ['change', 'abc-play-state', 'checkout', 'active-section-change', 'piano-roll-change']) {
      state.on(ev, () => this.render());
    }
    state.on('diff-change', () => this.close());
    state.on('mobile-goto-pane', () => this.close());

    // The top corners sit just below the top bar; re-measure when it shows /
    // hides (typing) or the viewport changes.
    this._placeTop();
    window.addEventListener('resize', () => this._placeTop());
    window.visualViewport?.addEventListener('resize', () => this._placeTop());
    new MutationObserver((muts) => {
      this._placeTop();
      if (muts.some(m => m.attributeName === 'data-mobile-pane')) this.render();
    }).observe(root, { attributes: true, attributeFilter: ['data-editing', 'data-mobile-pane', 'data-diff'] });

    this.render();
    this._firstRunHint();
  }

  // ---------------------------------------------------------------------------
  // Primary action
  // ---------------------------------------------------------------------------

  /** The pane showing now: 'editor' | 'render' | 'history' | 'library'. */
  get view() { return this.root.getAttribute('data-mobile-pane') || 'editor'; }

  get primaryId() {
    const dsl = currentDslId(), view = this.view;
    return _load(`uf_fab_primary:${dsl}:${view}`, defaultPrimary(dsl, view));
  }

  setPrimary(id) {
    _save(`uf_fab_primary:${currentDslId()}:${this.view}`, id);
    this.render();
  }

  /** null = the tap opens the grid ('menu'). */
  _resolvePrimary(actions) {
    const want = this.primaryId;
    if (want === 'menu') return null;
    return actions.find(a => a.id === want && !a.disabled && a.star !== false)
      ?? actions.find(a => a.id === defaultPrimary(currentDslId(), this.view))
      ?? null;
  }

  _actions() { return listBubbleActions(this.ctx, this.view); }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  render() {
    const view = this.view;
    const actions = this._actions();
    const primary = this._resolvePrimary(actions);
    const empty = actions.length === 0;
    this.el.hidden = empty;
    if (empty && this._open) this.close();
    this.el.dataset.corner = this._corner;
    this.el.dataset.view = view;
    this.el.dataset.primary = primary?.id ?? 'menu';
    this.el.classList.toggle('playing', primary?.id === 'play' && !!state.abcPlaying);
    {
      const glyph = primary?.glyph ?? '⋯';
      this.el.innerHTML = `<span class="uf-fab-mark" aria-hidden="true">{${esc(glyph)}}</span>`;
      const what = primary?.label ?? 'Actions';
      this.el.setAttribute('aria-label', `${what} — hold for all actions, drag to move`);
      this.el.title = `${what} (hold for all actions · drag to a corner)`;
    }
    this.grid.dataset.corner = this._corner;
    if (this._open) this._renderGrid(actions, primary);
  }

  _renderGrid(actions, primary) {
    const sorted = [...actions].sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }));
    const isPrimary = (a) => !!primary && a.id === primary.id;
    const tiles = sorted.map(a => `
      <div class="uf-fab-tile${isPrimary(a) ? ' primary' : ''}${a.disabled ? ' disabled' : ''}${a.current ? ' current' : ''}${a.star === false ? ' no-star' : ''}"
           role="menuitem" tabindex="0" data-id="${esc(a.id)}" aria-disabled="${a.disabled}">
        <span class="t-mark" aria-hidden="true">{${esc(a.glyph)}}</span>
        <span class="t-label">${esc(a.label)}</span>
        ${a.star === false ? '' : `<button type="button" class="t-star" data-star="${esc(a.id)}"
          aria-label="${isPrimary(a) ? 'This is the tap action' : `Make “${esc(a.label)}” the tap action`}"
          title="${isPrimary(a) ? 'Tap action' : 'Make this the tap action'}">${isPrimary(a) ? '★' : '☆'}</button>`}
      </div>`).join('');

    const corners = CORNERS.map(c => `
      <button type="button" class="uf-fab-cbtn${c === this._corner ? ' current' : ''}" data-move="${c}"
        aria-label="Move the button to the ${CORNER_LABEL[c]}" title="${CORNER_LABEL[c]}"></button>`).join('');

    const view = this.view;
    const tapLine = primary ? `<b>Tap</b> the bubble = <b>${esc(primary.label)}</b> (★ picks another). `
                            : `<b>Tap</b> the bubble = this menu. `;
    const heading = '';
    this.grid.innerHTML = `
      ${heading}
      <div class="uf-fab-tiles">${tiles}</div>
      <div class="uf-fab-hint">
        <div class="uf-fab-hint-text">
          ${tapLine}<b>Hold</b> = this menu. <b>Drag</b> it to any corner, or pick one:
        </div>
        <div class="uf-fab-corners" role="group" aria-label="Button corner">${corners}</div>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Grid open / close / clicks
  // ---------------------------------------------------------------------------

  open() {
    if (this._open) return;
    this._open = true;
    this.root.setAttribute('data-fab-open', '1');
    _save('uf_fab_seen', '1');
    this._hideHint();
    this.render();
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.root.removeAttribute('data-fab-open');
    this.grid.innerHTML = '';
  }

  _onGridClick(e) {
    const star = e.target.closest('[data-star]');
    if (star) { e.stopPropagation(); this.setPrimary(star.dataset.star); return; }
    const move = e.target.closest('[data-move]');
    if (move) { e.stopPropagation(); this._setCorner(move.dataset.move); this.render(); return; }
    const tile = e.target.closest('.uf-fab-tile');
    if (!tile || tile.classList.contains('disabled')) return;
    const id = tile.dataset.id;
    this.close();
    this._run(id);
  }

  _run(id) {
    const act = this._actions().find(a => a.id === id);
    if (!act || act.disabled) return;
    try { act.run(); } catch (err) { console.warn('action failed', id, err); }
    this.render();
  }

  _runPrimary() {
    const primary = this._resolvePrimary(this._actions());
    if (primary) this._run(primary.id); else this.open();
  }

  // ---------------------------------------------------------------------------
  // Pointer: tap · long-press · drag-to-corner
  // ---------------------------------------------------------------------------

  _bindPointer() {
    const el = this.el;
    let ptr = null;        // { id, x0, y0, left, top, appRect, moved, timer, consumed }

    const clearTimer = () => { if (ptr?.timer) { clearTimeout(ptr.timer); ptr.timer = null; } };

    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('mousedown', (e) => e.preventDefault());   // keep editor focus
    el.addEventListener('click', (e) => e.preventDefault());       // we act on pointerup

    el.addEventListener('pointerdown', (e) => {
      if (ptr) return;                       // second finger → ignore
      e.preventDefault();                    // keep editor focus + keyboard
      try { el.setPointerCapture(e.pointerId); } catch { /* stale / synthetic id */ }
      const r = el.getBoundingClientRect();
      const appRect = this.root.getBoundingClientRect();
      ptr = {
        id: e.pointerId, x0: e.clientX, y0: e.clientY,
        left: r.left - appRect.left, top: r.top - appRect.top, w: r.width, h: r.height,
        appRect, moved: false, consumed: false, timer: null,
      };
      el.classList.add('pressed');
      ptr.timer = setTimeout(() => {
        if (!ptr || ptr.moved) return;
        ptr.consumed = true;
        ptr.timer = null;
        el.classList.remove('pressed');
        this.open();
      }, LONG_PRESS_MS);
    });

    el.addEventListener('pointermove', (e) => {
      if (!ptr || e.pointerId !== ptr.id || ptr.consumed) return;
      const dx = e.clientX - ptr.x0, dy = e.clientY - ptr.y0;
      if (!ptr.moved) {
        if (Math.hypot(dx, dy) < DRAG_SLOP) return;
        ptr.moved = true;
        clearTimer();
        this.close();
        this.root.setAttribute('data-fab-drag', '1');
        el.classList.add('dragging');
        el.classList.remove('pressed');
      }
      const x = Math.max(0, Math.min(ptr.appRect.width - ptr.w, ptr.left + dx));
      const y = Math.max(0, Math.min(ptr.appRect.height - ptr.h, ptr.top + dy));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      const near = this._nearestCorner(x + ptr.w / 2, y + ptr.h / 2, ptr.appRect);
      this.targets.querySelectorAll('.uf-fab-target').forEach(t =>
        t.classList.toggle('near', t.dataset.corner === near));
    });

    const finish = (e, cancelled) => {
      if (!ptr || e.pointerId !== ptr.id) return;
      const p = ptr; ptr = null;
      clearTimer();
      el.classList.remove('pressed');
      try { el.releasePointerCapture(e.pointerId); } catch {}
      if (p.moved) {
        const x = parseFloat(el.style.left) + p.w / 2, y = parseFloat(el.style.top) + p.h / 2;
        el.classList.remove('dragging');
        el.style.left = el.style.top = '';
        this.root.removeAttribute('data-fab-drag');
        this.targets.querySelectorAll('.near').forEach(t => t.classList.remove('near'));
        if (!cancelled) this._setCorner(this._nearestCorner(x, y, p.appRect));
        this.render();
        return;
      }
      if (cancelled || p.consumed) return;
      // Plain tap → primary.  (Tapping while the grid is open just closes it.)
      if (this._open) { this.close(); return; }
      this._hideHint();
      this._runPrimary();
    };
    el.addEventListener('pointerup', (e) => finish(e, false));
    el.addEventListener('pointercancel', (e) => finish(e, true));
  }

  _nearestCorner(cx, cy, appRect) {
    const left = cx < appRect.width / 2, top = cy < appRect.height / 2;
    return (top ? 't' : 'b') + (left ? 'l' : 'r');
  }

  _setCorner(c) {
    if (!CORNERS.includes(c)) return;
    this._corner = c;
    _save('uf_fab_corner', c);
    this.el.dataset.corner = c;
    this.grid.dataset.corner = c;
    // A little settle bounce so the snap reads as a snap.
    this.el.classList.remove('snapped');
    void this.el.offsetWidth;
    this.el.classList.add('snapped');
  }

  /** Top corners sit just under the top bar (which hides while typing). */
  _placeTop() {
    const main = document.getElementById('uf-main');
    const top = main ? main.offsetTop : 0;
    this.root.style.setProperty('--uf-fab-top', `${Math.max(0, top)}px`);
  }

  // ---------------------------------------------------------------------------
  // First-run hint: a one-time caption beside the button.
  // ---------------------------------------------------------------------------

  _firstRunHint() {
    if (_load('uf_fab_seen', '') === '1') return;
    const hint = document.createElement('div');
    hint.className = 'uf-fab-tip';
    hint.textContent = 'Hold for all actions · drag to a corner';
    this.root.appendChild(hint);
    this._tip = hint;
    this._tipTimer = setTimeout(() => this._hideHint(), 8000);
  }

  _hideHint() {
    if (!this._tip) return;
    clearTimeout(this._tipTimer);
    this._tip.remove();
    this._tip = null;
    _save('uf_fab_seen', '1');
  }
}

function _load(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function _save(k, v) { try { localStorage.setItem(k, v); } catch {} }
