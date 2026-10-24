/**
 * {notes} — the PAGE renderer (pure: marked only, no DOM; `test/notes.test.mjs`).
 *
 * Markdown → HTML through ONE marked instance carrying the notes extensions:
 *
 *   [[Page]] / [[Page#H]] / [[Page#^id]] / [[Page|alias]]  → <a class="nb-link"> (a page chip; `is-missing`
 *                                                            when no page answers — click creates it)
 *   ![[Page#^id]] on its own line                           → <div class="nb-embed"> with the referenced
 *                                                            block / section / page rendered IN PLACE
 *   #tag                                                    → <a class="nb-tag">
 *   @2026-10-24 / @today                                    → <time class="nb-date">
 *   ^id at a block's end                                    → <span class="nb-id"> (the block's handle)
 *   > [!note] Title / [!tip] [!warning] [!toggle] …         → callouts / a <details> toggle
 *   - [ ] task                                              → <button class="nb-check"> (the page toggles the text)
 *
 * The page is rendered BLOCK BY BLOCK (`renderNote`): every top-level token
 * becomes `<div class="nb" data-doc-from data-doc-to>` so the preview's
 * click-back, the hover handle and the search highlight know where a block
 * lives in the text.  Resolution needs the workspace index (core/notes/index.js);
 * the renderer reads it from a per-call context so the same instance serves
 * embeds and backlinks (rendered in THEIR page's context).
 *
 * The output is not sanitised here — the DSL runs DOMPurify on it (a Node
 * test has no DOM).  Nothing here emits user text unescaped.
 */

import { Marked } from 'marked';
import { LINK_RE, TAG_RE, DATE_RE, BLOCK_ID_RE, resolveDateMention, splitBlocks } from './parse.js';

export const CALLOUT_GLYPHS = {
  note: '✎', info: 'ⓘ', tip: '✦', hint: '✦', important: '❗', warning: '⚠︎', caution: '⚠︎', danger: '⨯',
  error: '⨯', bug: '⨯', question: '?', help: '?', success: '✓', done: '✓', check: '✓', quote: '❝', cite: '❝',
  example: '≡', abstract: '≡', summary: '≡', tldr: '≡', todo: '☐', idea: '✦',
};

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// The render context — what the extensions need to resolve references
// ---------------------------------------------------------------------------

const ctx = {
  index: null,        // Index | null
  pageId: null,       // the page being rendered (for `[[#Heading]]` and embeds)
  depth: 0,           // embed nesting
  now: null,          // Date for @today
  embedStack: [],     // ref keys being embedded (cycle guard)
};

function withContext(patch, fn) {
  const prev = { ...ctx, embedStack: ctx.embedStack };
  Object.assign(ctx, patch);
  try { return fn(); } finally { Object.assign(ctx, prev); }
}

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

function linkLabel(link, page) {
  if (link.alias) return link.alias;
  const name = page ? page.title : (link.target || '');
  const parts = [];
  if (link.target) parts.push(name);
  if (link.heading) parts.push(link.heading);
  if (link.block) parts.push('^' + link.block);
  return parts.join(' › ');
}

function linkHtml(link, { embedInline = false } = {}) {
  const page = link.target ? ctx.index?.resolve(link.target) ?? null : (ctx.pageId && ctx.index ? ctx.index.page(ctx.pageId) : null);
  const missing = !page;
  const ref = page && ctx.index ? ctx.index.resolveRef({ target: link.target, heading: link.heading, block: link.block }, ctx.pageId) : null;
  const dangling = page && !ref && (link.heading || link.block);
  const cls = ['nb-link', missing ? 'is-missing' : '', dangling ? 'is-dangling' : '', embedInline ? 'is-embed' : ''].filter(Boolean).join(' ');
  const title = missing ? `No page “${link.target}” yet — click to create it`
    : dangling ? `“${link.heading ? link.heading : '^' + link.block}” is not in ${page.title}` : page.title;
  return `<a class="${cls}" href="#" title="${esc(title)}" data-target="${esc(link.target)}"`
    + (page ? ` data-page="${esc(page.id)}"` : '')
    + (link.heading ? ` data-heading="${esc(link.heading)}"` : '')
    + (link.block ? ` data-block="${esc(link.block)}"` : '')
    + (ref ? ` data-from="${ref.from}" data-to="${ref.to}"` : '')
    + `><span class="nb-link-mark">${missing ? '+' : '⊛'}</span>${esc(linkLabel(link, page))}</a>`;
}

function parseLinkToken(m) {
  const frag = m[3] != null ? m[3].trim() : '';
  return {
    embed: m[1] === '!', target: m[2].trim(),
    heading: frag && !frag.startsWith('^') ? frag : null,
    block: frag.startsWith('^') ? frag.slice(1) : null,
    alias: m[4] != null ? m[4].trim() : null,
  };
}

const wikilinkExt = {
  name: 'nbLink', level: 'inline',
  start(src) { const i = src.indexOf('[['); return i < 0 ? undefined : (i > 0 && src[i - 1] === '!' ? i - 1 : i); },
  tokenizer(src) {
    const re = new RegExp('^' + LINK_RE.source);
    const m = re.exec(src);
    if (!m) return undefined;
    const link = parseLinkToken(m);
    if (!link.target && !link.heading && !link.block) return undefined;
    return { type: 'nbLink', raw: m[0], link };
  },
  renderer(tok) { return linkHtml(tok.link, { embedInline: tok.link.embed }); },
};

const embedExt = {
  name: 'nbEmbed', level: 'block',
  start(src) { const m = /(^|\n)[ \t]*!\[\[/.exec(src); return m ? m.index + m[1].length : undefined; },
  tokenizer(src) {
    const m = /^[ \t]*(!\[\[[^\]\n]*\]\])[ \t]*(\^[\w-]+)?[ \t]*(?:\n+|$)/.exec(src);
    if (!m) return undefined;
    const lm = new RegExp('^' + LINK_RE.source).exec(m[1]);
    if (!lm) return undefined;
    return { type: 'nbEmbed', raw: m[0], link: parseLinkToken(lm), id: m[2] ? m[2].slice(1) : null };
  },
  renderer(tok) { return embedHtml(tok.link, tok.id); },
};

function embedHtml(link, id) {
  const idHtml = id ? `<span class="nb-id" data-block-id="${esc(id)}">^${esc(id)}</span>` : '';
  const ref = ctx.index ? ctx.index.resolveRef({ target: link.target, heading: link.heading, block: link.block }, ctx.pageId) : null;
  if (!ref) {
    return `<div class="nb-embed is-missing">${linkHtml(link)} <span class="nb-embed-note">— nothing to embed</span>${idHtml}</div>\n`;
  }
  const key = `${ref.page.id}:${ref.from}:${ref.to}`;
  if (ctx.depth >= 3 || ctx.embedStack.includes(key)) {
    return `<div class="nb-embed is-cycle">${linkHtml(link)} <span class="nb-embed-note">— embeds itself</span>${idHtml}</div>\n`;
  }
  const text = ref.page.text.slice(ref.from, ref.to);
  const inner = withContext({ pageId: ref.page.id, depth: ctx.depth + 1, embedStack: [...ctx.embedStack, key] }, () => md.parse(text));
  const crumb = [ref.page.title, ref.heading ? ref.heading.text : null, ref.block?.id ? '^' + ref.block.id : null].filter(Boolean).join(' › ');
  return `<div class="nb-embed" data-page="${esc(ref.page.id)}" data-from="${ref.from}" data-to="${ref.to}">`
    + `<div class="nb-embed-head"><span class="nb-embed-crumb">${esc(crumb)}</span>`
    + `<button type="button" class="nb-embed-go" data-act="go" title="Open the source">↗</button></div>`
    + `<div class="nb-embed-body">${inner}</div>${idHtml}</div>\n`;
}

const tagExt = {
  name: 'nbTag', level: 'inline',
  start(src) {
    const re = new RegExp(TAG_RE.source, 'u');
    const m = re.exec(src); return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = /^#([\p{L}_][\p{L}\p{N}_/-]*)/u.exec(src);
    if (!m) return undefined;
    const tag = m[1].replace(/\/+$/, '');
    return { type: 'nbTag', raw: '#' + tag, tag };
  },
  renderer(tok) { return `<a class="nb-tag" href="#" data-tag="${esc(tok.tag)}">#${esc(tok.tag)}</a>`; },
};

const dateExt = {
  name: 'nbDate', level: 'inline',
  start(src) { const re = new RegExp(DATE_RE.source); const m = re.exec(src); return m ? m.index + m[1].length : undefined; },
  tokenizer(src) {
    const m = /^@(today|tomorrow|yesterday|\d{4}-\d{2}-\d{2})\b/.exec(src);
    if (!m) return undefined;
    return { type: 'nbDate', raw: m[0], value: m[1] };
  },
  renderer(tok) {
    const iso = resolveDateMention(tok.value, ctx.now ?? new Date());
    const label = /^\d/.test(tok.value) ? formatDate(iso) : `${formatDate(iso)} <small>(${tok.value})</small>`;
    return `<time class="nb-date" datetime="${esc(iso)}">${label}</time>`;
  },
};

const blockIdExt = {
  name: 'nbBlockId', level: 'inline',
  start(src) { const m = /(^|\s)\^[A-Za-z0-9][\w-]*[ \t]*(\n|$)/.exec(src); return m ? m.index + m[1].length : undefined; },
  tokenizer(src) {
    const m = /^\^([A-Za-z0-9][\w-]*)[ \t]*(?=\n|$)/.exec(src);
    if (!m) return undefined;
    return { type: 'nbBlockId', raw: m[0], id: m[1] };
  },
  renderer(tok) { return `<span class="nb-id" data-block-id="${esc(tok.id)}" title="Block id — ![[Page#^${esc(tok.id)}]] embeds this block">^${esc(tok.id)}</span>`; },
};

/** `Oct 24, 2026` from an ISO date (falls back to the raw string). */
export function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return esc(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`;
}

/** Blockquotes starting with `[!type] Title` are callouts; `[!toggle]` folds. */
function blockquoteRenderer(quote) {
  const m = /^<p>\[!([\w-]+)\]([^<\n]*)(<br>\s*|\n|<\/p>\s*)/.exec(quote);
  if (!m) return `<blockquote>\n${quote}</blockquote>\n`;
  const type = m[1].toLowerCase();
  const title = m[2].trim();
  let rest = quote.slice(m[0].length);
  if (!m[3].startsWith('</p>')) rest = '<p>' + rest;      // the title was the paragraph's first line
  if (type === 'toggle' || type === 'toggle-open' || type === 'details' || type === 'fold') {
    const open = type === 'toggle-open' ? ' open' : '';
    return `<details class="nb-toggle"${open}><summary>${title || 'Toggle'}</summary><div class="nb-toggle-body">${rest}</div></details>\n`;
  }
  const glyph = CALLOUT_GLYPHS[type] ?? '✎';
  return `<div class="nb-callout nb-callout-${esc(type)}"><div class="nb-callout-head"><span class="nb-callout-icon">${glyph}</span>`
    + `<span class="nb-callout-title">${title || type[0].toUpperCase() + type.slice(1)}</span></div>`
    + (rest.trim() ? `<div class="nb-callout-body">${rest}</div>` : '') + `</div>\n`;
}

function checkboxRenderer(checked) {
  return `<button type="button" class="nb-check${checked ? ' is-checked' : ''}" role="checkbox" aria-checked="${checked ? 'true' : 'false'}" data-checked="${checked ? 1 : 0}"></button> `;
}

function headingRenderer(text, level, raw) {
  const plain = String(raw ?? text).replace(BLOCK_ID_RE, '').replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().toLowerCase().replace(/\s+/g, '-');
  return `<h${level} id="${esc(plain)}">${text}</h${level}>\n`;
}

export const md = new Marked({ gfm: true, breaks: true });
md.use({
  extensions: [embedExt, wikilinkExt, tagExt, dateExt, blockIdExt],
  renderer: { blockquote: blockquoteRenderer, checkbox: checkboxRenderer, heading: headingRenderer },
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * Render a note's BODY block by block.
 * @param {string} text        the whole document
 * @param {object} opts
 * @param {import('./index.js').Index|null} opts.index
 * @param {string|null} opts.pageId   this note's id in the index
 * @param {number} opts.bodyFrom      where the body starts (after the front matter)
 * @param {Date} [opts.now]
 * @returns {{ html: string, blocks: Array<{ from, to, type }> }}
 */
export function renderNote(text, { index = null, pageId = null, bodyFrom = 0, now = null } = {}) {
  const body = String(text ?? '').slice(bodyFrom);
  return withContext({ index, pageId, depth: 0, now, embedStack: [] }, () => {
    const tokens = md.lexer(body);
    const links = tokens.links;
    let pos = bodyFrom;
    const blocks = [];
    let html = '';
    for (const tok of tokens) {
      const raw = tok.raw ?? '';
      const from = pos;
      pos += raw.length;
      if (tok.type === 'space' || !raw.trim()) continue;
      const to = from + raw.replace(/\s+$/, '').length;
      const one = [tok]; one.links = links;
      const inner = md.parser(one);
      blocks.push({ from, to, type: tok.type });
      html += `<div class="nb nb-${esc(tok.type)}" data-doc-from="${from}" data-doc-to="${to}">${inner}</div>\n`;
    }
    return { html, blocks };
  });
}

/** Inline Markdown (a property value, a title) in a page's context. */
export function renderInline(text, { index = null, pageId = null, now = null } = {}) {
  return withContext({ index, pageId, depth: 0, now, embedStack: [] }, () => md.parseInline(String(text ?? '')));
}

/** A fragment of another page (a backlink's block) in THAT page's context. */
export function renderFragment(text, { index = null, pageId = null, now = null } = {}) {
  return withContext({ index, pageId, depth: 1, now, embedStack: [] }, () => md.parse(String(text ?? '')));
}

/**
 * The properties table (front matter keys other than title/aliases): tags
 * become chips, dates `<time>`, everything else inline Markdown.
 */
export function renderProperties(note, opts = {}) {
  const rows = [];
  for (const [k, v] of note.properties) {
    if (v == null || v === '' || typeof v === 'object') continue;
    let val;
    if (k === 'tags') {
      val = String(v).replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean)
        .map(t => `<a class="nb-tag" href="#" data-tag="${esc(t)}">#${esc(t)}</a>`).join(' ');
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(v).trim())) {
      val = `<time class="nb-date" datetime="${esc(String(v).trim())}">${formatDate(String(v).trim())}</time>`;
    } else {
      val = renderInline(String(v), opts);
    }
    rows.push(`<tr><th>${esc(k)}</th><td>${val}</td></tr>`);
  }
  if (!rows.length) return '';
  return `<table class="nb-props"><tbody>${rows.join('')}</tbody></table>`;
}

/**
 * "Linked references" + "Unlinked mentions" for a page.
 * @returns {string} HTML ('' when there are none)
 */
export function renderBacklinks(index, pageId, { now = null } = {}) {
  if (!index) return '';
  const back = index.backlinks(pageId);
  const mentions = index.unlinkedMentions(pageId);
  if (!back.length && !mentions.length) {
    return `<section class="nb-backlinks is-empty"><h2 class="nb-backlinks-h">No linked references</h2>`
      + `<p class="nb-backlinks-note">Other notes that write <code>[[${esc(index.page(pageId)?.title ?? '')}]]</code> show up here.</p></section>`;
  }
  let html = '<section class="nb-backlinks">';
  if (back.length) {
    html += `<h2 class="nb-backlinks-h">${back.length} linked ${back.length === 1 ? 'reference' : 'references'}</h2>`;
    let lastPage = null;
    for (const b of back) {
      if (b.page.id !== lastPage) {
        if (lastPage) html += '</div>';
        html += `<div class="nb-ref-group"><a class="nb-ref-page" href="#" data-page="${esc(b.page.id)}"><span class="nb-link-mark">⊛</span>${esc(b.page.title)}</a>`;
        lastPage = b.page.id;
      }
      const frag = renderFragment(b.block.text, { index, pageId: b.page.id, now });
      html += `<div class="nb-ref" data-page="${esc(b.page.id)}" data-from="${b.from}" data-to="${b.to}" role="link" tabindex="0">${frag}</div>`;
    }
    if (lastPage) html += '</div>';
  }
  if (mentions.length) {
    html += `<details class="nb-unlinked"><summary>${mentions.length} unlinked ${mentions.length === 1 ? 'mention' : 'mentions'}</summary>`;
    for (const m of mentions) {
      let s = '', p = 0;
      for (const r of m.matches) {
        s += esc(m.block.text.slice(p, r.from - m.block.from)) + `<mark class="nb-mention">${esc(m.block.text.slice(r.from - m.block.from, r.to - m.block.from))}</mark>`;
        p = r.to - m.block.from;
      }
      s += esc(m.block.text.slice(p));
      html += `<div class="nb-ref nb-ref-mention" data-page="${esc(m.page.id)}" data-from="${m.block.from}" data-to="${m.block.to}" role="link" tabindex="0">`
        + `<a class="nb-ref-page" href="#" data-page="${esc(m.page.id)}">${esc(m.page.title)}</a>`
        + `<pre class="nb-ref-text">${s}</pre>`
        + `<button type="button" class="nb-ref-link" data-act="link-mention" data-page="${esc(m.page.id)}" data-from="${m.matches[0].from}" data-to="${m.matches[0].to}" title="Turn the mention into a link">Link</button></div>`;
    }
    html += '</details>';
  }
  return html + '</section>';
}

/** The text of a `- [ ]` / `- [x]` toggle: the checkbox at or after `pos` in `text`, flipped. */
export function toggleTaskAt(text, from, to, nth = 0) {
  const slice = text.slice(from, to);
  const re = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/gm;
  let m, i = 0;
  while ((m = re.exec(slice))) {
    if (i++ === nth) {
      const at = from + m.index + m[1].length + 1;
      return { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' };
    }
  }
  return null;
}

/** Where to append `^id` to the block at `pos`: the end of its last line. */
export function blockIdEdit(text, pos, id) {
  const blocks = splitBlocks(text);
  const b = blocks.find(x => pos >= x.from && pos <= x.to);
  if (!b) return null;
  if (b.id) return { from: b.to, to: b.to, insert: '', id: b.id };
  if (b.type === 'code') return null;
  return { from: b.to, to: b.to, insert: ' ^' + id, id };
}

/** The CSS a standalone HTML export carries (the preview's look, light). */
export const NOTES_EXPORT_CSS = `
body { font: 16px/1.6 -apple-system, system-ui, sans-serif; color: #1a1a1a; background: #fff; max-width: 760px; margin: 40px auto; padding: 0 20px; }
h1.nb-title { font-size: 2em; margin: 0 0 .4em; }
.nb-props { border-collapse: collapse; margin: 0 0 1.5em; font-size: .92em; }
.nb-props th { text-align: left; color: #707070; font-weight: 500; padding: 3px 18px 3px 0; vertical-align: top; }
.nb-props td { padding: 3px 0; }
.nb { position: relative; }
.nb-link, .nb-tag { color: #1a8cf5; text-decoration: none; }
.nb-link { border-bottom: 1px solid rgba(26,140,245,.35); }
.nb-link.is-missing { color: #8a8a8a; border-bottom-style: dashed; }
.nb-link-mark { font-family: ui-monospace, monospace; font-size: .85em; margin-right: .25em; opacity: .7; }
.nb-tag { background: rgba(26,140,245,.1); border-radius: 4px; padding: 0 .35em; }
.nb-date { background: rgba(0,0,0,.05); border-radius: 4px; padding: 0 .35em; }
.nb-id { float: right; font-family: ui-monospace, monospace; font-size: .75em; color: #a0a0a0; }
.nb-embed { border-left: 3px solid rgba(26,140,245,.4); background: rgba(0,0,0,.025); padding: 8px 12px; margin: .6em 0; border-radius: 4px; }
.nb-embed-head { font-size: .8em; color: #707070; display: flex; justify-content: space-between; }
.nb-embed-go { border: 0; background: none; cursor: pointer; color: inherit; }
.nb-callout { border-radius: 6px; padding: 10px 14px; margin: .8em 0; background: rgba(26,140,245,.08); border: 1px solid rgba(26,140,245,.2); }
.nb-callout-head { font-weight: 600; display: flex; gap: .5em; align-items: baseline; }
.nb-callout-warning, .nb-callout-caution, .nb-callout-important { background: rgba(229,160,40,.1); border-color: rgba(229,160,40,.35); }
.nb-callout-danger, .nb-callout-error, .nb-callout-bug { background: rgba(230,90,100,.1); border-color: rgba(230,90,100,.35); }
.nb-callout-success, .nb-callout-done, .nb-callout-check, .nb-callout-tip { background: rgba(80,180,110,.1); border-color: rgba(80,180,110,.35); }
.nb-callout-body > :first-child { margin-top: .4em; } .nb-callout-body > :last-child { margin-bottom: 0; }
details.nb-toggle { margin: .6em 0; } details.nb-toggle summary { cursor: pointer; font-weight: 500; }
.nb-check { width: 15px; height: 15px; border: 1.5px solid #8a8a8a; border-radius: 3px; background: #fff; vertical-align: -2px; margin-right: 4px; padding: 0; }
.nb-check.is-checked { background: #1a8cf5; border-color: #1a8cf5; }
.nb-check.is-checked::after { content: '✓'; color: #fff; font-size: 11px; line-height: 12px; display: block; text-align: center; }
.nb-backlinks { margin-top: 3em; padding-top: 1em; border-top: 1px solid #e4e4e4; }
.nb-backlinks-h { font-size: .9em; color: #707070; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.nb-ref-page { display: block; font-weight: 600; margin: .8em 0 .2em; color: inherit; text-decoration: none; }
.nb-ref { padding: 6px 10px; border-left: 2px solid #e4e4e4; margin: 2px 0; font-size: .95em; }
.nb-ref > :first-child { margin-top: 0; } .nb-ref > :last-child { margin-bottom: 0; }
.nb-ref-text { white-space: pre-wrap; font: inherit; margin: 0; }
.nb-ref-link { display: none; }
pre, code { font-family: ui-monospace, Menlo, monospace; font-size: .9em; }
pre { background: rgba(0,0,0,.05); padding: 10px 12px; border-radius: 6px; overflow: auto; }
blockquote { margin: .8em 0; padding: 0 1em; border-left: 3px solid #d0d0d0; color: #505050; }
table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 4px 10px; }
img { max-width: 100%; }
`;

/** A standalone HTML document for the export. */
export function noteDocument({ title, propsHtml = '', bodyHtml, backlinksHtml = '' }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${NOTES_EXPORT_CSS}</style></head>
<body><article class="uf-notes"><h1 class="nb-title">${esc(title)}</h1>${propsHtml}${bodyHtml}${backlinksHtml}</article></body></html>`;
}
