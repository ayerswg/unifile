---
title: Building the plugin system
pinned: true
---

The core challenge with a multi-DSL editor is that you want the host app to stay small while letting language support grow unboundedly. The solution we landed on: DSL plugins are standalone `.js` files that you install by dragging onto the editor.

## How it works

Each plugin is a self-contained ES module that exports a DSL descriptor:

```js
export default {
  id: "mermaid",
  label: "Mermaid",
  render(source, container) { /* ... */ },
  getEditorExtensions() { /* CodeMirror extensions */ }
}
```

When you drag a `.plugin.js` file onto `unifile.uni.html`, the app reads it, registers the DSL, and immediately makes it available in any section tagged `#!mermaid` (or whatever the id is).

## The import redirect trick

Plugins need access to CodeMirror and the app's state without bundling them a second time. We solve this with a build-time esbuild plugin that rewrites imports of specific packages to pull from `globalThis.__uf` instead — the host API surface the app exposes.

So a plugin can write:

```js
import { EditorView } from "@codemirror/view";
```

And at runtime, that resolves to the already-loaded CM6 instance inside the host app. No duplication, no version mismatch.

## What's next

The plugin manifest currently lives only in memory — refreshing the page loses your installed plugins unless the app has saved them to `localStorage`. Persistent plugin storage across sessions is the next piece.
