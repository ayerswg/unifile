/**
 * uPub — app shell.
 *
 * A deliberately minimal, mobile-first shell around UPubEditor (editor.js):
 * one editing surface, a thin title bar, and bottom sheets for everything
 * else (menu, history, export, settings, guide, about).  Reuses unifile's core: VCS history (core/vcs.js)
 * and storage (core/storage.js — IndexedDB in PWA mode, quine regeneration in
 * single-file mode).  Data shape is the standard unifile document object, so a
 * uPub .unifile.json round-trips like any other unifile document.
 *
 * iOS layout rules (see CLAUDE.md "Mobile / iOS" — hard-won, do not simplify):
 * the shell is position:fixed, sized by --app-height (measured from
 * visualViewport so the UI rides above the soft keyboard), the window
 * scroll is pinned to (0,0), and only #wr-scroll scrolls.
 */


import {
  IS_QUINE, captureTemplate, loadEmbeddedData, generateQuine,
  downloadBlob, shareOrDownloadFile,
  requestPersistentStorage, loadUserPrefs, saveUserPrefs,
  saveDraft, loadDraft, clearDraft,
} from '../core/storage.js';
import { ShellLibrary } from './library.js';
import { VCS } from '../core/vcs.js';
import { shortHash } from '../core/hash.js';
import { UPubEditor } from './editor.js';
import { SlashMenu } from './slash-menu.js';
import { UPubComments } from './comments.js';
import { renderDocument, renderMarkdown } from './preview.js';
import { buildEpub, slugify } from './epub.js';
import { GUIDE_MD } from './guide-content.js';
import { BUILD, isDevChannel, newerBuild, remoteBuild, formatBuild, formatCommitAt } from '../core/build-info.js';

// Build identity (version · commit · channel) — src/core/build-info.js.
const VERSION = BUILD.version;
const BUILT = BUILD.built || 'dev';
const COMMIT = BUILD.commit;
const COMMIT_AT = BUILD.commitAt;
const DOC_ID = 'upub';

const SEED = `---
title: Untitled
author:
---

# Welcome to {write}

A quiet place to write — plain **Markdown**, saved on your device, with
version history built in.

- Wrapped list items indent under their text, the way an outline should.
- Every \`#\` heading becomes a chapter when you export an EPUB.
- Open the ⋯ menu for **History**, **Export** and the full **Guide**.

Select this text and start typing to begin.
`;

const ICONS = {
  back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class UPubApp {
  async init() {
    this.version = VERSION;
    this.build = BUILT;
    if (IS_QUINE) captureTemplate();

    // ── Load document ──────────────────────────────────────────────────────
    // PWA: the document library (upub/library.js → core/library.js) — the
    // last-opened record, migrating the pre-library single document (the
    // legacy DOC_ID record) on first launch.  Quine: the embedded data.
    this.lib = new ShellLibrary(this, { app: 'upub', version: VERSION });
    const { data } = await this.lib.boot(loadEmbeddedData(), DOC_ID);
    this.data = data;
    this.vcs = new VCS(data);
    this.vcs.detachedHead = null;                 // one line of history
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

    this.editor = new UPubEditor(document.getElementById('wr-sheet'), {
      onChange: () => this._onEdit(),
      onEdit: (change) => this.comments?.mapEdit(change),
      onSlash: (ctx) => this._onSlashCtx(ctx),
    });
    this.editor.setValue(this.content);
    // Inline comments — highlights in the text, a card on the selection
    // (see upub/comments.js); the threads live on this.data.commentThreads.
    this.comments = new UPubComments({
      editor: this.editor,
      sheet: document.getElementById('wr-sheet'),
      scroller: document.getElementById('wr-scroll'),
      getData: () => this.data,
      author: () => (this.prefs.name || '').trim() || 'Anonymous',
      headHash: () => this.vcs.headHash,
      onChange: () => { this._persistSoon(); this.comments.refresh(); },
      openSheet: (html, cls) => this._openSheet(html, cls),
      closeSheet: () => this._closeSheet(),
    });
    this._refreshDirty();
    this._refreshCount();
    this._bindSlashMenu();
    this._bindEditingChrome();
    this._bindScrollChrome();
    this._guardFocusScroll();

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
        const reason = this._isNewer(remote);
        if (!reason) return;
        if (isDevChannel()) {
          // Dev channel: the commit is the version and every push is meant to
          // be run — apply it without being asked; the reload lands once the
          // new worker takes control (controllerchange above).
          this._toast(`New build ${formatBuild(remote, { commit: true })} — updating…`, { duration: 10000 });
          this._applyUpdate();
        } else {
          this._toast(`v${remote.version} is available — tap to update`, {
            duration: 10000,
            onTap: () => this._applyUpdate(),
          });
        }
      } catch { /* offline — the SW check above still applies updates */ }
    }, 2500);
  }

  /** The published build (version.json, cache-busted) as a build-info object. */
  async _fetchRemoteVersion() {
    const res = await fetch(`../version.json?_=${Date.now()}`, { cache: 'no-store' });
    return remoteBuild(await res.json());
  }

  /**
   * 'version' | 'commit' | null — stable compares versions (SemVer), the dev
   * channel compares commits (a later commit is newer, whatever the tag).
   */
  _isNewer(remote) { return newerBuild(remote, BUILD); }

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
        <button id="wr-back" class="wr-icon-btn" title="Documents" aria-label="Documents"${this.lib?.enabled ? '' : ' hidden'}>${ICONS.back}</button>
        <input id="wr-title" type="text" value="${esc(this.title)}" aria-label="Document title"
               autocomplete="off" autocorrect="on" spellcheck="false" enterkeyhint="done">
        <span id="wr-dirty" title="Not saved to the device" hidden></span>
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
    document.getElementById('wr-back').addEventListener('click', () => this.lib.openSheet());
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
    { id: 'indent',   label: 'Indent',         hint: '⇥',        keywords: 'tab nest right shift' },
    { id: 'outdent',  label: 'Outdent',        hint: '⇤',        keywords: 'tab unnest left shift' },
    { id: 'undo',     label: 'Undo',           keywords: 'revert back' },
    { id: 'redo',     label: 'Redo',           keywords: 'again forward' },
  ];

  _bindSlashMenu() {
    this.slash = new SlashMenu(document.getElementById('wr-main'), {
      items: UPubApp.SLASH_ITEMS,
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
    this.comments?.refresh();
    this._refreshDirty();
    this._refreshCount();
    this._persistSoon();
    if (!document.getElementById('wr-preview').hidden) this._renderPreview();
  }

  get isDirty() { return this.content !== (this.vcs.headContent ?? ''); }

  _refreshDirty() {
    const el = document.getElementById('wr-dirty');
    // The dot = the device is behind (changed since the last save, or never saved).
    if (el) el.hidden = !(this.lib ? this.lib.needsSave : this.isDirty);
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
      dslType: 'upub',
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
      await this.lib.persist(data);
    }
  }

  /**
   * The history snapshot of a save, tagged with its version — the device
   * write is the library's (`lib.save`), which calls this once the file is on
   * the device.
   */
  async commit(message, tag) {
    const author = (this.prefs.name || '').trim() || 'anonymous';
    const email = (this.prefs.email || '').trim() || '';
    await this.vcs.commit({ content: this.content, message: message || '', author, email, tag });
    clearDraft();
    this._refreshDirty();
    await this._persistNow();
  }

  /** Replace the open document (the library opened / created one, or a file). */
  _loadDocument(data) {
    this.data = data;
    this.vcs = new VCS(data);
    this.vcs.detachedHead = null;
    this._setTitle(data.title || 'Untitled');
    this._resetView?.();
    this.setContent(data.currentContent ?? this.vcs.headContent ?? '');
    if (!document.getElementById('wr-preview').hidden) this._renderPreview();
  }

  _setTitle(title) {
    this.title = title;
    const el = document.getElementById('wr-title');
    if (el) el.value = title;
    document.title = title;
  }

  setContent(text) {
    this.content = text;
    this.editor.setValue(text);
    this.comments?.clamp();
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
        ${this.lib?.enabled ? '<button data-act="documents">Documents</button>' : ''}
        <button data-act="save"${this.lib.needsSave && this.lib.nextVersion ? '' : ' disabled'}>Save${this.lib.nextVersion ? ` <span class="wr-menu-ver">${this.lib.nextVersion}</span>` : ''} to device${this.lib.needsSave ? ' <span class="wr-menu-dot"></span>' : ''}</button>
        ${this.lib.nextMajor ? `<button data-act="save-major">Save as new major <span class="wr-menu-ver">${this.lib.nextMajor}</span></button>` : ''}
        <button data-act="history">History${this.lib.savedVersion ? ` <span class="wr-menu-ver">${this.lib.savedVersion}</span>` : ''}</button>
        <button data-act="open-device">Open from device…</button>
        <button data-act="comments">Comments…</button>
        <button data-act="export">Export…</button>
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
        documents: () => this.lib.openSheet(),
        save: () => this._quickSave(),
        'save-major': () => this.lib.save({ major: true }),
        history: () => this._openHistory(),
        'open-device': () => this.lib.openFromDevice(),
        comments: () => this.comments.showSheet(),
        export: () => this._openExport(),
        new: () => this.lib.newDocument(),
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
    const dev = this.lib.device;
    const fmtDate = (t) => new Date(t).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    const cur = this.lib.savedVersion, next = this.lib.nextVersion, major = this.lib.nextMajor;
    const label = !cur ? 'Never saved to the device' : this.isDirty ? `Changed since ${esc(cur)}` : `${esc(cur)} not on the device`;
    const pending = this.lib.needsSave ? `
      <div class="wr-pending">
        <div class="wr-pending-head"><span class="wr-node"></span>${label}</div>
        <div class="wr-pending-row">
          <input id="wr-commit-msg" type="text" placeholder="A note on this version (optional)" autocomplete="off">
          <button id="wr-commit-btn" class="wr-primary"${next ? '' : ' disabled'}>Save <b id="wr-commit-next">${esc(next ?? '—')}</b></button>
        </div>
        ${major ? `<label class="wr-pending-major"><input type="checkbox" id="wr-commit-major"> new major version (${esc(major)})</label>` : ''}
      </div>` : `<div class="wr-clean">On the device as ${esc(dev?.fileName ?? cur ?? '')}.</div>`;

    const list = commits.length ? commits.map(c => `
      <div class="wr-commit" data-hash="${c.hash}">
        <div class="wr-commit-line">
          <span class="wr-commit-msg">${esc(c.message || '(no message)')}</span>
          ${c.tag ? `<span class="wr-tag">${esc(c.tag)}</span>` : `<span class="wr-tag">${esc(shortHash(c.hash))}</span>`}
          ${dev && dev.savedHead === c.hash ? `<span class="wr-tag wr-exported" title="${dev.saved ? 'The device holds this version' : 'On the device, changed since'}">on device</span>` : ''}
        </div>
        <div class="wr-commit-meta">${esc(c.author || '')} · ${fmtDate(c.timestamp)}</div>
        <button class="wr-restore" data-hash="${c.hash}">Restore</button>
      </div>`).join('') : '<div class="wr-clean">No saves yet.</div>';

    const modal = this._openSheet(`
      <div class="wr-sheet-head">History</div>
      <div class="wr-sheet-body">${pending}<div class="wr-log">${list}</div></div>`, 'tall');

    modal.querySelector('#wr-commit-major')?.addEventListener('change', (e) => {
      const el = modal.querySelector('#wr-commit-next');
      if (el) el.textContent = e.target.checked ? (major ?? '—') : (next ?? '—');
    });
    modal.querySelector('#wr-commit-btn')?.addEventListener('click', async () => {
      const msg = modal.querySelector('#wr-commit-msg').value.trim();
      const isMajor = !!modal.querySelector('#wr-commit-major')?.checked;
      this._closeSheet();
      await this.lib.save({ message: msg, major: isMajor });
    });
    modal.addEventListener('click', (e) => {
      const btn = e.target.closest('.wr-restore');
      if (!btn) return;
      const hash = btn.dataset.hash;
      if (hash === this.vcs.headHash && !this.isDirty) { this._closeSheet(); return; }
      if (!confirm('Restore this version into the editor? Your current text stays in history only if saved.')) return;
      this.setContent(this.vcs.getContentAt(hash));
      this._closeSheet();
      this._toast('Restored — save to keep it');
    });
  }

  /** Save now, no note (the menu's Save): the next version to the device. */
  async _quickSave() {
    await this.lib.save();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  _slug() { return slugify(this.title); }

  _openExport() {
    const modal = this._openSheet(`
      <div class="wr-sheet-head">Export</div>
      <div class="wr-menu">
        <button data-act="epub"><b>EPUB</b> — e-book for Apple Books, Kindle, Kobo…</button>
        <button data-act="md">Markdown (.md) — the raw text</button>
        ${IS_QUINE ? '<button data-act="quine">Save a copy (.html) — app + document in one file</button>' : ''}
      </div>`);
    modal.addEventListener('click', async (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      this._closeSheet();
      try {
        if (act === 'epub') await this._exportEpub();
        if (act === 'md') await shareOrDownloadFile(this.content, this._slug() + '.md', 'text/markdown');
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
        <p><b>{write}</b> v${esc(VERSION)}
          <span class="wr-mut">· build ${esc(BUILT)}${COMMIT
            ? ` · ${esc(COMMIT)}${COMMIT_AT ? ` (${esc(formatCommitAt(COMMIT_AT))})` : ''}` : ''}${isDevChannel()
            ? ' · dev channel — every push updates' : ''}</span></p>
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
      if (!this._isNewer(remote)) {
        status.textContent = `Up to date (${formatBuild(BUILD, { version: true })}).`;
        return;
      }
      status.textContent = isDevChannel()
        ? `New build ${formatBuild(remote, { commit: true })} available.`
        : `v${remote.version} available.`;
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
  // to the text.  It comes back the moment the keyboard is dismissed — iOS's
  // own accessory bar carries a dismiss (✓) button in standalone mode, so the
  // app adds no chrome of its own for this (a floating dismiss button and a
  // custom keyboard toolbar were both tried and scrapped as redundant).
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
    this._updateEditingChrome();
  }

  _updateEditingChrome() {
    const focused = document.activeElement === this.editor?.root;
    // No visualViewport (no keyboard signal at all) → fall back to focus alone.
    const kb = window.visualViewport ? !!this._kbOpen : true;
    const editing = !!(focused && kb && window.matchMedia('(pointer: coarse)').matches);
    document.getElementById('unifile-app').toggleAttribute('data-editing', editing);
  }

  /**
   * Reading chrome — the header gets out of the way IN STEP with scrolling,
   * the way Safari's toolbar does: each pixel scrolled down slides it one
   * pixel up (and fades it), each pixel scrolled up slides it back.
   *
   * Mechanics: scroll deltas drive `--wr-hide` (0 = shown … 1 = hidden) on
   * the app root; the header's margin-top/opacity are calc()'d from it.  While
   * a scroll is live, `data-scroll-tracking` suppresses the header transition
   * so it tracks 1:1; when scrolling goes idle the attribute drops and a
   * partial header SNAPS to the nearer edge through the normal transition.
   * Progress is additionally capped at scrollTop/47 so scrolling to the very
   * top always reveals the whole bar (and the idle snap near the top always
   * shows, never hides).  `data-scroll-hidden` now only marks the fully-hidden
   * state (pointer-events).  A document too short to scroll never hides (its
   * scrollTop can't move, so no deltas ever accumulate).  Independent of
   * `data-editing`: that rule out-specifies the calc(), so while editing the
   * header stays away regardless of scroll state.
   *
   * THE BOTTOM-CLAMP LOOP (real bug): the hide is not just visual — the shell
   * is a flex column, so sliding the header away grows the scroller.  With the
   * scroller AT the bottom, that means max scrollTop shrinks and the browser
   * clamps scrollTop down, firing scroll events for a "scroll up" the user
   * never made → show → scroller shrinks back → the still-running fling hides
   * again → the header bounces.  The clamp has an exact signature, though: an
   * upward delta that ends AT the (new) bottom edge — a real up-scroll always
   * lands above it.  Those deltas are dropped ("the floor rose, we didn't
   * move"), which also covers the snap animation's per-frame clamps, a
   * keyboard dismissal while scrolled to the end, and content shrinking under
   * the caret — while a genuine reversal anywhere (bottom included) still
   * moves the header from its very first pixel.  Showing never feeds back at
   * all: it shrinks the scroller, max GROWS, nothing clamps.  scrollTop is
   * clamped to the real range so iOS rubber-band never reads as travel.
   */
  _bindScrollChrome() {
    const app = document.getElementById('unifile-app');
    const H = 47;            // header height + border — the full slide distance
    let p = 0;               // hide progress: 0 shown … 1 hidden
    let lastTop = 0;         // clamped scrollTop of the most recent event
    let snapTimer = null;
    const apply = () => {
      app.style.setProperty('--wr-hide', String(p));
      app.toggleAttribute('data-scroll-hidden', p >= 1);
    };
    const snap = () => {
      app.removeAttribute('data-scroll-tracking');   // transitions back on
      const target = (lastTop <= H || p < 0.5) ? 0 : 1;
      if (target !== p) { p = target; apply(); }
    };
    const watch = (el) => {
      let last = el.scrollTop;
      el.addEventListener('scroll', () => {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const top = Math.min(Math.max(0, el.scrollTop), max);
        const d = top - last;
        last = top;
        if (d === 0) return;
        if (d < 0 && top >= max - 1) return;  // bottom-edge clamp, not the user (see above)
        lastTop = top;
        app.setAttribute('data-scroll-tracking', '');
        p = Math.min(Math.max(p + d / H, 0), 1, top / H);
        apply();
        clearTimeout(snapTimer);
        snapTimer = setTimeout(snap, 140);
      }, { passive: true });
    };
    watch(document.getElementById('wr-scroll'));
    watch(document.getElementById('wr-preview'));
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

  /**
   * iOS/WebKit: tapping the (unfocused) editor to place the caret can yank
   * #wr-scroll to the TOP of the document.  The editor is one contenteditable
   * spanning the whole document, and WebKit's focus-time "reveal the focused
   * element" scroll (plus a scroll-anchoring bug while the keyboard opens)
   * targets the ELEMENT's top rect, not the caret — so the view jumps to the
   * first line while the caret sits where you tapped, off-screen.
   *
   * Guard: remember the scroller position when the tap lands; for a short
   * window after the editor gains focus, any scroll that leaves the caret
   * OUTSIDE the visible pane is the browser's bogus reveal — restore the
   * tapped position (and, if the keyboard shrank the pane over the caret,
   * nudge the caret back into the lower part of the view).  A scroll that
   * keeps the caret visible (iOS's legit lift above the keyboard, or the
   * user's own flick — which also cancels the guard via touchmove/wheel)
   * is never touched.
   */
  _guardFocusScroll() {
    const scroll = document.getElementById('wr-scroll');
    let tapTop = null;      // scroller position at the moment of the tap
    let guardUntil = 0;     // guard is live until this timestamp
    let fixing = false;     // re-entrancy latch (our own fix fires 'scroll')

    scroll.addEventListener('pointerdown', () => {
      tapTop = scroll.scrollTop;
      // Only a tap that is about to FOCUS the editor triggers the reveal
      // scroll; taps while already editing never jump.
      guardUntil = document.activeElement === this.editor.root ? 0 : Date.now() + 900;
    }, { capture: true, passive: true });
    // A deliberate scroll gesture / wheel hands control back to the user.
    scroll.addEventListener('touchmove', () => { guardUntil = 0; }, { passive: true });
    scroll.addEventListener('wheel', () => { guardUntil = 0; }, { passive: true });

    const fix = () => {
      if (fixing || Date.now() > guardUntil) return;
      if (document.activeElement !== this.editor.root) return;
      const box = scroll.getBoundingClientRect();
      const rect = this.editor.caretRect();
      if (!rect || !box.height) return;
      const pad = 8;
      if (rect.bottom >= box.top + pad && rect.top <= box.bottom - pad) return;  // caret visible — all good
      fixing = true;
      if (tapTop != null) scroll.scrollTop = tapTop;
      const r2 = this.editor.caretRect();
      if (r2 && (r2.top < box.top + pad || r2.bottom > box.bottom - pad)) {
        scroll.scrollTop += r2.top - (box.top + box.height * 0.6);
      }
      fixing = false;
    };

    // The bogus reveal can land any time between focus and the end of the
    // keyboard animation — check on every scroll in the window, plus a few
    // timed sweeps (visualViewport resize = the keyboard actually moving).
    scroll.addEventListener('scroll', fix, { passive: true });
    window.visualViewport?.addEventListener('resize', () => setTimeout(fix, 0));
    this.editor.root.addEventListener('focus', () => {
      [0, 60, 160, 350, 650].forEach(ms => setTimeout(fix, ms));
    });
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
