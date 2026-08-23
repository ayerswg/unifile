/**
 * Unifile Writer — entry point.
 *
 * The writer variant has its own shell (no CodeMirror, no DSL registry) so it
 * does NOT go through the generated `_entry_*` files build.mjs writes for the
 * standard variants — build.mjs points esbuild straight at this module (see
 * DSL_META.writer.entry).
 */

/* global UNIFILE_MODE */

import { WriterApp } from './app.js';
import { buildEpub, splitChapters } from './epub.js';

async function main() {
  const app = new WriterApp();
  await app.init();
  // Same automation hooks as the standard variants (tests / preview tooling).
  globalThis.__uf = { writer: app, epub: { buildEpub, splitChapters } };
  if (typeof UNIFILE_MODE !== 'undefined' && UNIFILE_MODE === 'quine') {
    window.__unifile = app;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
