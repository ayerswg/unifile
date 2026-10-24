/**
 * {notes} — QUICK FIND (pure, `test/notes.test.mjs`).
 *
 * Notion's search, in the app's terms: one query over every page of the
 * workspace, results grouped by page — the title with its matched letters
 * marked, then the contextual hits (the line around each match, every term
 * highlighted, the heading it sits under) — ranked by where the match is:
 * a title beats a heading beats the body; recency breaks ties.
 *
 *   words        all must match (AND), anywhere in the page, case-insensitive
 *   "a phrase"   matched literally
 *   #tag         the page carries the tag (inline or in `tags:`)
 *   title:word   the word must match the title
 *
 * `highlightRanges(text, terms)` gives the editor / page their marks after a
 * hit is opened — the "contextually highlighted" part.
 */

import { escapeRe } from './index.js';

/** Break a query into words, quoted phrases, tags and title: filters. */
export function parseQuery(q) {
  const terms = [], phrases = [], tags = [], title = [];
  const re = /"([^"]*)"|#([\p{L}\p{N}_/-]+)|title:(\S+)|(\S+)/gu;
  for (let m; (m = re.exec(String(q ?? '')));) {
    if (m[1] != null) { if (m[1].trim()) phrases.push(m[1].trim().toLowerCase()); }
    else if (m[2]) tags.push(m[2].toLowerCase());
    else if (m[3]) title.push(m[3].toLowerCase());
    else if (m[4]) terms.push(m[4].toLowerCase());
  }
  return { terms, phrases, tags, title, all: [...terms, ...phrases, ...title] };
}

/** Case-insensitive subsequence match (`nts` in `notes`): the matched indexes, or null. */
export function fuzzyMatch(needle, hay) {
  const n = needle.toLowerCase(), h = hay.toLowerCase();
  if (!n) return null;
  const idx = [];
  let j = 0;
  for (let i = 0; i < h.length && j < n.length; i++) if (h[i] === n[j]) { idx.push(i); j++; }
  return j === n.length ? idx : null;
}

/** All `[from, to)` ranges of every term in `text` (case-insensitive), merged + sorted. */
export function highlightRanges(text, terms) {
  const t = String(text ?? '');
  const lower = t.toLowerCase();
  const out = [];
  for (const term of terms) {
    const q = String(term).toLowerCase();
    if (!q) continue;
    let i = lower.indexOf(q);
    while (i >= 0) { out.push([i, i + q.length]); i = lower.indexOf(q, i + 1); }
  }
  return mergeRanges(out);
}

export function mergeRanges(ranges) {
  const s = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** The line around offset `at`, trimmed to `ctx` chars a side; marks in snippet coordinates. */
export function snippetAround(text, at, len, terms, ctx = 48) {
  const ls = text.lastIndexOf('\n', at - 1) + 1;
  let le = text.indexOf('\n', at); if (le < 0) le = text.length;
  let s = Math.max(ls, at - ctx), e = Math.min(le, at + len + ctx);
  // widen to word boundaries
  while (s > ls && /\S/.test(text[s - 1]) && at - s < ctx + 12) s--;
  while (e < le && /\S/.test(text[e]) && e - (at + len) < ctx + 12) e++;
  const pre = s > ls ? '…' : '', post = e < le ? '…' : '';
  const body = text.slice(s, e);
  const marks = highlightRanges(body, terms).map(([a, b]) => [a + pre.length, b + pre.length]);
  return { snippet: pre + body + post, marks, lineFrom: ls };
}

/**
 * Search the index.
 *
 * @param {import('./index.js').Index} index
 * @param {string} query
 * @param {{ limit?: number, maxHits?: number, now?: number }} [opts]
 * @returns {Array<{ page, score, titleMarks: Array<[number, number]>, hits: Array<{ from, to, snippet, marks, heading, kind }>, reason }>}
 */
export function searchIndex(index, query, { limit = 30, maxHits = 4, now = Date.now() } = {}) {
  const q = parseQuery(query);
  const pages = index.list();
  if (!q.all.length && !q.tags.length) {
    // Empty: recent pages
    return pages.slice(0, limit).map(page => ({ page, score: 0, titleMarks: [], hits: [], reason: 'recent' }));
  }
  const results = [];
  for (const page of pages) {
    if (q.tags.length) {
      const have = new Set(page.note.tags.map(t => t.tag.toLowerCase()));
      const ok = q.tags.every(t => [...have].some(h => h === t || h.startsWith(t + '/')));
      if (!ok) continue;
    }
    const title = page.title;
    const titleLower = title.toLowerCase();
    const text = page.text;
    const lower = text.toLowerCase();
    let score = 0;
    let titleMarks = [];
    let fail = false;
    const fuzzyOnly = q.all.length === 1 && !q.phrases.length && !q.title.length;

    for (const term of q.title) {
      if (!titleLower.includes(term)) { fail = true; break; }
    }
    if (fail) continue;

    for (const term of q.all) {
      const inTitle = titleLower.includes(term);
      const inText = lower.includes(term);
      if (!inTitle && !inText) {
        const fz = fuzzyOnly ? fuzzyMatch(term, title) : null;
        if (!fz) { fail = true; break; }
        score += 12;
        titleMarks.push(...fz.map(i => [i, i + 1]));
        continue;
      }
      if (inTitle) {
        score += titleLower === term ? 100 : titleLower.startsWith(term) ? 60 : 40;
      }
      if (inText) score += 4;
    }
    if (fail) continue;
    for (const t of q.tags) score += 30;
    titleMarks = mergeRanges([...titleMarks, ...highlightRanges(title, q.all)]);

    // Hits: one per line, best lines first (headings before body), AND-terms
    // scored by how many terms the line holds.
    const hits = [];
    const seenLines = new Set();
    const headingFor = (pos) => {
      let h = null;
      for (const x of page.note.headings) { if (x.from <= pos) h = x; else break; }
      return h ? h.text : null;
    };
    const inHeading = (pos) => page.note.headings.some(h => pos >= h.from && pos <= h.to);
    for (const term of q.all) {
      let i = lower.indexOf(term);
      while (i >= 0) {
        const ls = lower.lastIndexOf('\n', i - 1) + 1;
        if (!seenLines.has(ls)) {
          seenLines.add(ls);
          let le = lower.indexOf('\n', i); if (le < 0) le = lower.length;
          const line = lower.slice(ls, le);
          const termsHere = q.all.filter(t => line.includes(t)).length;
          const isHeading = inHeading(i);
          const { snippet, marks } = snippetAround(text, i, term.length, q.all);
          hits.push({ from: i, to: i + term.length, snippet, marks, heading: isHeading ? null : headingFor(i),
                      kind: isHeading ? 'heading' : i < page.note.bodyFrom ? 'property' : 'body',
                      weight: termsHere * 10 + (isHeading ? 15 : 0) });
          score += isHeading ? 15 : 3;
        }
        i = lower.indexOf(term, i + 1);
      }
    }
    hits.sort((a, b) => (b.weight - a.weight) || (a.from - b.from));
    // Recency: up to 10 points for pages edited in the last week.
    const ageDays = Math.max(0, (now - (page.updatedAt || 0)) / 86400000);
    score += Math.max(0, 10 - ageDays * 1.5);
    results.push({ page, score, titleMarks, hits: hits.slice(0, maxHits), totalHits: hits.length,
                   reason: titleMarks.length ? 'title' : hits.length ? 'text' : 'tag' });
  }
  return results.sort((a, b) => (b.score - a.score) || (b.totalHits - a.totalHits) || (b.page.updatedAt - a.page.updatedAt)).slice(0, limit);
}

/** Wrap the marked ranges of `text` with `open`/`close`, escaping with `esc`. */
export function markText(text, marks, esc, open = '<mark>', close = '</mark>') {
  let out = '', pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    out += esc(text.slice(pos, a)) + open + esc(text.slice(a, b)) + close;
    pos = b;
  }
  return out + esc(text.slice(pos));
}

export { escapeRe };
