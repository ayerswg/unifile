---
title: Per-section syntax highlighting
---

A document with mixed DSLs needs mixed highlighting — Markdown rules for prose sections, Mermaid rules for diagram sections, and so on, all in the same CodeMirror instance.

CodeMirror 6 doesn't support this out of the box. The editor has one language at a time. But the decoration system is flexible enough to let us fake it.

## The approach

We parse the document into sections, then for each section we run the appropriate language's Lezer parser over just that slice of text. `highlightTree()` walks the resulting syntax tree and emits token ranges, which we convert into `Decoration.mark` instances with the right CSS classes.

The result is a `StateField` that rebuilds its decoration set whenever the document changes, dispatched via a custom `rebuildSectionHighlightsEffect`.

## The tricky part

Decoration marks have to be sorted and non-overlapping. Since we're building them section by section, we have to be careful about the offset arithmetic — each section's Lezer tree starts at position 0, but the marks need to land at the right absolute positions in the full document.

## Performance

For short documents this is fast enough to run synchronously on every keystroke. For very long documents we'll need to make it incremental — only reparse sections that actually changed. That's future work.
