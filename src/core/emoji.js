/**
 * Offline emoji lookup for the `:shortcode:` completion ({document} app).
 *
 * Data: `emoji-data.js` (GENERATED from github/gemoji by build/gen-emoji.mjs —
 * one tab-separated line per emoji).  Parsed lazily on first use so apps that
 * never open the menu pay nothing beyond the bundled string.
 *
 * Pure (no DOM) — unit-tested in test/emoji.test.mjs.
 */
import { EMOJI_TABLE } from './emoji-data.js';

let _list = null;       // [{ emoji, codes: string[], desc, tags: string[] }]
let _byCode = null;     // Map shortcode → emoji

function _load() {
  if (_list) return _list;
  _list = [];
  _byCode = new Map();
  for (const line of EMOJI_TABLE.split('\n')) {
    if (!line) continue;
    const [emoji, codes, desc, tags] = line.split('\t');
    const entry = { emoji, codes: codes.split(' '), desc, tags: tags ? tags.split(' ') : [] };
    _list.push(entry);
    for (const c of entry.codes) if (!_byCode.has(c)) _byCode.set(c, emoji);
  }
  return _list;
}

/** Every emoji entry, in gemoji order (smileys first). */
export function allEmoji() { return _load(); }

/** The glyph for an exact GitHub shortcode (`smile` → 😄), else null. */
export function emojiForShortcode(code) {
  _load();
  return _byCode.get(String(code ?? '').toLowerCase()) ?? null;
}

/**
 * Rank emoji for a typed query (the text after the `:`).
 * Ordering: shortcode starts with the query → a word of a shortcode/tag starts
 * with it → the description contains it.  Ties keep gemoji order (smileys
 * first), which is what people expect from `:sm`.
 *
 * @param {string} query   lowercase-insensitive; `_`/`-`/space are equivalent
 * @param {number} [limit]
 * @returns {{ emoji: string, code: string, desc: string }[]}
 */
export function searchEmoji(query, limit = 50) {
  const q = String(query ?? '').toLowerCase().replace(/[-\s]+/g, '_');
  if (!q) return [];
  const out = [];
  for (const e of _load()) {
    let best = 0;
    let code = e.codes[0];
    for (const c of e.codes) {
      if (c.startsWith(q)) { best = Math.max(best, c === q ? 4 : 3); code = c; break; }
      if (c.includes('_' + q)) { best = Math.max(best, 2); }
    }
    if (best < 2) {
      for (const t of e.tags) {
        const tt = t.replace(/[-\s]+/g, '_');
        if (tt.startsWith(q) || tt.includes('_' + q)) { best = Math.max(best, 2); break; }
      }
    }
    if (best < 1 && e.desc.toLowerCase().includes(q.replace(/_/g, ' '))) best = 1;
    if (best) out.push({ emoji: e.emoji, code, desc: e.desc, rank: best });
  }
  out.sort((a, b) => b.rank - a.rank);   // stable: ties keep table order
  return out.slice(0, limit).map(({ emoji, code, desc }) => ({ emoji, code, desc }));
}
