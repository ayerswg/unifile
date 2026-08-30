/**
 * uPub — entry point.
 *
 * The upub variant has its own shell (no CodeMirror, no DSL registry) so it
 * does NOT go through the generated `_entry_*` files build.mjs writes for the
 * standard variants — build.mjs points esbuild straight at this module (see
 * DSL_META.upub.entry).
 */

/* global UNIFILE_MODE */

import { UPubApp } from './app.js';
import { buildEpub, splitChapters } from './epub.js';

async function main() {
  const app = new UPubApp();
  await app.init();
  // Same automation hooks as the standard variants (tests / preview tooling).
  globalThis.__uf = { upub: app, epub: { buildEpub, splitChapters } };
  if (typeof UNIFILE_MODE !== 'undefined' && UNIFILE_MODE === 'quine') {
    window.__unifile = app;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
