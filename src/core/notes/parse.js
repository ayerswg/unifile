/**
 * {notes} — the parser for ONE note (pure, no DOM, `test/notes.test.mjs`).
 *
 * A note is Markdown.  On top of it, five plain-text conventions make notes
 * connect (the Notion / Obsidian vocabulary):
 *
 *   [[Page]]  [[Page|alias]]  [[Page#Heading]]  [[Page#^blockid]]
 *                      a LINK to another note (by title, alias or name), a
 *                      heading in it or one of its blocks
 *   ![[Page#^id]]      an EMBED: the referenced block / section / page is
 *                      rendered in place (a line that is only the embed)
 *   ^id                a BLOCK ID — the last thing on a block's last line
 *   #tag  #area/sub    a TAG (inline, not a heading: no space after the #)
 *   @2026-10-24 @today a DATE mention
 *
 * Everything here works on offsets into the note's text, so the editor, the
 * render pane's click-back and the search hits all speak the same coordinates.
 * Front matter (`core/front-matter.js`) carries the PROPERTIES: `title`,
 * `aliases`, `tags`, and anything else the writer wants shown in the page
 * header.
 */

import { parseGlobalFrontMatter } from '../front-matter.js';

export const LINK_RE = /(!?)\[\[([^\[\]|#]*)(?:#(\^?[^\[\]|]*))?(?:\|([^\[\]]*))?\]\]/g;
// A tag: `#` after start/space/`(`, then a letter, then word chars, `-`, `/`.
// Not `#1` (a number), not a heading (`# Title` has a space).
export const TAG_RE = /(^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]*)/gu;
export const DATE_RE = /(^|[\s(])@(today|tomorrow|yesterday|\d{4}-\d{2}-\d{2})\b/g;
export const BLOCK_ID_RE = /(?:^|\s)\^([A-Za-z0-9][A-Za-z0-9_-]*)\s*$/;

/** Normalise a title / alias / name for matching: case, whitespace, dashes. */
export function normKey(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/** GitHub-style heading slug. */
export function slugify(s) {
  return String(s ?? '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}

/** Heading text without trailing `^id` / inline marks. */
export function headingText(line) {
  return line.replace(/^#{1,6}\s+/, '').replace(BLOCK_ID_RE, '').replace(/\s+#+\s*$/, '').trim();
}

/** A property value that may be a list: `a, b`, `[a, b]`, a single value. */
export function listValue(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  const s = String(v).trim().replace(/^\[|\]$/g, '');
  return s.split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/**
 * Mask code so links/tags inside it are ignored: fenced blocks (``` / ~~~)
 * and inline `code` spans become spaces of the same length.
 */
export function maskCode(text) {
  const lines = text.split('\n');
  let fence = null;
  const out = [];
  for (const line of lines) {
    const fm = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      out.push(' '.repeat(line.length));
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
      continue;
    }
    if (fm) { fence = fm[1]; out.push(' '.repeat(line.length)); continue; }
    // inline code spans
    out.push(line.replace(/(`+)[^`]*?\1/g, m => ' '.repeat(m.length)));
  }
  return out.join('\n');
}

/**
 * Split the body into BLOCKS: a heading, a paragraph, a fenced code block, a
 * blockquote, a table, or ONE top-level list item each (Notion's block = a
 * bullet).  A block's id is a trailing `^id` on its last line.
 *
 * @returns {Array<{ from, to, text, type: 'heading'|'paragraph'|'code'|'quote'|'list'|'table'|'rule'|'embed', level?, id? }>}
 */
export function splitBlocks(text, base = 0) {
  const blocks = [];
  const lines = text.split('\n');
  let pos = 0;
  let cur = null;   // { from, type, lines: [] , end }
  let fence = null;

  const flush = (endPos) => {
    if (!cur) return;
    const raw = cur.lines.join('\n');
    const trimmedEnd = raw.replace(/\s+$/, '');
    const b = { from: base + cur.from, to: base + cur.from + trimmedEnd.length, text: trimmedEnd, type: cur.type };
    if (cur.level) b.level = cur.level;
    const idm = BLOCK_ID_RE.exec(trimmedEnd.split('\n').pop());
    if (idm && cur.type !== 'code') b.id = idm[1];
    if (b.text.trim()) blocks.push(b);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineFrom = pos;
    pos += line.length + 1;
    const fm = /^\s*(```+|~~~+)/.exec(line);

    if (fence) {
      cur.lines.push(line);
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) { fence = null; flush(); }
      continue;
    }
    if (fm) { flush(); fence = fm[1]; cur = { from: lineFrom, type: 'code', lines: [line] }; continue; }

    if (!line.trim()) { flush(); continue; }

    const h = /^(#{1,6})\s+\S/.exec(line);
    if (h) { flush(); cur = { from: lineFrom, type: 'heading', level: h[1].length, lines: [line] }; flush(); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) && !(cur && cur.type === 'paragraph')) {
      flush(); cur = { from: lineFrom, type: 'rule', lines: [line] }; flush(); continue;
    }
    if (/^\s*!\[\[[^\]]+\]\]\s*(\^[\w-]+\s*)?$/.test(line)) {
      flush(); cur = { from: lineFrom, type: 'embed', lines: [line] }; flush(); continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    if (li && li[1].length === 0) {
      // a new TOP-LEVEL list item starts a new block; indented lines continue it
      flush(); cur = { from: lineFrom, type: 'list', lines: [line] }; continue;
    }
    if (cur && cur.type === 'list' && (/^\s+\S/.test(line) || li)) { cur.lines.push(line); continue; }
    if (/^\s*>/.test(line)) {
      if (cur && cur.type === 'quote') { cur.lines.push(line); continue; }
      flush(); cur = { from: lineFrom, type: 'quote', lines: [line] }; continue;
    }
    if (/^\s*\|/.test(line)) {
      if (cur && cur.type === 'table') { cur.lines.push(line); continue; }
      flush(); cur = { from: lineFrom, type: 'table', lines: [line] }; continue;
    }
    if (cur && (cur.type === 'paragraph' || cur.type === 'quote' || cur.type === 'list')) { cur.lines.push(line); continue; }
    flush();
    cur = { from: lineFrom, type: 'paragraph', lines: [line] };
  }
  flush();
  return blocks;
}

/**
 * Parse one note.
 *
 * @param {string} text          the whole document (front matter included)
 * @param {object} [opts]
 * @param {string} [opts.title]  the document's title (state.data.title) when the
 *                               front matter has none
 * @returns {{
 *   meta, bodyFrom, title, aliases: string[], properties: Array<[k, v]>,
 *   blocks, headings: Array<{ text, slug, level, from, to, blockIndex }>,
 *   links: Array<{ target, heading, block, alias, embed, from, to, text }>,
 *   tags: Array<{ tag, from, to }>, dates: Array<{ value, from, to }>,
 *   blockIds: Record<string, number>  (id → block index)
 * }}
 */
export function parseNote(text, { title } = {}) {
  const src = String(text ?? '');
  const { meta, bodyFrom } = parseGlobalFrontMatter(src);
  const body = src.slice(bodyFrom);
  const masked = maskCode(body);

  const blocks = splitBlocks(body, bodyFrom);
  const blockIds = {};
  blocks.forEach((b, i) => { if (b.id && blockIds[b.id] === undefined) blockIds[b.id] = i; });

  const headings = [];
  blocks.forEach((b, i) => {
    if (b.type !== 'heading') return;
    const t = headingText(b.text);
    headings.push({ text: t, slug: slugify(t), level: b.level, from: b.from, to: b.to, blockIndex: i });
  });

  const links = [];
  LINK_RE.lastIndex = 0;
  for (let m; (m = LINK_RE.exec(masked));) {
    const target = m[2].trim();
    let heading = null, block = null;
    if (m[3] != null) {
      const frag = m[3].trim();
      if (frag.startsWith('^')) block = frag.slice(1); else if (frag) heading = frag;
    }
    if (!target && !heading && !block) continue;
    links.push({
      target, heading, block, alias: m[4] != null ? m[4].trim() : null, embed: m[1] === '!',
      from: bodyFrom + m.index, to: bodyFrom + m.index + m[0].length, text: m[0],
    });
  }

  const tags = [];
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'tags') for (const t of listValue(v)) tags.push({ tag: t.replace(/^#/, ''), from: 0, to: 0, property: true });
  }
  TAG_RE.lastIndex = 0;
  for (let m; (m = TAG_RE.exec(masked));) {
    const start = m.index + m[1].length;
    // a heading line's `#`s are never tags (there is a space after them)
    tags.push({ tag: m[2].replace(/\/+$/, ''), from: bodyFrom + start, to: bodyFrom + start + 1 + m[2].length });
  }

  const dates = [];
  DATE_RE.lastIndex = 0;
  for (let m; (m = DATE_RE.exec(masked));) {
    const start = m.index + m[1].length;
    dates.push({ value: m[2], from: bodyFrom + start, to: bodyFrom + start + 1 + m[2].length });
  }

  const properties = Object.entries(meta).filter(([k]) => k !== 'title' && k !== 'aliases');
  const noteTitle = String(meta.title || title || '').trim();
  return {
    meta, bodyFrom, title: noteTitle, aliases: listValue(meta.aliases), properties,
    blocks, headings, links, tags, dates, blockIds,
  };
}

/** The block (index) containing offset `pos`, or -1. */
export function blockAt(blocks, pos) {
  for (let i = 0; i < blocks.length; i++) if (pos >= blocks[i].from && pos <= blocks[i].to) return i;
  return -1;
}

/**
 * The text range of a heading's SECTION: from the heading block to just
 * before the next heading of the same or a higher level.
 */
export function sectionRange(note, slugOrText) {
  const want = slugify(slugOrText);
  const h = note.headings.find(x => x.slug === want || normKey(x.text) === normKey(slugOrText));
  if (!h) return null;
  let to = note.blocks[note.blocks.length - 1]?.to ?? h.to;
  for (const other of note.headings) {
    if (other.from > h.from && other.level <= h.level) { to = note.blocks[other.blockIndex - 1]?.to ?? other.from; break; }
  }
  return { from: h.from, to, heading: h };
}

/** A short random block id (6 chars, base36). */
export function newBlockId(rand = Math.random) {
  let s = '';
  while (s.length < 6) s += Math.floor(rand() * 36).toString(36);
  return s;
}

/** Resolve `@today` and friends to an ISO date for a given `now`. */
export function resolveDateMention(value, now = new Date()) {
  const d = new Date(now.getTime());
  if (value === 'today') return isoDate(d);
  if (value === 'tomorrow') { d.setDate(d.getDate() + 1); return isoDate(d); }
  if (value === 'yesterday') { d.setDate(d.getDate() - 1); return isoDate(d); }
  return value;
}

export function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
