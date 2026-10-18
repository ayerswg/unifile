---
layout: page
title: The App
permalink: /app/
---

Unifile is a single HTML file that runs entirely in your browser. No server, no account, no sync — just open it and write.

## Get it

Each format is its own dedicated app — install it as an offline PWA or download the standalone `.html`:

- **[Markdown](/get/)** — prose and notes
- **[Mermaid](/mermaid/)** — diagrams as text
- **[ABC Notation](/abc/)** — music, with a bundled offline piano

## What it does

Each app is focused on one format, keeps every document you write in a library on your device, and has a built-in save history (snapshots, diffs, restore) — all fully offline, with nothing ever sent anywhere. Prose sections use Markdown; a `#!shebang` at the top of a section switches it to that app's format:

```
#!markdown
This is prose.

#!mermaid
graph LR
  A --> B
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Enter` | Render current section |
| `Ctrl+/` | Toggle comment |
| `Ctrl+Shift+P` | Command palette |
