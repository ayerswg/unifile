/**
 * Collapsible front-matter section
 *
 * The leading `---`…`---` YAML block gets a labelled, collapsible bar (visually
 * similar to the commit-group headers in the blame view) so the document body
 * — the prose, the diagram, the music — is what you see by default.
 *
 * The block is recognised only once written in as valid (the closing fence
 * exists, i.e. parseGlobalFrontMatter reports a body offset). It renders a
 * header bar:
 *   • expanded  → a thin bar ABOVE the block (block widget, side -1) with a
 *     caret; click to collapse.
 *   • collapsed → the block's lines are replaced by a single bar (block
 *     replace) showing the label + a line count; click to expand.
 *
 * On load the front matter is collapsed. A block that becomes valid later,
 * while the user is typing it, is NOT auto-collapsed — it appears expanded with
 * its new header bar. Collapse state is per-editor and toggled by clicking the
 * bar; `resetCollapseEffect` re-applies the load-time default (dispatched when a
 * different document is loaded via checkout / branch switch / open).
 *
 * Deliberately NOT split any further: the ABC tune header and the music used
 * to be separate sections; that division was removed (2026-09) — an ABC tune
 * is edited as one piece of text.
 */

import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { parseGlobalFrontMatter } from '../core/front-matter.js';

/** Toggle one section's collapsed state by id. */
export const toggleSectionEffect = StateEffect.define();
/** Re-apply the load-time default collapse (front matter collapsed). */
export const resetCollapseEffect = StateEffect.define();
/** Rebuild the section decorations without touching the collapse set (e.g. on
 *  orientation change, where bars are suppressed in landscape then restored). */
export const refreshSectionsEffect = StateEffect.define();

// A phone on its side has little vertical room, so the section bars are
// suppressed in landscape (the same breakpoint the mobile CSS uses). The
// collapse *state* is preserved so rotating back to portrait restores it.
export const landscapePhoneMql = window.matchMedia(
  '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'
);

// ---------------------------------------------------------------------------
// Section detection
// ---------------------------------------------------------------------------

/** Number of source lines covered by [from, to). */
function _lineCount(text, from, to) {
  return text.slice(from, to).replace(/\n$/, '').split('\n').length;
}

/**
 * The collapsible sections present in `text`: the front matter, when valid.
 * (Kept as a list so a future section kind slots in.)
 *
 * @returns {Array<{id:string,label:string,from:number,to:number,lines:number}>}
 */
function detectSections(text) {
  // Landscape phone: pretend there are no sections (bars hidden). The field's
  // collapse Set is untouched, so portrait restores the previous state.
  if (landscapePhoneMql.matches) return [];

  const raw = [];
  const { bodyFrom } = parseGlobalFrontMatter(text);
  if (bodyFrom > 0) {
    raw.push({ id: 'frontmatter', label: 'Front matter', from: 0, to: bodyFrom });
  }
  for (const s of raw) s.lines = _lineCount(text, s.from, s.to);
  return raw;
}

/** Default collapse set: every section (i.e. the front matter) starts collapsed. */
function defaultCollapsed(sections) {
  return new Set(sections.map(s => s.id));
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
    // The bar's vertical spacing lives on this wrapper as PADDING, not as a
    // margin on the bar itself: CodeMirror measures a block widget's height
    // from its DOM border-box and ignores outer margins, so a margin here would
    // desync the gutter from the content (the gutter markers drift upward by the
    // uncounted margin). Padding is inside the measured box, so it stays aligned.
    const wrap = document.createElement('div');
    wrap.className = 'cm-section-header-wrap';

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
    wrap.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    wrap.appendChild(el);
    return wrap;
  }

  ignoreEvent() { return true; }
}

// ---------------------------------------------------------------------------
// Decoration builder + state field
// ---------------------------------------------------------------------------

function buildDecorations(edState, collapsed) {
  const text = edState.doc.toString();
  const sections = detectSections(text);
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
    const sections = detectSections(edState.doc.toString());
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
        const sections = detectSections(tr.state.doc.toString());
        collapsed = defaultCollapsed(sections);
        recompute = true;
      } else if (e.is(refreshSectionsEffect)) {
        // Orientation change: rebuild bars (may now be suppressed / restored)
        // but keep the existing collapse set.
        recompute = true;
      }
    }

    if (!recompute) return value;   // selection-only change: positions unchanged
    return { collapsed, deco: buildDecorations(tr.state, collapsed) };
  },

  provide: f => EditorView.decorations.from(f, v => v.deco),
});

export const sectionCollapseExtension = [sectionCollapseField];
