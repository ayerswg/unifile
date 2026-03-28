/**
 * unifile default entry point
 *
 * This file is used directly only when running outside of the build
 * (e.g. with a dev server that understands bare specifiers).
 *
 * The build system (build/build.mjs) generates a purpose-built entry
 * that imports only the DSL plugins for the selected variant, so
 * unused DSLs don't end up in the bundle.
 *
 * Default: all three DSLs (for local development convenience).
 */

import './dsl/markdown.js';
import './dsl/abcjs.js';
import './dsl/mermaid.js';
import './dsl/fountain.js';

import { App } from './ui/app.js';

async function main() {
  const app = new App();
  await app.init();
  if (typeof UNIFILE_MODE !== 'undefined' && UNIFILE_MODE === 'quine') {
    window.__unifile = app;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
