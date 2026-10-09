/**
 * {spreadsheet} — the small lexers the DSL shares (pure).
 *
 *   splitTop(s, seps)   split on separators at the TOP level only — never
 *                       inside "quotes", (parens), [brackets] or {braces};
 *                       the backbone of value lists, `{ … }` blocks and
 *                       condition values (a formula keeps its commas)
 *   unquote(s)          "…" → … with \" and "" escapes
 *   quoteIf(s, chars)   quote a value when it needs it
 *   tokenizeArgs(s)     whitespace tokens with quoted strings kept whole
 *                       (conditions: `contains "x y"`)
 */

/**
 * Split `s` on any of `seps` outside quotes / parens / brackets / braces.
 * @returns {Array<{ text, from, to }>}  segments with offsets into `s`
 *   (the text is NOT trimmed; callers trim and keep the offsets honest)
 */
export function splitTop(s, seps = ',', { formats = false } = {}) {
  const out = [];
  let depth = 0, inStr = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // `formats`: a comma glued to `#` or a digit is a number format's
    // thousands separator (`$#,##0.00`), not a list separator.
    if (formats && ch === ',' && depth === 0 && !inStr && /[#0-9]/.test(s[i + 1] ?? '')) continue;
    if (inStr) {
      if (ch === '\\' && i + 1 < s.length) { i++; continue; }
      if (ch === '"') { if (s[i + 1] === '"') { i++; continue; } inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { if (depth > 0) depth--; continue; }
    if (depth === 0 && seps.includes(ch)) { out.push({ text: s.slice(start, i), from: start, to: i }); start = i + 1; }
  }
  out.push({ text: s.slice(start), from: start, to: s.length });
  return out;
}

/** The content of a quoted string (`"a \"b\""`, `"a ""b"""`); an unquoted string is returned as is. */
export function unquote(s) {
  const t = String(s ?? '');
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/""/g, '"');
  }
  return t;
}

/** Quote `s` when it contains any of `chars`, a quote, or leading / trailing space. */
export function quoteIf(s, chars = ',{}') {
  const t = String(s ?? '');
  if (t === '') return '""';
  const needs = [...chars].some(c => t.includes(c)) || t.includes('"') || t !== t.trim() || t.includes('\\');
  return needs ? '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : t;
}

/** Trim a segment, keeping its offsets right. */
export function trimSeg(seg) {
  const lead = seg.text.length - seg.text.trimStart().length;
  const trail = seg.text.length - seg.text.trimEnd().length;
  return { text: seg.text.trim(), from: seg.from + lead, to: Math.max(seg.from + lead, seg.to - trail) };
}

/**
 * Whitespace-separated tokens; a `"…"` span (with `\"` escapes) is one token
 * even with spaces, and may sit inside a token (`format:"$#,##0 kg"`).
 * @returns {Array<{ text, from, to, quoted }>}
 */
export function tokenizeArgs(s, base = 0) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const from = i;
    let text = '';
    let quoted = false;
    while (i < s.length && !/\s/.test(s[i])) {
      if (s[i] === '"') {
        quoted = true;
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length) { text += s[i + 1]; i += 2; continue; }
          text += s[i++];
        }
        i++;
        continue;
      }
      text += s[i++];
    }
    out.push({ text, from: base + from, to: base + i, quoted });
  }
  return out;
}

/** Quote a string for a condition argument when it needs it. */
export function quoteArg(s) {
  const t = String(s ?? '');
  if (t !== '' && !/[\s"\\]/.test(t) && !/^(then|and)$/i.test(t)) return t;
  return '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
