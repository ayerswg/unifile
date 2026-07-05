/**
 * Collapsible document sections
 *
 * Splits the document into labelled, collapsible sections — visually similar to
 * the commit-group headers in the blame view — so the actual music is what you
 * see by default.
 *
 * Sections are recognised only once written in as valid:
 *   • `frontmatter` — the leading `---`…`---` YAML block (valid once the closing
 *     fence exists, i.e. parseGlobalFrontMatter reports a body offset).
 *   • `abcheader`   — the ABC tune header (X:/T:/M:/…), everything up to and
 *     including the required `K:` line. Only for abcjs documents.
 *   • `music`       — the measures after the `K:` line (only when non-empty).
 *
 * Bars are shown ONLY when the document splits into more than one section — a
 * lone section (e.g. front matter by itself) reads as no sections at all.
 *
 * Each section renders a header bar:
 *   • expanded  → a thin bar ABOVE the section (block widget, side -1) with a
 *     caret; click to collapse.
 *   • collapsed → the section's lines are replaced by a single bar (block
 *     replace) showing the label + a line count; click to expand.
 *
 * On load everything is collapsed EXCEPT the last section — the music (or, if no
 * music has been written yet, whatever the last section is). Sections that
 * become valid later, while the user is typing them, are NOT auto-collapsed —
 * they appear expanded with their new header bar. Collapse state is per-editor
 * and toggled by clicking a bar; `resetCollapseEffect` re-applies the load-time
 * defaults (dispatched when a different document is loaded via checkout / branch
 * switch / open).
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
 *
 * Bars only make sense when a document is split into MORE THAN ONE section, so
 * a single detected section (e.g. front matter alone) yields nothing. For an
 * abcjs document the body is further split into the tune header and the music
 * (measures), so a complete tune has up to three sections.
 *
 * @returns {Array<{id:string,label:string,from:number,to:number,lines:number}>}
 */
function detectSections(text, dslType) {
  const raw = [];
  const docLen = text.length;

  const { bodyFrom } = parseGlobalFrontMatter(text);
  if (bodyFrom > 0) {
    raw.push({ id: 'frontmatter', label: 'Front matter', from: 0, to: bodyFrom });
  }

  const bodyStart = bodyFrom;   // 0 when there is no front matter
  if (dslType === 'abcjs') {
    const kEnd = _abcHeaderEnd(text, bodyStart);
    if (kEnd !== null && kEnd > bodyStart) {
      raw.push({ id: 'abcheader', label: 'Tune header', from: bodyStart, to: kEnd });
      // The measures after the K: line — their own section, default-open.
      if (text.slice(kEnd).trim().length > 0) {
        raw.push({ id: 'music', label: 'Music', from: kEnd, to: docLen });
      }
    }
  }

  // Only surface bars when the document actually splits into multiple sections.
  if (raw.length < 2) return [];
  for (const s of raw) s.lines = _lineCount(text, s.from, s.to);
  return raw;
}

/** Default collapse set: every section except the last (the music / content). */
function defaultCollapsed(sections) {
  const set = new Set();
  for (let i = 0; i < sections.length - 1; i++) set.add(sections[i].id);
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
      // A block replace must end at a line END (before the trailing newline),
      // not at the next line's start. Ending on the next line's start collides
      // with an adjacent section's expanded header widget (anchored there,
      // side -1) and CM drops it — which made the next section bar vanish.
      // `s.to` includes the section's trailing newline, so back up over it.
      const blockTo = (s.to > s.from && text[s.to - 1] === '\n') ? s.to - 1 : s.to;
      builder.add(s.from, blockTo, Decoration.replace({
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
    const collapsed = defaultCollapsed(sections);
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
        collapsed = defaultCollapsed(sections);
        recompute = true;
      }
    }

    if (!recompute) return value;   // selection-only change: positions unchanged
    return { collapsed, deco: buildDecorations(tr.state, collapsed) };
  },

  provide: f => EditorView.decorations.from(f, v => v.deco),
});

export const sectionCollapseExtension = [sectionCollapseField];
