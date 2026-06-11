---
title: The model layer
---

Unifile documents have three layers of structure: the DSL (what syntax a section uses), the layout (how sections are arranged visually), and the model (the coordinate metaphor that governs the whole document).

Models are the newest addition and the least visible. Here's what they do.

## What a model is

A model is a named coordinate system for thinking about your content. The five built-in models are:

- **flow** — linear, top-to-bottom. Default.
- **grid** — sections as cells in a 2D grid.
- **spatial** — sections placed at (x, y) coordinates on an infinite canvas.
- **timeline** — sections as events along a time axis.
- **graph** — sections as nodes in a directed graph.

You declare one in front matter:

```
model: spatial
```

## What they unlock

The model tells the renderer how to lay out sections and what navigation gestures make sense. A `spatial` model might let you pan and zoom. A `timeline` model might let you scrub through time. A `graph` model might let you follow edges.

Most of this is aspirational — today, only `flow` and `slides` layout are fully implemented. But the model field is in the format now, so documents written today will carry the right metadata forward.
