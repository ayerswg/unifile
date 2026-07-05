/**
 * Collapsible document sections
 *
 * Splits the editor's leading, non-music scaffolding into labelled, collapsible
 * sections — visually similar to the commit-group headers in the blame view —
 * so the actual content (e.g. the ABC music body) is what you see by default.
 *
 * Two sections are recognised, and ONLY once they are written in as valid:
 *   • `frontmatter` — the leading `---`…`---` YAML block (valid once the closing
 *     fence exists, i.e. parseGlobalFrontMatter reports a body offset).
 *   • `abcheader`   — the ABC tune header (X:/T:/M:/…), everything up to and
 *     including the required `K:` line, which terminates the header and starts
 *     the measures. Only recognised for abcjs documents, and only when there is
 *     music after the `K:` line.
 *
 * Each valid section renders a header bar:
 *   • expanded  → a thin bar ABOVE the section (block widget, side -1) with a
 *     caret; click to collapse.
 *   • collapsed → the section's lines are replaced by a single bar (block
 *     replace) showing the label + a line count; click to expand.
 *
 * On load everything collapsible is collapsed EXCEPT the last section (the
 * music). Sections that become valid later, while the user is typing them, are
 * NOT auto-collapsed — they appear expanded with their new header bar. Collapse
 * state is per-editor and toggled by clicking a bar; `resetCollapseEffect`
 * re-applies the load-time defaults (dispatched when a different document is
 * loaded via checkout / branch switch / open).
 */

import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { parseGlobalFrontMatter } from '../core/front-matter.js';
import { state } from './state.js';

/** Toggle one section's collapsed state by id. */
export const toggleSectionEffect = StateEffect.define();
/** Re-apply the load-time default collapse (collapse all but the last section). */
export const resetCollapseEffect = StateEffect.define();

// ---------------------------------------------------------------------------
// Section detection
// ---------------------------------------------------------------------------

function _docDslType() {
  return state.data?.dslType ?? 'markdown';
}

/**
 * Find the end of the ABC tune header: the offset just after the first `K:`
 * line (column-0 info field), which marks the start of the measures.
 * @returns {number|null} end offset, or null when there is no `K:` line yet.
 */
function _abcHeaderEnd(text, from) {
  let cursor = from;
  const rest = text.slice(from);
  for (const rawLine of rest.split('\n')) {
    const lineEnd = cursor + rawLine.length;   // position before the newline
    if (/^K:/.test(rawLine)) {
      // Include this line's trailing newline so the collapse consumes it.
      return Math.min(lineEnd + 1, text.length);
    }
    cursor = lineEnd + 1;                       // + newline
  }
  return null;
}

/** Number of source lines covered by [from, to). */
function _lineCount(text, from, to) {
  return text.slice(from, to).replace(/\n$/, '').split('\n').length;
}

/**
 * The collapsible sections present in `text` for the document's DSL.
 * @returns {Array<{id:string,label:string,from:number,to:number,lines:number}>}
 */
function detectSections(text, dslType) {
  const out = [];
  const docLen = text.length;

  const { bodyFrom } = parseGlobalFrontMatter(text);
  if (bodyFrom > 0) {
    out.push({ id: 'frontmatter', label: 'Front matter', from: 0, to: bodyFrom,
      lines: _lineCount(text, 0, bodyFrom) });
  }

  const bodyStart = bodyFrom;   // 0 when there is no front matter
  if (dslType === 'abcjs') {
    const kEnd = _abcHeaderEnd(text, bodyStart);
    // Only a section when the header is complete AND music follows it.
    if (kEnd !== null && kEnd > bodyStart && text.slice(kEnd).trim().length > 0) {
      out.push({ id: 'abcheader', label: 'Tune header', from: bodyStart, to: kEnd,
        lines: _lineCount(text, bodyStart, kEnd) });
    }
  }
  return out;
}

/** Default collapse set: every section that has content after it (i.e. not the last). */
function defaultCollapsed(sections, docLen) {
  const set = new Set();
  for (const s of sections) if (s.to < docLen) set.add(s.id);
  return set;
}

// ---------------------------------------------------------------------------
// Header bar widget
// ---------------------------------------------------------------------------

const _caret = `<svg class="cm-sh-caret" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`;

class SectionHeaderWidget extends WidgetType {
  constructor(id, label, collapsed, lines) {
    super();
    this.id = id;
    this.label = label;
    this.collapsed = collapsed;
    this.lines = lines;
  }

  eq(o) {
    return this.id === o.id && this.label === o.label &&
      this.collapsed === o.collapsed && this.lines === o.lines;
  }

  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'cm-section-header' + (this.collapsed ? ' collapsed' : '');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-expanded', String(!this.collapsed));
    el.title = this.collapsed ? `Expand ${this.label}` : `Collapse ${this.label}`;
    el.innerHTML =
      `${_caret}<span class="cm-sh-label">${this.label}</span>` +
      (this.collapsed ? `<span class="cm-sh-count">${this.lines} line${this.lines === 1 ? '' : 's'}</span>` : '');

    const toggle = () => view.dispatch({ effects: toggleSectionEffect.of(this.id) });
    // Stop mousedown reaching the editor (which would move the caret / close the
    // comment accordion) and drive the toggle on click.
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    return el;
  }

  ignoreEvent() { return true; }
}

// ---------------------------------------------------------------------------
// Decoration builder + state field
// ---------------------------------------------------------------------------

function buildDecorations(edState, collapsed) {
  const text = edState.doc.toString();
  const sections = detectSections(text, _docDslType());
  const builder = new RangeSetBuilder();
  for (const s of sections) {
    if (collapsed.has(s.id)) {
      builder.add(s.from, s.to, Decoration.replace({
        block: true,
        widget: new SectionHeaderWidget(s.id, s.label, true, s.lines),
      }));
    } else {
      builder.add(s.from, s.from, Decoration.widget({
        block: true,
        side: -1,
        widget: new SectionHeaderWidget(s.id, s.label, false, s.lines),
      }));
    }
  }
  return builder.finish();
}

const sectionCollapseField = StateField.define({
  create(edState) {
    const sections = detectSections(edState.doc.toString(), _docDslType());
    const collapsed = defaultCollapsed(sections, edState.doc.length);
    return { collapsed, deco: buildDecorations(edState, collapsed) };
  },

  update(value, tr) {
    let collapsed = value.collapsed;
    let recompute = tr.docChanged;

    for (const e of tr.effects) {
      if (e.is(toggleSectionEffect)) {
        collapsed = new Set(collapsed);
        if (collapsed.has(e.value)) collapsed.delete(e.value);
        else collapsed.add(e.value);
        recompute = true;
      } else if (e.is(resetCollapseEffect)) {
        const sections = detectSections(tr.state.doc.toString(), _docDslType());
        collapsed = defaultCollapsed(sections, tr.state.doc.length);
        recompute = true;
      }
    }

    if (!recompute) return value;   // selection-only change: positions unchanged
    return { collapsed, deco: buildDecorations(tr.state, collapsed) };
  },

  provide: f => EditorView.decorations.from(f, v => v.deco),
});

export const sectionCollapseExtension = [sectionCollapseField];
