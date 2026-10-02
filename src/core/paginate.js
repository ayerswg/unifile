/**
 * Page-break finder shared by the paginated preview (layout/flow-document.js)
 * and the {document} app's PDF export (dsl/markdown-print.js).
 *
 * Given a "tape" (the content rendered at the usable page width, unconstrained
 * height) and the usable page height, returns the tape-relative y offsets
 * where each page STARTS.  Breaks land on block boundaries when the block that
 * straddles a page edge is shorter than a page (it moves whole to the next
 * page); a block taller than a page is cut at the page edge.  Fountain
 * dialogue keeps its character cue (never orphaned at a page bottom).
 *
 * DOM-measuring, so not Node-tested; the callers' integration is verified in
 * the preview tools.
 */

const BLOCK_SEL = [
  '.fountain-scene-heading', '.fountain-action',
  '.fountain-character',     '.fountain-dialogue',
  '.fountain-parenthetical', '.fountain-transition',
  '.fountain-centered',      '.fountain-lyrics',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'pre', 'blockquote', 'table', 'figure',
  '.fm-header', '.page-break',
].join(',');
// Nested blocks are deliberately included (a <p> inside a <li>, an <li> in a
// long <ul>): a list taller than a page is cut at the page edge first, then
// its items refine the cut to an item boundary.

/**
 * @param {HTMLElement} tape
 * @param {number} usableH
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<number[]>}
 */
export async function findPageBreaks(tape, usableH, { signal } = {}) {
  const blocks = Array.from(tape.querySelectorAll(BLOCK_SEL));
  if (!blocks.length) {
    const n = Math.max(1, Math.ceil(tape.scrollHeight / usableH));
    return Array.from({ length: n }, (_, i) => i * usableH);
  }

  const tapeTop = tape.getBoundingClientRect().top;
  const starts  = [0];
  let pageEnd   = usableH;

  for (let idx = 0; idx < blocks.length; idx++) {
    if (idx % 500 === 499) {
      await new Promise(r => setTimeout(r, 0));
      if (signal?.aborted) return starts;
    }

    const block = blocks[idx];
    const r    = block.getBoundingClientRect();
    const bTop = r.top    - tapeTop;
    const bBot = r.bottom - tapeTop;

    while (bTop >= pageEnd) {
      starts.push(pageEnd);
      pageEnd += usableH;
    }

    // An explicit page break (`===` → `.page-break`): whatever follows starts
    // a new page, unless the break sits at the top of a page already.
    if (block.classList.contains('page-break')) {
      if (bTop > (starts[starts.length - 1] ?? 0)) {
        starts.push(bTop);
        pageEnd = bTop + usableH;
      }
      continue;
    }

    if (bBot <= pageEnd) continue;

    if (block.offsetHeight < usableH) {
      let breakAt = bTop;
      const cls = block.className;
      if (cls.includes('fountain-dialogue') || cls.includes('fountain-parenthetical')) {
        for (let back = 1; back <= 2 && idx - back >= 0; back++) {
          const prev = blocks[idx - back];
          const prevCls = prev.className;
          if (prevCls.includes('fountain-character')) {
            const prevTop = prev.getBoundingClientRect().top - tapeTop;
            const pageStart = starts[starts.length - 1] ?? 0;
            if (prevTop > pageStart) breakAt = prevTop;
            break;
          }
          if (!prevCls.includes('fountain-parenthetical')) break;
        }
      }
      starts.push(breakAt);
      pageEnd = breakAt + usableH;
    }
  }

  const totalH = tape.scrollHeight;
  while ((starts[starts.length - 1] ?? 0) + usableH < totalH - 1) {
    starts.push((starts[starts.length - 1] ?? 0) + usableH);
  }

  return starts;
}
