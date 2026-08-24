/**
 * Unifile Writer — app shell.
 *
 * A deliberately minimal, mobile-first shell around WriterEditor (editor.js):
 * one editing surface, a thin title bar, a format toolbar that sits above the
 * iOS keyboard, and bottom sheets for everything else (menu, history, export,
 * settings, guide, about).  Reuses unifile's core: VCS history (core/vcs.js)
 * and storage (core/storage.js — IndexedDB in PWA mode, quine regeneration in
 * single-file mode).  Data shape is the standard unifile document object, so a
 * Writer .unifile.json round-trips like any other unifile document.
 *
 * iOS layout rules (see CLAUDE.md "Mobile / iOS" — hard-won, do not simplify):
 * the shell is position:fixed, sized by --app-height (measured from
 * visualViewport so the toolbar rides above the soft keyboard), the window
 * scroll is pinned to (0,0), and only #wr-scroll scrolls.
 */

/* global UNIFILE_VERSION, UNIFILE_BUILT */

import {
  IS_QUINE, captureTemplate, loadEmbeddedData, generateQuine,
  saveToIDB, loadFromIDB, downloadBlob, shareOrDownloadFile,
  requestPersistentStorage, loadUserPrefs, saveUserPrefs,
  saveDraft, loadDraft, clearDraft, markBackedUp, loadBackupMark,
} from '../core/storage.js';
import { VCS } from '../core/vcs.js';
import { shortHash } from '../core/hash.js';
import { WriterEditor } from './editor.js';
import { SlashMenu } from './slash-menu.js';
import { renderDocument, renderMarkdown } from './preview.js';
import { buildEpub, slugify } from './epub.js';
import { GUIDE_MD } from './guide-content.js';

const VERSION = (typeof UNIFILE_VERSION !== 'undefined') ? UNIFILE_VERSION : '0.0.0';
const BUILT = (typeof UNIFILE_BUILT !== 'undefined') ? UNIFILE_BUILT : 'dev';
const DOC_ID = 'writer';

const SEED = `---
title: Untitled
author:
---

# Welcome to Writer

A quiet place to write — plain **Markdown**, saved on your device, with
version history built in.

- Wrapped list items indent under their text, the way an outline should.
- Every \`#\` heading becomes a chapter when you export an EPUB.
- Open the ⋯ menu for **History**, **Export** and the full **Guide**.

Select this text and start typing to begin.
`;

const ICONS = {
  eye: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  kbdown: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="10" rx="2"/><path d="M7 8h.01M11 8h.01M15 8h.01M8 11h8"/><path d="m9 18 3 3 3-3"/></svg>',
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class WriterApp {
  async init() {
    this.version = VERSION;
    this.build = BUILT;
    if (IS_QUINE) captureTemplate();

    // ── Load document ──────────────────────────────────────────────────────
    let data = null;
    if (!IS_QUINE) {
      try { data = await loadFromIDB(DOC_ID); } catch { /* fresh */ }
    }
    data = data || loadEmbeddedData();
    this.data = data;
    this.vcs = new VCS(data);
    this.title = data.title || 'Untitled';
    this.content = data.currentContent ?? this.vcs.headContent ?? '';

    // First run ever (no history, no text) → seed the welcome document.
    if (!this.content && !this.vcs.headHash) this.content = SEED;

    // Quine crash-recovery draft (PWA autosaves the real store instead).
    if (IS_QUINE) {
      const draft = loadDraft();
      if (draft && draft.headHash === this.vcs.headHash && draft.content !== this.content) {
        this.content = draft.content;
      }
    }

    this.prefs = loadUserPrefs();
    this._applyTheme(this.prefs.wrTheme || 'auto');

    // ── Shell ──────────────────────────────────────────────────────────────
    this._buildShell();
    this._trackViewportHeight();
    this._lockWindowScroll();

    this.editor = new WriterEditor(document.getElementById('wr-sheet'), {
      onChange: () => this._onEdit(),
      onSlash: (ctx) => this._onSlashCtx(ctx),
    });
    this.editor.setValue(this.content);
    this._refreshDirty();
    this._refreshCount();
    this._bindSlashMenu();
    this._bindEditingChrome();

    if (!IS_QUINE && 'serviceWorker' in navigator) {
      this._bindServiceWorker();
      requestPersistentStorage();
    }
    this._autoUpdateCheck();
  }

  // -------------------------------------------------------------------------
  // Self-updating PWA — "never fight a cached build"
  //
  // The service worker self-skipWaiting()s and claims clients, so once a new
  // sw.js is SEEN it takes over immediately.  The pieces here make sure it IS
  // seen, and that the page follows it:
  //   • register with updateViaCache:'none' (the HTTP cache must never pin an
  //     old sw.js) and explicitly reg.update() at launch and whenever the app
  //     returns to the foreground — installed PWAs can otherwise go a long
  //     time between the browser's own update checks.
  //   • when a NEW worker takes control of an already-controlled page
  //     (controllerchange), flush the document to IndexedDB and reload once —
  //     the running page is by definition the stale build at that point.
  //     The very first install (page was uncontrolled) does NOT reload.
  // -------------------------------------------------------------------------

  _bindServiceWorker() {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(console.warn);

    // First-install claim (page was uncontrolled) must not reload — but the
    // flag flips there, so the NEXT controllerchange (a real update) does.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      if (!hadController) { hadController = true; return; }
      if (this._reloading) return;
      this._reloading = true;
      try { await this._persistNow(); } catch { /* best effort */ }
      location.reload();
    });

    const poke = () => navigator.serviceWorker.getRegistration()
      .then(reg => reg?.update()).catch(() => {});
    poke();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') poke();
    });
  }

  /**
   * Launch-time version check against the site's version.json (cache-busted).
   * A newer published version → a tappable toast.  Quiet on failure/offline.
   */
  _autoUpdateCheck() {
    if (IS_QUINE || location.protocol === 'file:') return;
    setTimeout(async () => {
      try {
        const remote = await this._fetchRemoteVersion();
        if (this._isNewer(remote)) {
          this._toast(`v${remote} is available — tap to update`, {
            duration: 10000,
            onTap: () => this._applyUpdate(),
          });
        }
      } catch { /* offline — the SW check above still applies updates */ }
    }, 2500);
  }

  async _fetchRemoteVersion() {
    const res = await fetch(`../version.json?_=${Date.now()}`, { cache: 'no-store' });
    const info = await res.json();
    return info.latest ?? info.stable ?? info.version;
  }

  _isNewer(remote) {
    return String(remote).localeCompare(String(VERSION), undefined,
      { numeric: true, sensitivity: 'base' }) > 0;
  }

  /**
   * Drive a new service worker to activation.  NO blind timed reload while an
   * install is in flight (see CLAUDE.md — a precache can take seconds, and
   * reloading early lands back on the OLD worker); the controllerchange
   * listener in _bindServiceWorker performs the single reload.
   */
  async _applyUpdate() {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) { location.reload(); return; }
    await reg.update();
    const drive = (sw) => {
      if (!sw) return;
      if (sw.state === 'installed') sw.postMessage('skipWaiting');
      else sw.addEventListener('statechange', () => {
        if (sw.state === 'installed') sw.postMessage('skipWaiting');
      });
    };
    if (reg.waiting) drive(reg.waiting);
    else if (reg.installing) drive(reg.installing);
    else reg.addEventListener('updatefound', () => drive(reg.installing));
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  _buildShell() {
    const root = document.getElementById('unifile-app');
    root.className = 'wr-app';
    root.innerHTML = `
      <header id="wr-top">
        <input id="wr-title" type="text" value="${esc(this.title)}" aria-label="Document title"
               autocomplete="off" autocorrect="on" spellcheck="false" enterkeyhint="done">
        <span id="wr-dirty" title="Uncommitted changes" hidden></span>
        <div id="wr-top-actions">
          <button id="wr-count" title="Word count" aria-label="Word count"></button>
          <button id="wr-btn-preview" class="wr-icon-btn" title="Preview" aria-label="Toggle preview">${ICONS.eye}</button>
          <button id="wr-btn-menu" class="wr-icon-btn" title="Menu" aria-label="Menu">${ICONS.dots}</button>
        </div>
      </header>
      <main id="wr-main">
        <div id="wr-scroll"><div id="wr-sheet"></div></div>
        <div id="wr-preview" hidden><div id="wr-preview-body" class="wr-prose"></div></div>
      </main>
      <button id="wr-kbd-down" title="Dismiss keyboard" aria-label="Dismiss keyboard">${ICONS.kbdown}</button>
      <div id="wr-overlay" hidden>
        <div id="wr-modal" role="dialog" aria-modal="true"></div>
      </div>`;

    // Title
    const titleEl = document.getElementById('wr-title');
    titleEl.addEventListener('change', () => {
      this.title = titleEl.value.trim() || 'Untitled';
      document.title = this.title;
      this._persistSoon();
    });
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { titleEl.blur(); this.editor.focus(); }
    });
    document.title = this.title;

    document.getElementById('wr-count').addEventListener('click', () => {
      this._countMode = ((this._countMode || 0) + 1) % 3;
      this._refreshCount();
    });

    document.getElementById('wr-btn-preview').addEventListener('click', () => this.togglePreview());
    document.getElementById('wr-btn-menu').addEventListener('click', () => this._openMenu());
    document.getElementById('wr-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'wr-overlay') this._closeSheet();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._closeSheet();
    });
  }

  _exec(cmd) {
    const ed = this.editor;
    const map = {
      undo: () => ed.undo(),
      redo: () => ed.redo(),
      heading: () => ed.cycleHeading(),
      h1: () => ed.setHeading(1),
      h2: () => ed.setHeading(2),
      h3: () => ed.setHeading(3),
      text: () => ed.setHeading(0),
      bold: () => ed.wrapSelection('**'),
      italic: () => ed.wrapSelection('*'),
      strike: () => ed.wrapSelection('~~'),
      code: () => ed.wrapSelection('`'),
      bullet: () => ed.toggleLinePrefix('bullet'),
      ordered: () => ed.toggleLinePrefix('ordered'),
      task: () => ed.toggleTask(),
      quote: () => ed.toggleLinePrefix('quote'),
      indent: () => ed.shiftIndent(1),
      outdent: () => ed.shiftIndent(-1),
      link: () => ed.insertLink(),
      codeblock: () => ed.replaceCurrentLine('```\n\n```', 4),
      divider: () => ed.replaceCurrentLine('---\n', 4),
      table: () => ed.replaceCurrentLine('| Column | Column |\n| ------ | ------ |\n|  |  |', 2),
    };
    map[cmd]?.();
  }

  // -------------------------------------------------------------------------
  // Slash insertion menu (replaces the old bottom toolbar)
  // -------------------------------------------------------------------------

  static SLASH_ITEMS = [
    { id: 'h1',       label: 'Heading 1',      hint: '#',        block: true, keywords: 'h1 title chapter' },
    { id: 'h2',       label: 'Heading 2',      hint: '##',       block: true, keywords: 'h2 section' },
    { id: 'h3',       label: 'Heading 3',      hint: '###',      block: true, keywords: 'h3 subsection' },
    { id: 'text',     label: 'Text',           hint: 'no heading', block: true, keywords: 'paragraph plain body' },
    { id: 'bullet',   label: 'Bullet list',    hint: '-',        block: true, keywords: 'list ul unordered' },
    { id: 'ordered',  label: 'Numbered list',  hint: '1.',       block: true, keywords: 'list ol ordered' },
    { id: 'task',     label: 'Task list',      hint: '- [ ]',    block: true, keywords: 'todo checkbox check' },
    { id: 'quote',    label: 'Quote',          hint: '>',        block: true, keywords: 'blockquote' },
    { id: 'codeblock', label: 'Code block',    hint: '```',      block: true, keywords: 'fence pre snippet' },
    { id: 'divider',  label: 'Divider',        hint: '---',      block: true, keywords: 'rule hr line break scene' },
    { id: 'table',    label: 'Table',          hint: '| |',      block: true, keywords: 'grid columns' },
    { id: 'bold',     label: 'Bold',           hint: '**b**',    keywords: 'strong' },
    { id: 'italic',   label: 'Italic',         hint: '*i*',      keywords: 'emphasis em' },
    { id: 'strike',   label: 'Strikethrough',  hint: '~~s~~',    keywords: 'delete strikeout' },
    { id: 'code',     label: 'Code',           hint: '`code`',   keywords: 'inline mono' },
    { id: 'link',     label: 'Link',           hint: '[…](url)', keywords: 'url href' },
    { id: 'undo',     label: 'Undo',           keywords: 'revert back' },
    { id: 'redo',     label: 'Redo',           keywords: 'again forward' },
  ];

  _bindSlashMenu() {
    this.slash = new SlashMenu(document.getElementById('wr-main'), {
      items: WriterApp.SLASH_ITEMS,
      onPick: (item, ctx) => {
        // Delete the typed `/query` (unrecorded — see _applyEdit 'none': one
        // undo step per pick, and the Undo action can't resurrect the query),
        // then run the action at the caret.
        this.editor._applyEdit(ctx.start, ctx.caret, '', ctx.start, ctx.start, 'none');
        this._exec(item.id);
      },
    });
    // Menu keyboard nav runs in the capture phase so it beats the editor's own
    // keydown handling; preventing Enter here also stops insertParagraph.
    this.editor.root.addEventListener('keydown', (e) => {
      if (!this.slash.isOpen) return;
      const ctxStart = this.slash.ctx?.start;
      if (this.slash.handleKey(e)) {
        // Esc dismissal must stick: Chrome queues selectionchange events, and
        // one landing right after close() would re-open for the same `/` —
        // remember the dismissed context until the caret leaves it.
        if (e.key === 'Escape') this._slashDismissed = ctxStart ?? null;
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  _onSlashCtx(ctx) {
    if (!this.slash) return;
    if (!ctx) {
      this._slashDismissed = null;
      this.slash.close();
      return;
    }
    if (this._slashDismissed === ctx.start) { this.slash.close(); return; }
    this.slash.open(ctx, this.editor.caretRect());
  }

  // -------------------------------------------------------------------------
  // Content lifecycle
  // -------------------------------------------------------------------------

  _onEdit() {
    this.content = this.editor.getValue();
    this._refreshDirty();
    this._refreshCount();
    this._persistSoon();
    if (!document.getElementById('wr-preview').hidden) this._renderPreview();
  }

  get isDirty() { return this.content !== (this.vcs.headContent ?? ''); }

  _refreshDirty() {
    const el = document.getElementById('wr-dirty');
    if (el) el.hidden = !this.isDirty;
  }

  _refreshCount() {
    const el = document.getElementById('wr-count');
    if (!el) return;
    const { words, chars, minutes } = this.editor.getStats();
    const mode = this._countMode || 0;
    el.textContent = mode === 0 ? `${words.toLocaleString()} w`
      : mode === 1 ? `${chars.toLocaleString()} ch`
      : `${minutes} min`;
  }

  _currentData() {
    return {
      ...this.data,
      ...this.vcs.serialize(),
      version: VERSION,
      title: this.title,
      dslType: 'writer',
      currentContent: this.content,
    };
  }

  _persistSoon() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this._persistNow(), 400);
  }

  async _persistNow() {
    const data = this._currentData();
    this.data = data;
    if (IS_QUINE) {
      // The file can't rewrite itself silently — keep a crash-recovery draft.
      saveDraft(this.content, this.vcs.headHash);
    } else {
      try { await saveToIDB(DOC_ID, data); } catch (e) { console.warn('autosave failed', e); }
    }
  }

  async commit(message) {
    const author = (this.prefs.name || '').trim() || 'anonymous';
    const email = (this.prefs.email || '').trim() || '';
    await this.vcs.commit({ content: this.content, message: message || '', author, email });
    clearDraft();
    this._refreshDirty();
    await this._persistNow();
  }

  setContent(text) {
    this.content = text;
    this.editor.setValue(text);
    this._refreshDirty();
    this._refreshCount();
    this._persistSoon();
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  togglePreview(force) {
    const pane = document.getElementById('wr-preview');
    const on = force ?? pane.hidden;
    pane.hidden = !on;
    document.getElementById('unifile-app').toggleAttribute('data-preview', on);
    document.getElementById('wr-btn-preview').classList.toggle('active', on);
    if (on) this._renderPreview();
  }

  _renderPreview() {
    document.getElementById('wr-preview-body').innerHTML = renderDocument(this.content);
  }

  // -------------------------------------------------------------------------
  // Sheets (bottom-sheet modal)
  // -------------------------------------------------------------------------

  _openSheet(html, cls = '') {
    const overlay = document.getElementById('wr-overlay');
    const modal = document.getElementById('wr-modal');
    modal.className = cls;
    modal.innerHTML = html;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    return modal;
  }

  _closeSheet() {
    const overlay = document.getElementById('wr-overlay');
    if (overlay.hidden) return;
    overlay.classList.remove('open');
    overlay.hidden = true;
    document.getElementById('wr-modal').innerHTML = '';
  }

  /** Transient toast; pass onTap (+ optional duration) to make it actionable. */
  _toast(msg, { onTap, duration = 2600 } = {}) {
    document.querySelector('.wr-toast')?.remove();
    const el = document.createElement('div');
    el.className = 'wr-toast' + (onTap ? ' wr-toast-action' : '');
    el.textContent = msg;
    if (onTap) {
      el.addEventListener('click', () => {
        el.textContent = 'Updating…';
        onTap();
      });
    }
    document.getElementById('unifile-app').appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, duration);
  }

  // ── Menu ──────────────────────────────────────────────────────────────────

  _openMenu() {
    const focusOn = this.editor.focusMode;
    const modal = this._openSheet(`
      <div class="wr-menu">
        <button data-act="preview">Preview</button>
        <button data-act="focus">${focusOn ? '✓ ' : ''}Focus mode</button>
        <button data-act="history">History${this.isDirty ? ' <span class="wr-menu-dot"></span>' : ''}</button>
        <button data-act="export">Export…</button>
        <button data-act="import">Import data file…</button>
        <button data-act="new">New document</button>
        <hr>
        <button data-act="guide">Guide</button>
        <button data-act="settings">Settings</button>
        <button data-act="about">About</button>
      </div>`);
    modal.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      this._closeSheet();
      const go = {
        preview: () => this.togglePreview(true),
        focus: () => this.editor.setFocusMode(!focusOn),
        history: () => this._openHistory(),
        export: () => this._openExport(),
        import: () => this._importData(),
        new: () => this._newDocument(),
        guide: () => this._openGuide(),
        settings: () => this._openSettings(),
        about: () => this._openAbout(),
      };
      go[act]?.();
    });
  }

  // ── History ───────────────────────────────────────────────────────────────

  _openHistory() {
    const commits = this.vcs.log();
    const backup = loadBackupMark(this._backupScope());
    const fmtDate = (t) => new Date(t).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    const pending = this.isDirty ? `
      <div class="wr-pending">
        <div class="wr-pending-head"><span class="wr-node"></span>Uncommitted changes</div>
        <div class="wr-pending-row">
          <input id="wr-commit-msg" type="text" placeholder="Message (optional)" autocomplete="off">
          <button id="wr-commit-btn" class="wr-primary">Commit</button>
        </div>
      </div>` : '<div class="wr-clean">Everything committed.</div>';

    const list = commits.length ? commits.map(c => `
      <div class="wr-commit" data-hash="${c.hash}">
        <div class="wr-commit-line">
          <span class="wr-commit-msg">${esc(c.message || '(no message)')}</span>
          ${c.tag ? `<span class="wr-tag">${esc(c.tag)}</span>` : ''}
          ${backup && backup.headHash === c.hash ? '<span class="wr-tag wr-exported">exported</span>' : ''}
        </div>
        <div class="wr-commit-meta">${esc(shortHash(c.hash))} · ${esc(c.author || '')} · ${fmtDate(c.timestamp)}</div>
        <button class="wr-restore" data-hash="${c.hash}">Restore</button>
      </div>`).join('') : '<div class="wr-clean">No commits yet.</div>';

    const modal = this._openSheet(`
      <div class="wr-sheet-head">History</div>
      <div class="wr-sheet-body">${pending}<div class="wr-log">${list}</div></div>`, 'tall');

    modal.querySelector('#wr-commit-btn')?.addEventListener('click', async () => {
      const msg = modal.querySelector('#wr-commit-msg').value.trim();
      await this.commit(msg);
      this._closeSheet();
      this._toast('Committed');
    });
    modal.addEventListener('click', (e) => {
      const btn = e.target.closest('.wr-restore');
      if (!btn) return;
      const hash = btn.dataset.hash;
      if (hash === this.vcs.headHash && !this.isDirty) { this._closeSheet(); return; }
      if (!confirm('Restore this version into the editor? Your current text stays in history only if committed.')) return;
      this.setContent(this.vcs.getContentAt(hash));
      this._closeSheet();
      this._toast('Restored — commit to keep it');
    });
  }

  // ── Export ────────────────────────────────────────────────────────────────

  _slug() { return slugify(this.title); }
  _backupScope() { return IS_QUINE ? location.href : DOC_ID; }

  _openExport() {
    const modal = this._openSheet(`
      <div class="wr-sheet-head">Export</div>
      <div class="wr-menu">
        <button data-act="epub"><b>EPUB</b> — e-book for Apple Books, Kindle, Kobo…</button>
        <button data-act="md">Markdown (.md) — the raw text</button>
        <button data-act="data">Data file (.unifile.json) — text + full history</button>
        ${IS_QUINE ? '<button data-act="quine">Save a copy (.html) — app + document in one file</button>' : ''}
      </div>`);
    modal.addEventListener('click', async (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      this._closeSheet();
      try {
        if (act === 'epub') await this._exportEpub();
        if (act === 'md') await shareOrDownloadFile(this.content, this._slug() + '.md', 'text/markdown');
        if (act === 'data') await this._exportData();
        if (act === 'quine') await this._exportQuine();
      } catch (err) {
        if (err?.name !== 'AbortError') this._toast('Export failed: ' + err.message);
      }
    });
  }

  async _exportEpub() {
    const { bytes, filename } = buildEpub({
      content: this.content,
      title: this.title,
      author: this.prefs.name || '',
    });
    await this._shareOrDownloadBlob(new Blob([bytes], { type: 'application/epub+zip' }), filename);
    this._toast('EPUB exported');
  }

  async _exportData() {
    const json = JSON.stringify(this._currentData(), null, 2);
    const res = await shareOrDownloadFile(json, this._slug() + '.unifile.json', 'application/json');
    if (res !== 'cancelled' && this.vcs.headHash) {
      markBackedUp(this._backupScope(), this.vcs.headHash);
    }
  }

  async _exportQuine() {
    const html = generateQuine(this._currentData(), renderDocument(this.content), this.title);
    await shareOrDownloadFile(html, this._slug() + '.html', 'text/html');
  }

  /** Binary sibling of storage.shareOrDownloadFile (EPUBs are not text). */
  async _shareOrDownloadBlob(blob, filename) {
    try {
      if (navigator.canShare && typeof File !== 'undefined') {
        const file = new File([blob], filename, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          return;
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    downloadBlob(blob, filename);
  }

  _importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data.branches || !data.commits) throw new Error('not a unifile data file');
        if (!confirm(`Replace the current document with “${data.title || 'Untitled'}” (including its history)?`)) return;
        this.data = data;
        this.vcs = new VCS(data);
        this.title = data.title || 'Untitled';
        document.getElementById('wr-title').value = this.title;
        document.title = this.title;
        this.setContent(data.currentContent ?? this.vcs.headContent ?? '');
        await this._persistNow();
        this._toast('Imported');
      } catch (err) {
        this._toast('Import failed: ' + err.message);
      }
    });
    input.click();
  }

  _newDocument() {
    if (!confirm('Start a new document? The current document and its history will be replaced'
      + (IS_QUINE ? '.' : ' (export a data file first if you want to keep it).'))) return;
    this.data = {
      version: VERSION, title: 'Untitled', dslType: 'writer',
      currentBranch: 'main', branches: { main: { name: 'main', head: null } },
      commits: {}, comments: {}, password: null,
    };
    this.vcs = new VCS(this.data);
    this.title = 'Untitled';
    document.getElementById('wr-title').value = this.title;
    document.title = this.title;
    this.setContent('');
    this._persistNow();
  }

  // ── Guide / Settings / About ─────────────────────────────────────────────

  _openGuide() {
    this._openSheet(`
      <div class="wr-sheet-head">Guide</div>
      <div class="wr-sheet-body wr-prose">${renderMarkdown(GUIDE_MD)}</div>`, 'tall');
  }

  _openSettings() {
    const modal = this._openSheet(`
      <div class="wr-sheet-head">Settings</div>
      <div class="wr-sheet-body">
        <label class="wr-field">Author name
          <input id="wr-set-name" type="text" value="${esc(this.prefs.name || '')}" autocomplete="name" placeholder="Used for commits & EPUB author">
        </label>
        <label class="wr-field">Email
          <input id="wr-set-email" type="email" value="${esc(this.prefs.email || '')}" autocomplete="email" placeholder="Optional, for commits">
        </label>
        <label class="wr-field">Theme
          <select id="wr-set-theme">
            <option value="auto">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>`);
    modal.querySelector('#wr-set-theme').value = this.prefs.wrTheme || 'auto';
    modal.querySelector('#wr-set-name').addEventListener('change', (e) => {
      this.prefs.name = e.target.value; saveUserPrefs({ name: e.target.value });
    });
    modal.querySelector('#wr-set-email').addEventListener('change', (e) => {
      this.prefs.email = e.target.value; saveUserPrefs({ email: e.target.value });
    });
    modal.querySelector('#wr-set-theme').addEventListener('change', (e) => {
      this.prefs.wrTheme = e.target.value;
      saveUserPrefs({ wrTheme: e.target.value });
      this._applyTheme(e.target.value);
    });
  }

  _applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-wr-theme', mode);
    else root.removeAttribute('data-wr-theme');
  }

  _openAbout() {
    const canUpdate = !IS_QUINE && location.protocol !== 'file:';
    const modal = this._openSheet(`
      <div class="wr-sheet-head">About</div>
      <div class="wr-sheet-body">
        <p><b>Unifile Writer</b> v${esc(VERSION)}
          <span class="wr-mut">· build ${esc(BUILT)}</span></p>
        <p class="wr-mut">${IS_QUINE ? 'Single-file mode — this document and the app live in one .html file.'
          : 'App mode — your document is stored on this device (IndexedDB).'}</p>
        <p class="wr-mut">Fully offline. Nothing leaves your device. <br>unifile.app</p>
        ${canUpdate ? '<button id="wr-update-btn" class="wr-primary">Check for updates</button><div id="wr-update-status" class="wr-mut"></div>' : ''}
      </div>`);
    modal.querySelector('#wr-update-btn')?.addEventListener('click', () => this._checkUpdate(modal));
  }

  /** About's manual check: report status, then hand off to _applyUpdate. */
  async _checkUpdate(modal) {
    const status = modal.querySelector('#wr-update-status');
    const btn = modal.querySelector('#wr-update-btn');
    status.textContent = 'Checking…';
    try {
      const remote = await this._fetchRemoteVersion();
      if (!this._isNewer(remote)) { status.textContent = `Up to date (v${VERSION}).`; return; }
      status.textContent = `v${remote} available.`;
      btn.textContent = 'Update & reload';
      btn.onclick = () => {
        btn.textContent = 'Updating…';
        btn.disabled = true;
        this._applyUpdate();
      };
    } catch {
      status.textContent = 'Could not reach unifile.app (offline?).';
    }
  }

  // -------------------------------------------------------------------------
  // Editing chrome — the title bar gets out of the way while you write.
  //
  // On a touch device with the soft keyboard up, the header's 46px matter, so
  // it slides away (`data-editing` on the app root → CSS) and its space goes
  // to the text.  It comes back the moment the keyboard is dismissed — the
  // toolbar gains a dismiss-keyboard button while editing so the header (and
  // its menu) is always one tap away.
  //
  // "Keyboard is up" is detected from the visual viewport, not from focus
  // alone: `_trackViewportHeight` records the tallest viewport seen per
  // window width (the no-keyboard baseline; keyed by width so rotation gets
  // its own baseline) and a viewport >100px shorter than the baseline means
  // the keyboard is genuinely eating space.  An iPad with a hardware keyboard
  // focuses the editor without shrinking the viewport → the header stays.
  // Coarse-pointer gate keeps desktop (always-focused editor) unaffected.
  // -------------------------------------------------------------------------

  _bindEditingChrome() {
    // focusin/focusout on document (they bubble — contenteditable focus/blur
    // has historically been flaky on iOS) + a live activeElement check in
    // _updateEditingChrome, so a missed event can't wedge the state.
    document.addEventListener('focusin', () => this._updateEditingChrome());
    document.addEventListener('focusout', () => setTimeout(() => this._updateEditingChrome(), 50));
    // Dismiss-keyboard button (floating, only visible while editing):
    // blur → keyboard drops → header returns.
    document.getElementById('wr-kbd-down').addEventListener('click', () => {
      this.editor.root.blur();
    });
    this._updateEditingChrome();
  }

  _updateEditingChrome() {
    const focused = document.activeElement === this.editor?.root;
    // No visualViewport (no keyboard signal at all) → fall back to focus alone.
    const kb = window.visualViewport ? !!this._kbOpen : true;
    const editing = !!(focused && kb && window.matchMedia('(pointer: coarse)').matches);
    document.getElementById('unifile-app').toggleAttribute('data-editing', editing);
  }

  // -------------------------------------------------------------------------
  // iOS viewport (see CLAUDE.md "Mobile / iOS" — these are load-bearing)
  // -------------------------------------------------------------------------

  _trackViewportHeight() {
    this._vvBase = {};   // tallest viewport seen per window width (no-keyboard baseline)
    const set = () => {
      const vv = window.visualViewport;
      const h = Math.round(vv?.height ?? window.innerHeight);
      const top = Math.round(vv?.offsetTop ?? 0);
      const root = document.documentElement.style;
      root.setProperty('--app-height', `${h}px`);
      root.setProperty('--app-vv-top', `${top}px`);
      const key = window.innerWidth;
      if (!this._vvBase[key] || h > this._vvBase[key]) this._vvBase[key] = h;
      this._kbOpen = this._vvBase[key] - h > 60;
      this._updateEditingChrome();
    };
    set();
    window.addEventListener('resize', set);
    window.addEventListener('orientationchange', () => { set(); setTimeout(set, 300); });
    window.visualViewport?.addEventListener('resize', set);
    window.visualViewport?.addEventListener('scroll', set);
    window.addEventListener('pageshow', set);
    [50, 200, 500].forEach(ms => setTimeout(set, ms));
  }

  _lockWindowScroll() {
    const reset = () => {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      const se = document.scrollingElement;
      if (se && (se.scrollTop || se.scrollLeft)) { se.scrollTop = 0; se.scrollLeft = 0; }
    };
    window.addEventListener('scroll', reset, { passive: true });
    window.visualViewport?.addEventListener('scroll', reset);
    window.visualViewport?.addEventListener('resize', reset);
    document.addEventListener('focusout', () => setTimeout(reset, 50));
  }
}
