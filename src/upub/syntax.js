/**
 * uPub syntax engine — per-line Markdown classification + inline rendering.
 *
 * The editor (editor.js) keeps the document as plain text and renders one DOM
 * block per source line.  This module decides, for each line, WHAT it is
 * (heading, bullet, quote, fenced code, …) and produces the inner HTML for it.
 *
 * THE ONE INVARIANT that everything depends on:
 *
 *     textContent(renderLineHtml(line, info)) === line
 *
 * Rendering only ever WRAPS characters in <span>s — it never adds, removes or
 * reorders text.  The editor extracts the document back out of the DOM via
 * textContent, and the caret is restored by absolute character offset, so any
 * violation corrupts the document or teleports the cursor.
 *
 * Classification is document-stateful (code fences and the leading front-matter
 * block change what the lines inside them mean), so classifyDoc() runs over the
 * whole line array and returns one info object per line.  It's plain string
 * work — re-running it on every edit is cheap even for book-length documents.
 */

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

const RE_HEADING = /^(#{1,6})(\s+)(.*)$/;
const RE_BULLET  = /^(\s*)([-*+])(\s+)(.*)$/;
const RE_ORDERED = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;
const RE_TASK    = /^\[([ xX])\](\s+)([\s\S]*)$/;      // applied to bullet content
const RE_QUOTE   = /^(\s*)((?:>\s?)+)([\s\S]*)$/;
const RE_FENCE   = /^(\s{0,3})(```+|~~~+)(.*)$/;
const RE_HR      = /^\s{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * Classify every line of the document.
 * @param {string[]} lines
 * @returns {Array<object>} one info per line:
 *   { type, hang, marker?, prefixLen?, depth?, fenceChar? }
 *   type ∈ blank | h1..h6 | bullet | ordered | task | quote | fence | code |
 *          hr | fm-fence | fm | text
 *   hang — hanging-indent width in characters (prefix that wrapped text aligns after)
 */
export function classifyDoc(lines) {
  const infos = new Array(lines.length);
  let inFence = false;
  let fenceMark = '';
  // Leading front matter: line 0 is exactly `---` and a closing `---` exists later.
  let fmClose = -1;
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') { fmClose = i; break; }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fmClose > 0 && i <= fmClose) {
      infos[i] = { type: (i === 0 || i === fmClose) ? 'fm-fence' : 'fm', hang: 0 };
      continue;
    }

    if (inFence) {
      const f = RE_FENCE.exec(line);
      if (f && f[2][0] === fenceMark[0] && f[2].length >= fenceMark.length && !f[3].trim()) {
        infos[i] = { type: 'fence', hang: 0 };
        inFence = false;
      } else {
        infos[i] = { type: 'code', hang: 0 };
      }
      continue;
    }

    if (!line.trim()) { infos[i] = { type: 'blank', hang: 0 }; continue; }

    const f = RE_FENCE.exec(line);
    if (f) {
      infos[i] = { type: 'fence', hang: 0 };
      inFence = true;
      fenceMark = f[2];
      continue;
    }

    const h = RE_HEADING.exec(line);
    if (h) {
      infos[i] = { type: 'h' + h[1].length, hang: 0, prefixLen: h[1].length + h[2].length };
      continue;
    }

    if (RE_HR.test(line)) { infos[i] = { type: 'hr', hang: 0 }; continue; }

    const q = RE_QUOTE.exec(line);
    if (q) {
      infos[i] = { type: 'quote', hang: q[1].length + q[2].length, prefixLen: q[1].length + q[2].length };
      continue;
    }

    const b = RE_BULLET.exec(line);
    if (b) {
      const pre = b[1].length + 1 + b[3].length;
      const t = RE_TASK.exec(b[4]);
      if (t) {
        infos[i] = {
          type: 'task', hang: pre + 3 + t[2].length, prefixLen: pre + 3 + t[2].length,
          checked: t[1] !== ' ',
        };
      } else {
        infos[i] = { type: 'bullet', hang: pre, prefixLen: pre };
      }
      continue;
    }

    const o = RE_ORDERED.exec(line);
    if (o) {
      const pre = o[1].length + o[2].length + 1 + o[4].length;
      infos[i] = { type: 'ordered', hang: pre, prefixLen: pre };
      continue;
    }

    infos[i] = { type: 'text', hang: 0 };
  }
  return infos;
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Wrap a syntax-marker run (the dimmed characters). */
function md(s) { return `<span class="md">${esc(s)}</span>`; }

/**
 * Render inline Markdown to HTML spans (markers dimmed, content styled).
 * Recursive for nesting (bold containing code, etc.), depth-limited.
 * Text is preserved verbatim — see the module invariant.
 */
export function renderInline(text, depth = 0) {
  if (!text) return '';
  if (depth > 4) return esc(text);

  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const rest = text.slice(i);
    let m;

    // Code span — earliest-wins scan below relies on ordering here: code binds
    // tightest (its content is NOT further parsed).
    if ((m = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest))) {
      out += `<code>${md(m[1])}${esc(m[2])}${md(m[1])}</code>`;
      i += m[0].length; continue;
    }
    if ((m = /^(\*\*\*|___)(?!\s)([\s\S]+?)(?<!\s)\1/.exec(rest))) {
      out += `<strong><em>${md(m[1])}${renderInline(m[2], depth + 1)}${md(m[1])}</em></strong>`;
      i += m[0].length; continue;
    }
    if ((m = /^(\*\*|__)(?!\s)([\s\S]+?)(?<!\s)\1/.exec(rest))) {
      out += `<strong>${md(m[1])}${renderInline(m[2], depth + 1)}${md(m[1])}</strong>`;
      i += m[0].length; continue;
    }
    if ((m = /^(\*|_)(?![\s*_])([^*_]+?)(?<!\s)\1/.exec(rest))) {
      out += `<em>${md(m[1])}${renderInline(m[2], depth + 1)}${md(m[1])}</em>`;
      i += m[0].length; continue;
    }
    if ((m = /^~~(?!\s)([\s\S]+?)(?<!\s)~~/.exec(rest))) {
      out += `<s>${md('~~')}${renderInline(m[1], depth + 1)}${md('~~')}</s>`;
      i += m[0].length; continue;
    }
    // Image / link — full syntax stays visible, url dimmed.
    if ((m = /^(!?)\[([^\]]*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/.exec(rest))) {
      out += md(m[1] + '[')
        + `<span class="lnk">${renderInline(m[2], depth + 1)}</span>`
        + md('](') + `<span class="url">${esc(m[3])}</span>` + md(')');
      i += m[0].length; continue;
    }

    // No token starts here — copy plain text up to the next candidate marker.
    const next = rest.slice(1).search(/[`*_~[!]/);
    const take = next < 0 ? rest.length : next + 1;
    out += esc(rest.slice(0, take));
    i += take;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

/**
 * Render one line's inner HTML given its classification.
 * Empty output must still be caret-enterable — the editor appends a <br> to
 * empty lines itself (renderLineHtml returns '' for them).
 */
export function renderLineHtml(line, info) {
  switch (info.type) {
    case 'blank':
      return line ? esc(line) : '';
    case 'fm-fence':
      return md(line);
    case 'fm': {
      const m = /^(\s*)([^:\s][^:]*)(:)([\s\S]*)$/.exec(line);
      if (m) return esc(m[1]) + `<span class="fm-key">${esc(m[2])}</span>` + md(m[3]) + esc(m[4]);
      return esc(line);
    }
    case 'fence':
      return md(line);
    case 'code':
      return esc(line) || '';
    case 'hr':
      return md(line);
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const m = RE_HEADING.exec(line);
      return md(m[1]) + esc(m[2]) + renderInline(m[3]);
    }
    case 'quote': {
      const m = RE_QUOTE.exec(line);
      return esc(m[1]) + md(m[2]) + renderInline(m[3]);
    }
    case 'bullet': {
      const m = RE_BULLET.exec(line);
      return esc(m[1]) + `<span class="bullet">${esc(m[2])}</span>` + esc(m[3]) + renderInline(m[4]);
    }
    case 'task': {
      const m = RE_BULLET.exec(line);
      const t = RE_TASK.exec(m[4]);
      const boxCls = t[1] === ' ' ? 'task-box' : 'task-box task-done';
      return esc(m[1]) + `<span class="bullet">${esc(m[2])}</span>` + esc(m[3])
        + `<span class="${boxCls}">${esc('[' + t[1] + ']')}</span>` + esc(t[2])
        + (t[1] === ' ' ? renderInline(t[3]) : `<span class="task-text">${renderInline(t[3])}</span>`);
    }
    case 'ordered': {
      const m = RE_ORDERED.exec(line);
      return esc(m[1]) + `<span class="bullet">${esc(m[2] + m[3])}</span>` + esc(m[4]) + renderInline(m[5]);
    }
    default:
      return renderInline(line);
  }
}

/**
 * The CSS class list for a line's block element.
 */
export function lineClass(info) {
  return 'wr-line t-' + info.type;
}
