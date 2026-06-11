/**
 * Flow → Webpage layout renderer.
 *
 * Renders the document as one or more flowing sections.  `===` on its own
 * line (3+ equals, not inside a code fence) splits the content into distinct
 * sections — think of each section as a separate "page" in a multi-page site.
 * `---` inside any section is passed through to the DSL renderer (markdown
 * renders it as a standard `<hr>`).
 *
 * All embedded `#!dslId` shebang sections are supported within each section.
 *
 * There are no fixed page dimensions — content reflows naturally with the
 * container width, just like a normal webpage.
 *
 * Front matter keys consumed:  (none — all pass through to DSL renderers)
 */

import { parseGlobalFrontMatter } from '../core/front-matter.js';
import { parseDocSections }        from '../core/doc-sections.js';
import { getDSL }                   from '../dsl/registry.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function renderWebpage(content, container, opts = {}) {
  const { meta, bodyFrom } = parseGlobalFrontMatter(content);

  container.innerHTML = '';
  container.classList.add('webpage-mode');

  const page = document.createElement('div');
  page.className = 'uf-webpage';
  container.appendChild(page);

  // Pre-split on bare `===` lines (fence-aware).  Each segment becomes a
  // visually distinct section — like a separate page within a single site.
  const segments = _splitOnPageBreak(content, bodyFrom);

  // `dsl:` front matter sets the default DSL for sections without a #!shebang.
  // Falls back to the document's default DSL (e.g. a dedicated abcjs build seeds
  // dslType:'abcjs') before markdown.  Carries forward across === breaks.
  let currentDslId = meta.dsl ?? opts.defaultDsl ?? 'markdown';

  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      const sep = document.createElement('div');
      sep.className = 'uf-webpage-section-break';
      page.appendChild(sep);
    }
    const section = document.createElement('div');
    section.className = 'uf-webpage-section';
    section.dataset.docFrom = segments[i].from;
    page.appendChild(section);
    currentDslId = await _renderContent(segments[i].text, section, segments[i].from, currentDslId);
  }
}

export function teardownWebpage(container) {
  container.classList.remove('webpage-mode');
}

// ---------------------------------------------------------------------------
// Content rendering
// ---------------------------------------------------------------------------

/**
 * Render one section's content into `el`, returning the last DSL used.
 * `defaultDslId` carries the active DSL across === section breaks.
 */
async function _renderContent(body, el, bodyFrom, defaultDslId = 'markdown') {
  if (!body.trim()) return defaultDslId;

  const sections = parseDocSections(body);
  let outDslId = defaultDslId;

  if (!sections.length) {
    // No shebangs — render with the inherited DSL.
    await _renderPart(defaultDslId, body, el, bodyFrom, bodyFrom + body.length, bodyFrom);
    return outDslId;
  }

  // Preamble before the first shebang → inherited DSL (not forced to markdown)
  const preambleRaw = body.slice(0, sections[0].from);
  const preamble    = preambleRaw.trim();
  if (preamble) {
    const lead = preambleRaw.search(/\S/);
    const pFrom = bodyFrom + (lead >= 0 ? lead : 0);
    await _renderPart(defaultDslId, preamble, el,
      pFrom,
      bodyFrom + sections[0].from,
      pFrom);
  }

  // Each shebang section — update outDslId so it carries to the next section.
  for (const sec of sections) {
    const raw  = body.slice(sec.contentFrom, sec.to);
    const text = raw.trim();
    if (text) {
      const lead = raw.search(/\S/);
      await _renderPart(sec.dslId, text, el,
        bodyFrom + sec.from,
        bodyFrom + sec.to,
        bodyFrom + sec.contentFrom + (lead >= 0 ? lead : 0));
    }
    outDslId = sec.dslId;
  }

  return outDslId;
}

async function _renderPart(dslId, text, parentEl, docFrom, docTo, contentFrom) {
  const wrap = document.createElement('div');
  wrap.className = `uf-web-part uf-dsl-${_safeClass(dslId)}`;
  if (docFrom     != null) wrap.dataset.docFrom        = docFrom;
  if (docTo       != null) wrap.dataset.docTo          = docTo;
  if (contentFrom != null) wrap.dataset.dslContentFrom = contentFrom;
  parentEl.appendChild(wrap);
  try {
    const dsl = getDSL(dslId);
    await dsl.render(text, wrap);
    // In webpage layout, any markdown page-break divs (from `===` within DSL
    // content that wasn't intercepted by the splitter, e.g. inside a shebang
    // section) are rendered as-is — they'll show the visual page-break marker
    // which is fine in a flowing context.
  } catch (err) {
    wrap.innerHTML = `<pre class="error">${_esc(dslId)} error: ${_esc(err.message)}</pre>`;
  }
}

// ---------------------------------------------------------------------------
// Page-break splitting (fence-aware)
// ---------------------------------------------------------------------------

/**
 * Split document body at bare `===` lines (3+ equals, not inside code fences).
 * Returns an array of { text, from } where `from` is the absolute char offset
 * of the first non-whitespace character of each segment.
 */
function _splitOnPageBreak(content, bodyFrom) {
  const body  = content.slice(bodyFrom);
  const lines = body.split('\n');
  const segs  = [];
  let current     = [];
  let currentFrom = bodyFrom;
  let offset      = bodyFrom;
  let inFence     = false;
  let fenceChar   = '';

  for (const line of lines) {
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line.trimStart());
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (!inFence) { inFence = true; fenceChar = ch; }
      else if (ch === fenceChar && /^[`~]+\s*$/.test(line.trimStart())) inFence = false;
    }

    if (!inFence && /^={3,}\s*$/.test(line)) {
      const raw = current.join('\n');
      const s   = raw.trim();
      if (s) {
        const lead = raw.search(/\S/);
        segs.push({ text: s, from: currentFrom + (lead >= 0 ? lead : 0) });
      }
      offset += line.length + 1;
      current = [];
      currentFrom = offset;
    } else {
      current.push(line);
      offset += line.length + 1;
    }
  }

  const lastRaw = current.join('\n');
  const last    = lastRaw.trim();
  if (last) {
    const lead = lastRaw.search(/\S/);
    segs.push({ text: last, from: currentFrom + (lead >= 0 ? lead : 0) });
  }

  return segs.length ? segs : [{ text: body.trim(), from: bodyFrom }];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _safeClass(s) { return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_'); }
function _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
