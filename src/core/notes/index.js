/**
 * {notes} — THE WORKSPACE INDEX (pure, `test/notes.test.mjs`).
 *
 * Every note in the library, parsed once, cross-referenced: which page a
 * `[[link]]` points at, who links here (backlinks), who MENTIONS this page's
 * title without linking it (unlinked mentions), the tags, and the graph.
 *
 * Input: the library's records flattened to `{ id, title, apiName, text,
 * updatedAt }` (the DSL does that from `state.library.list()`, with the open
 * document's live text swapped in).  A quine has one note; everything still
 * works, links to other pages are simply unresolved.
 */

import { parseNote, normKey, slugify, sectionRange, blockAt } from './parse.js';

/**
 * @param {Array<{ id: string, title?: string, apiName?: string, text: string, updatedAt?: number }>} docs
 * @returns {Index}
 */
export function buildIndex(docs) {
  const pages = new Map();
  const byKey = new Map();          // normalised title / alias / name → page id
  const register = (key, id) => { const k = normKey(key); if (k && !byKey.has(k)) byKey.set(k, id); };

  for (const d of docs) {
    // `d.note` = a parse the caller cached for an unchanged document.
    const note = d.note ?? parseNote(d.text ?? '', { title: d.title });
    const page = {
      id: d.id,
      title: note.title || d.title || d.apiName || 'Untitled',
      apiName: d.apiName ?? null,
      updatedAt: d.updatedAt ?? 0,
      text: d.text ?? '',
      note,
    };
    pages.set(d.id, page);
  }
  // Titles first (an alias never shadows a real title), then names, then aliases.
  for (const p of pages.values()) register(p.title, p.id);
  for (const p of pages.values()) if (p.apiName) register(p.apiName, p.id);
  for (const p of pages.values()) for (const a of p.note.aliases) register(a, p.id);

  // Resolve every link once.
  const inbound = new Map();        // page id → [{ from: pageId, link }]
  const tags = new Map();           // tag (lower) → [{ page, from, to, tag }]
  for (const p of pages.values()) {
    for (const link of p.note.links) {
      link.pageId = link.target ? (byKey.get(normKey(link.target)) ?? null) : p.id;   // `[[#Heading]]` = this page
      if (link.pageId) (inbound.get(link.pageId) ?? inbound.set(link.pageId, []).get(link.pageId)).push({ from: p.id, link });
    }
    for (const t of p.note.tags) {
      const k = t.tag.toLowerCase();
      (tags.get(k) ?? tags.set(k, []).get(k)).push({ page: p.id, from: t.from, to: t.to, tag: t.tag, property: !!t.property });
    }
  }

  return new Index({ pages, byKey, inbound, tags });
}

export class Index {
  constructor({ pages, byKey, inbound, tags }) {
    this.pages = pages;
    this.byKey = byKey;
    this.inbound = inbound;
    this.tags = tags;
  }

  /** The page a link target names (title / alias / name), or null. */
  resolve(target) {
    const id = this.byKey.get(normKey(target));
    return id ? this.pages.get(id) : null;
  }

  page(id) { return this.pages.get(id) ?? null; }

  /** Pages newest first. */
  list() {
    return [...this.pages.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  /**
   * Resolve a full reference `{ target, heading, block }` to a text range in
   * the target page: the block, the heading's section, or the whole body.
   * @returns {{ page, from, to, kind: 'block'|'section'|'page', block?, heading? } | null}
   */
  resolveRef(ref, fromPageId = null) {
    const page = ref.target ? this.resolve(ref.target) : (fromPageId ? this.page(fromPageId) : null);
    if (!page) return null;
    const note = page.note;
    if (ref.block) {
      const bi = note.blockIds[ref.block];
      if (bi === undefined) return null;
      const b = note.blocks[bi];
      return { page, from: b.from, to: b.to, kind: 'block', block: b };
    }
    if (ref.heading) {
      const s = sectionRange(note, ref.heading);
      if (!s) return null;
      return { page, from: s.from, to: s.to, kind: 'section', heading: s.heading };
    }
    const first = note.blocks[0], last = note.blocks[note.blocks.length - 1];
    return { page, from: first?.from ?? note.bodyFrom, to: last?.to ?? page.text.length, kind: 'page' };
  }

  /**
   * Who links to `pageId`: one entry per referencing BLOCK, with the block's
   * text (the context Notion shows under "Linked references").
   * @returns {Array<{ page, block, links: Array<link>, from, to }>}
   */
  backlinks(pageId) {
    const out = [];
    const byBlock = new Map();
    for (const { from, link } of this.inbound.get(pageId) ?? []) {
      if (from === pageId) continue;
      const src = this.pages.get(from);
      const bi = blockAt(src.note.blocks, link.from);
      const key = `${from}:${bi}`;
      if (!byBlock.has(key)) {
        const b = bi >= 0 ? src.note.blocks[bi] : { from: link.from, to: link.to, text: link.text, type: 'paragraph' };
        const entry = { page: src, block: b, links: [], from: b.from, to: b.to };
        byBlock.set(key, entry);
        out.push(entry);
      }
      byBlock.get(key).links.push(link);
    }
    return out.sort((a, b) => (b.page.updatedAt - a.page.updatedAt) || (a.from - b.from));
  }

  /**
   * Blocks in OTHER pages whose text contains this page's title (or an alias)
   * as plain words — not inside a link to it.  Obsidian's "unlinked mentions".
   * @returns {Array<{ page, block, matches: Array<{ from, to }> }>}
   */
  unlinkedMentions(pageId) {
    const me = this.pages.get(pageId);
    if (!me) return [];
    const names = [me.title, ...me.note.aliases].map(s => s.trim()).filter(s => s.length >= 2);
    if (!names.length) return [];
    const res = names.map(n => new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(n)})(?![\\p{L}\\p{N}])`, 'giu'));
    const out = [];
    for (const p of this.pages.values()) {
      if (p.id === pageId) continue;
      const linkRanges = p.note.links.map(l => [l.from, l.to]);
      const inLink = (pos) => linkRanges.some(([a, b]) => pos >= a && pos < b);
      for (const b of p.note.blocks) {
        if (b.type === 'code') continue;
        const matches = [];
        for (const re of res) {
          re.lastIndex = 0;
          for (let m; (m = re.exec(b.text));) {
            const s = b.from + m.index + m[1].length;
            if (inLink(s)) continue;
            matches.push({ from: s, to: s + m[2].length });
          }
        }
        // An alias inside the title ("Alpha" in "Project Alpha") matches twice: keep the longest at each spot.
        const kept = [];
        for (const r of matches.sort((x, y) => x.from - y.from || (y.to - y.from) - (x.to - x.from))) {
          if (!kept.length || r.from >= kept[kept.length - 1].to) kept.push(r);
        }
        if (kept.length) out.push({ page: p, block: b, matches: kept });
      }
    }
    return out;
  }

  /** The page's outgoing links, resolved: `[{ link, page|null }]`. */
  outlinks(pageId) {
    const p = this.pages.get(pageId);
    if (!p) return [];
    return p.note.links.map(link => ({ link, page: link.pageId ? this.pages.get(link.pageId) : null }));
  }

  /** Every distinct tag with its page count, most used first. */
  tagList() {
    return [...this.tags.entries()]
      .map(([k, uses]) => ({ tag: uses[0].tag, key: k, pages: new Set(uses.map(u => u.page)).size, uses: uses.length }))
      .sort((a, b) => (b.pages - a.pages) || (b.uses - a.uses) || a.key.localeCompare(b.key));
  }

  /** Page ids carrying a tag (case-insensitive; `area` also matches `area/sub`). */
  pagesWithTag(tag) {
    const want = String(tag).toLowerCase().replace(/^#/, '');
    const ids = new Set();
    for (const [k, uses] of this.tags) {
      if (k === want || k.startsWith(want + '/')) for (const u of uses) ids.add(u.page);
    }
    return [...ids];
  }

  /**
   * The GRAPH: pages as nodes, links as edges.  Options: `tags` adds a node
   * per tag (connected to the pages that carry it), `missing` adds a node per
   * unresolved link target (Obsidian's hollow nodes), `center` + `depth`
   * limit the graph to that page's neighbourhood.
   * @returns {{ nodes: Array<{ id, label, kind: 'page'|'tag'|'missing', degree, pageId? }>, edges: Array<{ source, target, kind }> }}
   */
  graph({ tags = true, missing = true, center = null, depth = Infinity } = {}) {
    const nodes = new Map();
    const edges = [];
    const edgeKeys = new Set();
    const addNode = (id, label, kind, extra = {}) => {
      if (!nodes.has(id)) nodes.set(id, { id, label, kind, degree: 0, ...extra });
      return nodes.get(id);
    };
    const addEdge = (a, b, kind) => {
      if (a === b) return;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({ source: a, target: b, kind });
      nodes.get(a).degree++; nodes.get(b).degree++;
    };
    for (const p of this.pages.values()) addNode(p.id, p.title, 'page', { pageId: p.id, updatedAt: p.updatedAt });
    for (const p of this.pages.values()) {
      for (const link of p.note.links) {
        if (link.pageId) addEdge(p.id, link.pageId, 'link');
        else if (missing && link.target) {
          const id = 'missing:' + normKey(link.target);
          addNode(id, link.target, 'missing');
          addEdge(p.id, id, 'link');
        }
      }
    }
    if (tags) {
      for (const [k, uses] of this.tags) {
        const id = 'tag:' + k;
        addNode(id, '#' + uses[0].tag, 'tag');
        for (const u of uses) addEdge(u.page, id, 'tag');
      }
    }
    let nodeList = [...nodes.values()], edgeList = edges;
    if (center && nodes.has(center) && Number.isFinite(depth)) {
      const keep = new Set([center]);
      let frontier = [center];
      for (let d = 0; d < depth && frontier.length; d++) {
        const next = [];
        for (const e of edges) {
          if (frontier.includes(e.source) && !keep.has(e.target)) { keep.add(e.target); next.push(e.target); }
          else if (frontier.includes(e.target) && !keep.has(e.source)) { keep.add(e.source); next.push(e.source); }
        }
        frontier = next;
      }
      nodeList = nodeList.filter(n => keep.has(n.id));
      edgeList = edges.filter(e => keep.has(e.source) && keep.has(e.target));
      // degrees within the local graph
      for (const n of nodeList) n.degree = 0;
      for (const e of edgeList) { nodes.get(e.source).degree++; nodes.get(e.target).degree++; }
    }
    return { nodes: nodeList, edges: edgeList };
  }
}

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { normKey, slugify };
