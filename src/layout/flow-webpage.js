/**
 * Flow → Webpage layout renderer.
 *
 * Renders the full document body as a single flowing page.
 * `---` on its own line is a horizontal-rule separator — it becomes an <hr>
 * element in the rendered output (unlike slides/document where it is a
 * page/slide break).  Code-fenced `---` lines are preserved as-is.
 *
 * All embedded `#!dslId` shebang sections are supported within each segment.
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

export async function renderWebpage(content, container) {
  const { bodyFrom } = parseGlobalFrontMatter(content);

  container.innerHTML = '';
  container.classList.add('webpage-mode');

  const page = document.createElement('div');
  page.className = 'uf-webpage';
  container.appendChild(page);

  // Pre-split on bare `---` lines (fence-aware) so that `---` between any two
  // DSL sections is treated as an <hr> rather than being swallowed into the
  // preceding section's content by parseDocSections.
  const segments = _splitOnHr(content, bodyFrom);
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) page.appendChild(document.createElement('hr'));
    await _renderContent(segments[i].text, page, segments[i].from);
  }
}

export function teardownWebpage(container) {
  container.classList.remove('webpage-mode');
}

// ---------------------------------------------------------------------------
// Content rendering
// ---------------------------------------------------------------------------

async function _renderContent(body, el, bodyFrom) {
  if (!body.trim()) return;

  const sections = parseDocSections(body);

  if (!sections.length) {
    // Pure body — no shebang sections; render as markdown.
    await _renderPart('markdown', body, el, bodyFrom, bodyFrom + body.length, bodyFrom);
    return;
  }

  // Preamble before the first shebang → markdown
  const preambleRaw = body.slice(0, sections[0].from);
  const preamble    = preambleRaw.trim();
  if (preamble) {
    const lead = preambleRaw.search(/\S/);
    const pFrom = bodyFrom + (lead >= 0 ? lead : 0);
    await _renderPart('markdown', preamble, el,
      pFrom,
      bodyFrom + sections[0].from,
      pFrom);
  }

  // Each shebang section
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
  }
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
    // Belt-and-suspenders: if any markdown page-break divs survive (e.g. `---`
    // inside a code fence that marked still treats as hr), replace them with <hr>.
    if (dslId === 'markdown') {
      wrap.querySelectorAll('.page-break').forEach(pb => {
        pb.replaceWith(document.createElement('hr'));
      });
    }
  } catch (err) {
    wrap.innerHTML = `<pre class="error">${_esc(dslId)} error: ${_esc(err.message)}</pre>`;
  }
}

// ---------------------------------------------------------------------------
// HR splitting (fence-aware)
// ---------------------------------------------------------------------------

/**
 * Split document body at bare `---` lines (not inside code fences).
 * Returns an array of { text, from } where `from` is the absolute char offset
 * of the first non-whitespace character of each segment.
 */
function _splitOnHr(content, bodyFrom) {
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

    if (!inFence && /^---\s*$/.test(line)) {
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
