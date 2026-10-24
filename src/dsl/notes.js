/**
 * {notes} DSL plugin — connected block notes (the Notion / Obsidian idea on
 * the standard shell).
 *
 * A note is a Markdown document in the library; the WORKSPACE is every note of
 * this app on the device.  The DSL is cross-file aware: `[[Page]]` links resolve
 * against the other notes' titles / aliases / names, `![[Page#^id]]` embeds
 * another note's block in place, and every page ends with its LINKED
 * REFERENCES (who links here, with the block they wrote) and UNLINKED MENTIONS
 * (who wrote the title without linking it — one click turns it into a link).
 * `wholeDocument: true`: preview.js hands render() the full text.
 *
 *   • core/notes/parse.js    one note → blocks, links, tags, headings, ids
 *   • core/notes/index.js    the workspace index: resolution, backlinks, graph
 *   • core/notes/search.js   quick find: ranking, snippets, highlight ranges
 *   • core/notes/graph.js    the force layout
 *   • core/notes/render.js   Markdown → the page's HTML (marked + extensions)
 *   • ui/notes-search.js     the Ctrl+K palette
 *   • ui/notes-graph.js      the graph canvas
 *
 * THE WORKSPACE INDEX lives here (`_ws`): built from `state.library.list()`
 * with the open document's LIVE text swapped in, parses cached per document
 * text, refreshed when a document changes / is saved / the library changes
 * and at most every 1.5 s at render time.  A quine has no library: the index
 * holds this one document (id 'self') and links to other pages stay
 * unresolved.
 *
 * Navigation goes through two app-level events (app.js): `open-record`
 * ({ id, hit, pane }) and `create-document` ({ title }) — a missing page is
 * created the moment its link is clicked, named after the title.
 *
 * SEARCH TERMS are shared state (`_terms`): a hit opened from the palette
 * highlights every occurrence in the editor (`searchField`) and in the page
 * (`_markTerms`) until Esc / the chip's × — Notion's contextual highlight.
 */

import DOMPurify from 'dompurify';
import { markdown as cmMarkdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { keymap, EditorView, Decoration, ViewPlugin } from '@codemirror/view';
import { EditorState, StateField, StateEffect, RangeSetBuilder, Prec } from '@codemirror/state';
import { linter } from '@codemirror/lint';
import { registerDSL } from './registry.js';
import { state } from '../ui/state.js';
import { getFrontMatterRange, parseGlobalFrontMatter } from '../core/front-matter.js';
import { schemaCompletions, schemaLint } from '../core/fm-schema.js';
import { formatShortcut } from '../core/keys.js';
import { parseNote, LINK_RE, TAG_RE, DATE_RE, newBlockId, normKey, isoDate } from '../core/notes/parse.js';
import { buildIndex } from '../core/notes/index.js';
import { highlightRanges } from '../core/notes/search.js';
import {
  renderNote, renderProperties, renderBacklinks, toggleTaskAt, blockIdEdit, noteDocument, esc,
} from '../core/notes/render.js';
import { NotesSearch } from '../ui/notes-search.js';
import { NotesGraph } from '../ui/notes-graph.js';

// ---------------------------------------------------------------------------
// The workspace index
// ---------------------------------------------------------------------------

const _ws = { index: null, at: 0, docs: [], cache: new Map() };   // cache: id → { text, note }
let _wsPromise = null;

/** The open document's id in the index. */
export function currentPageId() {
  return state.library ? (state.docId ?? 'self') : 'self';
}

function _docsFromRecords(records) {
  const cur = currentPageId();
  const docs = [];
  for (const r of records) {
    const text = r.id === cur ? (state.currentContent ?? '') : String(r.data?.currentContent ?? '');
    docs.push({ id: r.id, title: r.title, apiName: r.apiName ?? null, updatedAt: r.updatedAt ?? 0, text });
  }
  if (!docs.some(d => d.id === cur)) {
    docs.push({ id: cur, title: state.title, apiName: state.data?.apiName ?? null, updatedAt: Date.now(), text: state.currentContent ?? '' });
  }
  return docs;
}

function _indexFrom(docs) {
  const seen = new Set();
  for (const d of docs) {
    seen.add(d.id);
    const c = _ws.cache.get(d.id);
    if (c && c.text === d.text && c.title === d.title) d.note = c.note;
    else { d.note = parseNote(d.text, { title: d.title }); _ws.cache.set(d.id, { text: d.text, title: d.title, note: d.note }); }
  }
  for (const id of [..._ws.cache.keys()]) if (!seen.has(id)) _ws.cache.delete(id);
  return buildIndex(docs);
}

/** Rebuild the index now (reads the library); emits 'notes-index'. */
export async function refreshWorkspace() {
  if (_wsPromise) return _wsPromise;
  _wsPromise = (async () => {
    let records = [];
    if (state.library) { try { records = await state.library.list(); } catch { records = []; } }
    _ws.docs = _docsFromRecords(records);
    _ws.index = _indexFrom(_ws.docs);
    _ws.at = Date.now();
    state.emit('notes-index', _ws.index);
    return _ws.index;
  })();
  try { return await _wsPromise; } finally { _wsPromise = null; }
}

/** The index with the open document's live text, refreshing stale library data. */
async function _ensureIndex() {
  if (!_ws.index || Date.now() - _ws.at > 1500) return refreshWorkspace();
  return liveIndex();
}

/** The index rebuilt around the open document's current text (no library read). */
export function liveIndex() {
  if (!_ws.index) return null;
  const cur = currentPageId();
  const docs = _ws.docs.map(d => d.id === cur ? { ...d, title: state.title, text: state.currentContent ?? '' } : d);
  if (!docs.some(d => d.id === cur)) docs.push({ id: cur, title: state.title, apiName: state.data?.apiName ?? null, updatedAt: Date.now(), text: state.currentContent ?? '' });
  _ws.index = _indexFrom(docs);
  return _ws.index;
}

export function getIndex() { return _ws.index; }

state.on('document-change', () => { _ws.at = 0; refreshWorkspace(); });
state.on('saved', () => { _ws.at = 0; });
state.on('library-change', () => { _ws.at = 0; });

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const _hist = { stack: [], pos: -1, navigating: false };
state.on('document-change', ({ docId }) => {
  const id = docId ?? 'self';
  if (_hist.navigating) { _hist.navigating = false; return; }
  if (_hist.stack[_hist.pos] === id) return;
  _hist.stack = _hist.stack.slice(0, _hist.pos + 1);
  _hist.stack.push(id); _hist.pos = _hist.stack.length - 1;
});

function _isMobile() { return window.matchMedia('(max-width: 640px)').matches; }
function _mobilePane() { return document.getElementById('unifile-app')?.dataset.mobilePane ?? null; }

/** Open a page (another note, or this one at a range). */
export function openPage(id, hit = null, { pane } = {}) {
  const cur = currentPageId();
  if (id === cur || id === 'self') {
    if (hit) { state.emit('dsl-select', { from: hit.from, to: hit.to, focus: !_isMobile() }); _scrollPageTo(hit.from); }
    return;
  }
  if (!state.library) return;
  state.emit('open-record', { id, hit, pane: pane ?? (_isMobile() && _mobilePane() === 'render' ? 'render' : undefined) });
}

export function createPage(title) {
  const t = String(title ?? '').trim();
  if (!t) return;
  if (!state.library) { window.alert('This document stands alone (no library) — links to other pages cannot be created here.'); return; }
  state.emit('create-document', { title: t });
}

function _historyGo(d) {
  const i = _hist.pos + d;
  if (i < 0 || i >= _hist.stack.length) return;
  _hist.pos = i;
  _hist.navigating = true;
  state.emit('open-record', { id: _hist.stack[i], pane: _isMobile() && _mobilePane() === 'render' ? 'render' : undefined });
}

/** Scroll the page to the block holding `pos`. */
function _scrollPageTo(pos) {
  const root = _lastEl?.querySelector('.uf-notes');
  if (!root) return;
  let best = null;
  for (const b of root.querySelectorAll('.nb[data-doc-from]')) {
    const f = +b.dataset.docFrom, t = +b.dataset.docTo;
    if (pos >= f && pos <= t) { best = b; break; }
  }
  best?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Search terms (the contextual highlight)
// ---------------------------------------------------------------------------

let _terms = [];
export function setSearchTerms(terms) {
  _terms = (terms ?? []).filter(Boolean);
  state.emit('notes-search-terms', _terms);
  _rerender();
}

/** Wrap every occurrence of the terms in the page's text nodes with <mark>. */
function _markTerms(root, terms) {
  if (!terms.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.parentElement?.closest('.nb-bar, button, .nb-id, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  for (let n; (n = walker.nextNode());) if (n.nodeValue.trim()) nodes.push(n);
  for (const n of nodes) {
    const ranges = highlightRanges(n.nodeValue, terms);
    if (!ranges.length) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [a, b] of ranges) {
      if (a > pos) frag.appendChild(document.createTextNode(n.nodeValue.slice(pos, a)));
      const m = document.createElement('mark'); m.className = 'nb-mark'; m.textContent = n.nodeValue.slice(a, b);
      frag.appendChild(m); pos = b;
    }
    if (pos < n.nodeValue.length) frag.appendChild(document.createTextNode(n.nodeValue.slice(pos)));
    n.parentNode.replaceChild(frag, n);
  }
}

// ---------------------------------------------------------------------------
// The palette and the graph (singletons)
// ---------------------------------------------------------------------------

let _search = null;
export function openSearch(opts = {}) {
  if (!_search) {
    _search = new NotesSearch({
      getIndex: () => _ensureIndex(),
      currentId: () => currentPageId(),
      onOpen: (id, hit, terms) => { setSearchTerms(terms); openPage(id, hit, { pane: hit ? 'editor' : undefined }); },
      onCreate: (title) => createPage(title),
      onInsertLink: (title) => _insertAtCaret(`[[${title}]]`),
    });
  }
  return _search.open(opts);
}

let _view = 'page';            // 'page' | 'graph'
let _graph = null;             // NotesGraph while mounted
let _lastEl = null;

export function setView(v) {
  if (v === _view) return;
  _view = v;
  _rerender();
}
export function toggleView() { setView(_view === 'graph' ? 'page' : 'graph'); }

function _rerender() {
  if (_lastEl && _lastEl.isConnected) render(state.currentContent, _lastEl);
}

// The editor's caret (for inserting a link from the palette).
let _caret = 0;
state.on('editor-select', ({ from }) => { _caret = from ?? 0; });
state.on('checkout', () => { _caret = 0; });

function _insertAtCaret(text) {
  const len = (state.currentContent ?? '').length;
  const at = Math.max(0, Math.min(_caret, len));
  state.emit('dsl-edit', { changes: [{ from: at, to: at, insert: text }], selection: { anchor: at + text.length } });
}

/** Give the block at the caret an id (keeping an existing one) and copy its reference. */
export function copyBlockReference() {
  const text = state.currentContent ?? '';
  const edit = blockIdEdit(text, _caret, newBlockId());
  if (!edit) { window.alert('Put the cursor in a paragraph, list item or heading first.'); return; }
  if (edit.insert) state.emit('dsl-edit', { changes: [{ from: edit.from, to: edit.to, insert: edit.insert }], selection: { anchor: _caret } });
  const ref = `![[${state.title}#^${edit.id}]]`;
  navigator.clipboard?.writeText(ref).catch(() => {});
  _toast(`Copied ${ref}`);
}

function _toast(msg) {
  const root = document.getElementById('unifile-app') ?? document.body;
  let t = root.querySelector('.nb-toast');
  if (!t) { t = document.createElement('div'); t.className = 'nb-toast'; root.appendChild(t); }
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('is-on'), 1800);
}

/** Turn an unlinked mention (in `pageId` at from..to) into `[[Title]]`. */
async function _linkMention(pageId, from, to) {
  const title = state.title;
  if (pageId === currentPageId()) {
    state.emit('dsl-edit', { changes: [{ from, to, insert: `[[${title}]]` }] });
    return;
  }
  if (!state.library) return;
  const rec = await state.library.get(pageId);
  if (!rec) return;
  const text = String(rec.data?.currentContent ?? '');
  const mention = text.slice(from, to);
  if (normKey(mention) !== normKey(title) && !getIndex()?.page(currentPageId())?.note.aliases.some(a => normKey(a) === normKey(mention))) return;
  const alias = normKey(mention) === normKey(title) ? '' : `|${mention}`;
  const next = text.slice(0, from) + `[[${title}${alias}]]` + text.slice(to);
  await state.library.save(pageId, { data: { ...rec.data, currentContent: next } });
  _ws.at = 0;
  await refreshWorkspace();
  _rerender();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const BAR_HTML = () => `
  <div class="nb-bar" data-dsl-handled="1">
    <div class="nb-bar-nav">
      <button type="button" data-act="back" title="Back (Alt+←)" aria-label="Back" ${_hist.pos > 0 ? '' : 'disabled'}>‹</button>
      <button type="button" data-act="fwd" title="Forward (Alt+→)" aria-label="Forward" ${_hist.pos < _hist.stack.length - 1 ? '' : 'disabled'}>›</button>
    </div>
    <div class="nb-seg" role="group" aria-label="View">
      <button type="button" data-act="view-page" class="${_view === 'page' ? 'is-on' : ''}">Page</button>
      <button type="button" data-act="view-graph" class="${_view === 'graph' ? 'is-on' : ''}">Graph</button>
    </div>
    ${_terms.length ? `<button type="button" class="nb-chip" data-act="clear-terms" title="Stop highlighting (Esc)">⌕ ${esc(_terms.join(' '))} <span class="nb-chip-x">×</span></button>` : ''}
    <span class="nb-bar-sp"></span>
    <button type="button" class="nb-bar-search" data-act="search" title="Search (${esc(formatShortcut('Mod-k'))})"><span aria-hidden="true">⌕</span> Search</button>
  </div>`;

async function render(content, el) {
  _lastEl = el;
  if (!_hist.stack.length) { _hist.stack = [currentPageId()]; _hist.pos = 0; }   // the first page (init emits no document-change)
  const text = content ?? '';
  const index = await _ensureIndex();
  if (_lastEl !== el || !el.isConnected) return;
  const pageId = currentPageId();
  const page = index?.page(pageId) ?? null;
  const note = page?.note ?? parseNote(text, { title: state.title });

  // Keep the graph's canvas alive across renders (its positions and view).
  let root = el.querySelector(':scope > .uf-notes');
  if (!root) {
    el.innerHTML = '';
    root = document.createElement('div');
    root.className = 'uf-notes';
    root.addEventListener('click', _onClick);
    root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.nb-ref')) { e.preventDefault(); _onClick(e); } });
    el.appendChild(root);
  }
  root.querySelector(':scope > .nb-bar')?.remove();
  root.insertAdjacentHTML('afterbegin', BAR_HTML());
  root.dataset.view = _view;

  let body = root.querySelector(':scope > .nb-page');
  let gh = root.querySelector(':scope > .nb-graph-host');
  if (_view === 'graph') {
    body?.remove();
    if (!gh) {
      gh = document.createElement('div');
      gh.className = 'nb-graph-host';
      root.appendChild(gh);
      _graph = new NotesGraph(gh, {
        getIndex: () => _ws.index,
        currentId: () => currentPageId(),
        onOpen: (id) => openPage(id),
        onTag: (tag) => openSearch({ query: '#' + tag }),
        onCreate: (title) => createPage(title),
      });
    }
    _graph.update();
    return;
  }
  if (gh) { gh.remove(); _graph?.destroy(); _graph = null; }
  if (!body) { body = document.createElement('article'); body.className = 'nb-page'; root.appendChild(body); }

  if (!text.trim()) {
    body.innerHTML = `<p class="preview-empty">Write Markdown. <code>[[Page]]</code> links another note, <code>#tag</code> tags this one,
      <code>/</code> at a line start lists the blocks, <code>${esc(formatShortcut('Mod-k'))}</code> searches everything.</p>`;
    return;
  }
  const { html, blocks } = renderNote(text, { index, pageId, bodyFrom: note.bodyFrom, now: new Date() });
  const firstH1 = /^\s*#\s+(.+?)\s*$/m.exec(text.slice(note.bodyFrom).split('\n').find(l => l.trim()) ?? '');
  const showTitle = !(firstH1 && normKey(firstH1[1]) === normKey(state.title));
  const titleHtml = showTitle ? `<h1 class="nb-title" data-doc-from="0" data-doc-to="0">${esc(state.title)}</h1>` : '';
  const propsHtml = renderProperties(note, { index, pageId });
  const backHtml = renderBacklinks(index, pageId, { now: new Date() });
  body.innerHTML = _sanitize(titleHtml + propsHtml + `<div class="nb-body">${html}</div>` + backHtml);
  _markTerms(body, _terms);
  body._blocks = blocks;
}

function _sanitize(html) {
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'datetime'] });
}

/** One click handler for the whole page. */
function _onClick(e) {
  const t = e.target;
  const act = t.closest('[data-act]');
  if (act && t.closest('.nb-bar')) {
    e.stopPropagation();
    switch (act.dataset.act) {
      case 'back': _historyGo(-1); break;
      case 'fwd': _historyGo(1); break;
      case 'view-page': setView('page'); break;
      case 'view-graph': setView('graph'); break;
      case 'search': openSearch(); break;
      case 'clear-terms': setSearchTerms([]); break;
    }
    return;
  }
  const link = t.closest('a.nb-link, a.nb-ref-page');
  if (link) {
    e.preventDefault(); e.stopPropagation();
    const id = link.dataset.page;
    if (!id) { createPage(link.dataset.target); return; }
    const hit = link.dataset.from != null && (link.dataset.heading || link.dataset.block)
      ? { from: +link.dataset.from, to: +link.dataset.to } : null;
    openPage(id, hit);
    return;
  }
  const tag = t.closest('a.nb-tag');
  if (tag) { e.preventDefault(); e.stopPropagation(); openSearch({ query: '#' + tag.dataset.tag }); return; }
  if (act?.dataset.act === 'go') {
    const emb = act.closest('.nb-embed');
    e.stopPropagation();
    if (emb?.dataset.page) openPage(emb.dataset.page, { from: +emb.dataset.from, to: +emb.dataset.to });
    return;
  }
  if (act?.dataset.act === 'link-mention') {
    e.stopPropagation();
    _linkMention(act.dataset.page, +act.dataset.from, +act.dataset.to);
    return;
  }
  const ref = t.closest('.nb-ref');
  if (ref && !t.closest('a, button')) {
    e.stopPropagation();
    openPage(ref.dataset.page, { from: +ref.dataset.from, to: +ref.dataset.to });
    return;
  }
  const check = t.closest('button.nb-check');
  if (check) {
    e.stopPropagation();
    const block = check.closest('.nb[data-doc-from]');
    if (!block || block.closest('.nb-embed, .nb-backlinks')) return;
    const nth = [...block.querySelectorAll('button.nb-check')].indexOf(check);
    const edit = toggleTaskAt(state.currentContent ?? '', +block.dataset.docFrom, +block.dataset.docTo, nth);
    if (edit) state.emit('dsl-edit', { changes: [{ from: edit.from, to: edit.to, insert: edit.insert }] });
    return;
  }
  const bid = t.closest('.nb-id');
  if (bid) {
    e.stopPropagation();
    const emb = bid.closest('.nb-embed[data-page]');
    const title = emb ? (_ws.index?.page(emb.dataset.page)?.title ?? state.title) : state.title;
    const ref = `![[${title}#^${bid.dataset.blockId}]]`;
    navigator.clipboard?.writeText(ref).catch(() => {});
    _toast(`Copied ${ref}`);
    return;
  }
  // Anything else: preview.js's click-back (the block's data-doc-from) runs.
}

/** The quine's static preview / the HTML export body. */
function _renderStatic(content) {
  const index = _ws.index ?? buildIndex([{ id: 'self', title: state.title, text: content }]);
  const pageId = index.page(currentPageId()) ? currentPageId() : 'self';
  const note = index.page(pageId)?.note ?? parseNote(content, { title: state.title });
  const { html } = renderNote(content, { index, pageId, bodyFrom: note.bodyFrom, now: new Date() });
  return { propsHtml: renderProperties(note, { index, pageId }), bodyHtml: `<div class="nb-body">${html}</div>`, backlinksHtml: renderBacklinks(index, pageId) };
}

function renderToString(content) {
  const r = _renderStatic(content ?? '');
  return `<div class="uf-notes"><article class="nb-page"><h1 class="nb-title">${esc(state.title)}</h1>${r.propsHtml}${r.bodyHtml}${r.backlinksHtml}</article></div>`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

async function exportHTML(content) {
  const r = _renderStatic(content);
  return new Blob([noteDocument({ title: state.title, ...r })], { type: 'text/html' });
}

async function exportMarkdown(content) {
  return new Blob([content ?? ''], { type: 'text/markdown' });
}

async function exportPDF(content) {
  const r = _renderStatic(content);
  const win = window.open('', '_blank');
  if (!win) return null;
  win.document.open();
  win.document.write(noteDocument({ title: state.title, ...r }).replace('</head>', '<style>@page{margin:0.75in} .nb-ref-link,.nb-embed-go{display:none}</style></head>'));
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 300);
  return null;
}

// ---------------------------------------------------------------------------
// Editor — decorations
// ---------------------------------------------------------------------------

const refreshNotesEffect = StateEffect.define();
const setTermsEffect = StateEffect.define();

const linkMark = Decoration.mark({ class: 'cm-nb-link' });
const linkMissingMark = Decoration.mark({ class: 'cm-nb-link cm-nb-link-missing' });
const tagMark = Decoration.mark({ class: 'cm-nb-tag' });
const idMark = Decoration.mark({ class: 'cm-nb-id' });
const dateMark = Decoration.mark({ class: 'cm-nb-date' });
const searchMark = Decoration.mark({ class: 'cm-nb-search' });

function _inlineDecos(view) {
  const builder = new RangeSetBuilder();
  const index = _ws.index;
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    LINK_RE.lastIndex = 0;
    for (let m; (m = LINK_RE.exec(text));) {
      const target = m[2].trim();
      const missing = target && index && !index.resolve(target);
      ranges.push([from + m.index, from + m.index + m[0].length, missing ? linkMissingMark : linkMark]);
    }
    TAG_RE.lastIndex = 0;
    for (let m; (m = TAG_RE.exec(text));) {
      const s = from + m.index + m[1].length;
      ranges.push([s, s + 1 + m[2].length, tagMark]);
    }
    DATE_RE.lastIndex = 0;
    for (let m; (m = DATE_RE.exec(text));) {
      const s = from + m.index + m[1].length;
      ranges.push([s, s + 1 + m[2].length, dateMark]);
    }
    const idRe = /(^|\s)(\^[A-Za-z0-9][\w-]*)[ \t]*$/gm;
    for (let m; (m = idRe.exec(text));) {
      const s = from + m.index + m[1].length;
      ranges.push([s, s + m[2].length, idMark]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let last = -1;
  for (const [a, b, d] of ranges) { if (a < last) continue; builder.add(a, b, d); last = b; }
  return builder.finish();
}

const inlinePlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = _inlineDecos(view);
    this._off = state.on('notes-index', () => view.dispatch({ effects: refreshNotesEffect.of(null) }));
  }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.transactions.some(tr => tr.effects.some(e => e.is(refreshNotesEffect)))) {
      this.decorations = _inlineDecos(u.view);
    }
  }
  destroy() { this._off?.(); }
}, { decorations: v => v.decorations });

function _searchDecos(doc, terms) {
  const builder = new RangeSetBuilder();
  if (!terms.length) return builder.finish();
  const text = doc.toString();
  for (const [a, b] of highlightRanges(text, terms)) builder.add(a, b, searchMark);
  return builder.finish();
}

const searchField = StateField.define({
  create(s) { return _searchDecos(s.doc, _terms); },
  update(deco, tr) {
    const eff = tr.effects.find(e => e.is(setTermsEffect));
    if (eff) return _searchDecos(tr.state.doc, eff.value);
    if (tr.docChanged) return _searchDecos(tr.state.doc, _terms);
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

const termsWatcher = ViewPlugin.fromClass(class {
  constructor(view) {
    this._off = state.on('notes-search-terms', (terms) => view.dispatch({ effects: setTermsEffect.of(terms) }));
  }
  destroy() { this._off?.(); }
});

// Mod-click on a [[link]] → open / create the page.
const linkClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    LINK_RE.lastIndex = 0;
    for (let m; (m = LINK_RE.exec(line.text));) {
      const a = line.from + m.index, b = a + m[0].length;
      if (pos < a || pos > b) continue;
      e.preventDefault();
      const target = m[2].trim();
      const frag = (m[3] ?? '').trim();
      const ref = { target, heading: frag && !frag.startsWith('^') ? frag : null, block: frag.startsWith('^') ? frag.slice(1) : null };
      const index = _ws.index;
      const page = target ? index?.resolve(target) : index?.page(currentPageId());
      if (!page) { createPage(target); return true; }
      const r = index.resolveRef(ref, currentPageId());
      openPage(page.id, r && (ref.heading || ref.block) ? { from: r.from, to: r.to } : null);
      return true;
    }
    return false;
  },
});

// ---------------------------------------------------------------------------
// Editor — completion
// ---------------------------------------------------------------------------

const notesFrontMatterSchema = {
  title:   { type: 'string', doc: 'The page title — what `[[…]]` links point at.' },
  aliases: { type: 'string', doc: 'Other names this page answers to: `aliases: Alpha, The Project`.' },
  tags:    { type: 'string', doc: 'Tags: `tags: work, planning` (also `#tag` in the text).' },
  status:  { type: 'string', doc: 'Any property shows in the page header: status, owner, due …' },
  due:     { type: 'string', doc: 'A date (`2026-11-01`) renders as a date chip.' },
};

const SLASH_BLOCKS = [
  ['h1', 'Heading 1', '# '], ['h2', 'Heading 2', '## '], ['h3', 'Heading 3', '### '],
  ['todo', 'To-do', '- [ ] '], ['bullet', 'Bulleted list', '- '], ['number', 'Numbered list', '1. '],
  ['toggle', 'Toggle', '> [!toggle] Title\n> '], ['callout', 'Callout', '> [!note] '], ['tip', 'Tip callout', '> [!tip] '],
  ['warning', 'Warning callout', '> [!warning] '], ['quote', 'Quote', '> '], ['code', 'Code block', '```\n\n```'],
  ['divider', 'Divider', '---\n'], ['table', 'Table', '| Column | Column |\n|---|---|\n|  |  |\n'],
  ['page', 'Link to page', '[['], ['embed', 'Embed a block', '![['], ['date', 'Date (today)', () => '@' + isoDate(new Date())],
  ['tag', 'Tag', '#'],
];

function notesComplete(context) {
  try {
    const doc = context.state.doc;
    const region = getFrontMatterRange(doc.toString());
    if (region && context.pos <= region.bodyFrom) {
      return schemaCompletions(notesFrontMatterSchema, region, context.pos, context.explicit);
    }
    const line = doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const index = _ws.index;
    const pages = index ? index.list() : [];
    const cur = currentPageId();

    // [[Pa… / [[Page#He… / [[Page#^bl…
    const lk = /!?\[\[([^\[\]|#]*)(?:#(\^?[^\[\]|]*))?$/.exec(before);
    if (lk) {
      if (lk[2] != null) {
        const page = lk[1].trim() ? index?.resolve(lk[1]) : index?.page(cur);
        if (!page) return null;
        const typed = lk[2];
        const isBlock = typed.startsWith('^');
        const opts = isBlock
          ? page.note.blocks.filter(b => b.id).map(b => ({ label: '^' + b.id, type: 'constant', detail: b.text.replace(/\s+/g, ' ').slice(0, 60), apply: '^' + b.id + ']]' }))
          : page.note.headings.map(h => ({ label: h.text, type: 'type', detail: 'H' + h.level, apply: h.text + ']]' }));
        return { from: context.pos - typed.length, validFor: /^\^?[^\]\[|#]*$/, options: opts };
      }
      const typed = lk[1];
      const opts = pages.filter(p => p.id !== cur || true).map(p => ({
        label: p.title, type: 'variable', detail: p.apiName ?? undefined, boost: p.id === cur ? -1 : 0, apply: p.title + ']]',
      }));
      if (typed.trim() && !pages.some(p => normKey(p.title) === normKey(typed))) {
        opts.push({ label: typed.trim(), type: 'text', detail: 'new page', apply: typed.trim() + ']]', boost: -2 });
      }
      return { from: context.pos - typed.length, validFor: /^[^\]\[|#]*$/, options: opts };
    }
    // @Pa… → [[Page]] ; @tod… → @today
    const at = /(^|[\s(])@([^\s@\[\]]*)$/.exec(before);
    if (at) {
      const typed = at[2];
      // The range CM filters on excludes the `@` (labels have none); `apply` replaces it too.
      const replaceTrigger = (text) => (view, _c, f, t) => view.dispatch({ changes: { from: f - 1, to: t, insert: text }, selection: { anchor: f - 1 + text.length } });
      const opts = pages.map(p => ({ label: p.title, type: 'variable', detail: 'page', apply: replaceTrigger(`[[${p.title}]]`) }));
      for (const d of ['today', 'tomorrow', 'yesterday']) opts.push({ label: d, type: 'keyword', detail: 'date', apply: replaceTrigger('@' + d), boost: 1 });
      return { from: context.pos - typed.length, validFor: /^[^\s@\[\]]*$/, options: opts };
    }
    // #ta… (not a heading)
    const tg = /(^|[\s(])#([\p{L}\p{N}_/-]*)$/u.exec(before);
    if (tg && !/^\s*#+\s*$/.test(before) && index) {
      const typed = tg[2];
      if (!typed && !context.explicit) return null;
      const opts = index.tagList().map(t => ({ label: '#' + t.tag, type: 'keyword', detail: `${t.pages} ${t.pages === 1 ? 'page' : 'pages'}`, apply: '#' + t.tag }));
      if (!opts.length) return null;
      return { from: context.pos - typed.length - 1, validFor: /^#[\p{L}\p{N}_/-]*$/u, options: opts };
    }
    // /blo… at a line start → the block menu
    const sl = /^\s*\/(\w*)$/.exec(before);
    if (sl) {
      const typed = sl[1];
      // Filter on the word after the `/` (not the slash itself); `apply` replaces both.
      return {
        from: context.pos - typed.length, validFor: /^\w*$/,
        options: SLASH_BLOCKS.map(([id, label, tpl]) => ({
          label, type: 'keyword', detail: id,
          apply: (view, _c, f, t) => {
            const text = typeof tpl === 'function' ? tpl() : tpl;
            const start = f - 1;
            const cursor = text === '```\n\n```' ? start + 4 : start + text.length;
            view.dispatch({ changes: { from: start, to: t, insert: text }, selection: { anchor: cursor } });
          },
        })),
      };
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Editor — lint
// ---------------------------------------------------------------------------

function notesLint(view) {
  const doc = view.state.doc.toString();
  const docLen = doc.length;
  const out = [];
  const region = getFrontMatterRange(doc);
  if (region) {
    out.push(...schemaLint(notesFrontMatterSchema, region)
      .filter(d => !/unknown/i.test(d.message))          // any property is welcome
      .map(d => ({ ...d, from: Math.max(0, Math.min(d.from, docLen)), to: Math.max(0, Math.min(d.to, docLen)) })));
  }
  const index = _ws.index;
  if (index) {
    const note = parseNote(doc, { title: state.title });
    for (const l of note.links) {
      if (!l.target) continue;
      const page = index.resolve(l.target);
      if (!page) {
        out.push({ from: l.from, to: l.to, severity: 'info', message: `No page “${l.target}” yet — click the link in the page (or ${formatShortcut('Mod')}-click here) to create it.`,
                   actions: [{ name: 'Create page', apply: () => createPage(l.target) }] });
      } else if ((l.heading || l.block) && !index.resolveRef({ target: l.target, heading: l.heading, block: l.block })) {
        out.push({ from: l.from, to: l.to, severity: 'warning',
                   message: l.block ? `${page.title} has no block ^${l.block}.` : `${page.title} has no heading “${l.heading}”.` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editor — keys
// ---------------------------------------------------------------------------

const notesKeymap = keymap.of([
  { key: 'Mod-k', preventDefault: true, run: () => { openSearch(); return true; } },
  { key: 'Mod-Shift-g', preventDefault: true, run: () => { toggleView(); return true; } },
  { key: 'Mod-Alt-l', preventDefault: true, run: () => { openSearch({ mode: 'link' }); return true; } },
  { key: 'Alt-ArrowLeft', run: () => { _historyGo(-1); return true; } },
  { key: 'Alt-ArrowRight', run: () => { _historyGo(1); return true; } },
  { key: 'Escape', run: () => { if (!_terms.length) return false; setSearchTerms([]); return true; } },
]);

// Global keys (the editor may not have focus — the palette's whole point).
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (state.data?.dslType !== 'notes') return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      if (_search?.isOpen) return;
      e.preventDefault(); openSearch();
    } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'G' || e.key === 'g')) {
      e.preventDefault(); toggleView();
    }
  });
}

function getEditorExtensions() {
  const md = cmMarkdown({ base: markdownLanguage });
  if (!_ws.index) refreshWorkspace();
  return [
    md,
    EditorState.languageData.of(() => [{ autocomplete: notesComplete }]),
    keymap.of(markdownKeymap),
    Prec.high(notesKeymap),
    linter(notesLint, { delay: 600 }),
    inlinePlugin,
    searchField,
    termsWatcher,
    linkClick,
  ];
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const notesDSL = {
  id: 'notes',
  label: 'Nt',
  version: '1.0.0',
  name: 'Notes',
  extensions: ['.md'],
  editorMode: 'markdown',
  commentTokens: { block: { open: '<!--', close: '-->' } },
  wholeDocument: true,
  themeAware: true,          // the graph draws with the theme's colours

  render,
  renderToString,
  print: exportPDF,
  getEditorExtensions,
  teardown(el) { if (_graph && el?.contains(_graph.host)) { _graph.destroy(); _graph = null; } },

  // Listed in the help modal's Keyboard → Shortcuts (topbar.js keyboardHelpSection).
  shortcuts: [
    ['Mod-k', 'Search the workspace (quick find)'],
    ['Mod-Shift-g', 'Graph / page view'],
    ['Mod-Alt-l', 'Link to a page… (inserts <code>[[Title]]</code>)'],
    ['Mod-click', 'Open the <code>[[link]]</code> under the pointer (a missing page is created)'],
    ['Alt-←', 'Back to the previous page'],
    ['Alt-→', 'Forward'],
    ['Escape', 'Stop highlighting the last search'],
  ],

  actions: [
    { id: 'search', label: 'Search…', glyph: '⌕', run: () => openSearch() },
    { id: 'graph', label: 'Graph / page view', glyph: '⊛', run: () => toggleView() },
    { id: 'link', label: 'Link to page…', glyph: '⟦', run: ({ editor } = {}) => { const v = editor?._view; if (v) _caret = v.state.selection.main.head; openSearch({ mode: 'link' }); } },
    { id: 'block-ref', label: 'Copy block reference', glyph: '^', run: ({ editor } = {}) => { const v = editor?._view; if (v) _caret = v.state.selection.main.head; copyBlockReference(); } },
  ],
  renderActions: [
    { id: 'search', label: 'Search', glyph: '⌕', run: () => openSearch() },
    { id: 'graph', label: 'Graph / page', glyph: '⊛', run: () => toggleView() },
    { id: 'fit', label: 'Fit graph', glyph: '⛶', run: () => { if (_view !== 'graph') setView('graph'); else _graph?.fit(); } },
  ],

  exporters: {
    md:   { label: 'Markdown', mime: 'text/markdown', ext: '.md', export: exportMarkdown },
    html: { label: 'HTML', mime: 'text/html', ext: '.html', export: exportHTML },
    pdf:  { label: 'PDF', mime: 'application/pdf', ext: '.pdf', export: exportPDF },
  },

  detect(content) {
    return /\[\[[^\]]+\]\]/.test(content) || /(^|\s)#[\p{L}_][\w/-]*/u.test(content);
  },
};

registerDSL(notesDSL);
export default notesDSL;
