/**
 * uDraft — entry point.
 *
 * Like uPub, the udraft variant ships its own shell (no CodeMirror, no DSL
 * registry): build.mjs points esbuild straight at this module
 * (DSL_META.udraft.entry) instead of generating a standard entry.
 */

/* global UNIFILE_MODE */

import { UDraftApp } from './app.js';
import { parseDocument } from '../core/udraft/parse.js';
import { layoutDocument } from '../core/udraft/layout.js';
import { renderFloorSvg, renderExportSvg, renderPrintBody } from '../core/udraft/svg.js';

async function main() {
  const app = new UDraftApp();
  await app.init();
  // Automation hooks for tests / preview tooling (same shape as the others).
  globalThis.__uf = {
    udraft: app,
    core: { parseDocument, layoutDocument, renderFloorSvg, renderExportSvg, renderPrintBody },
  };
  if (typeof UNIFILE_MODE !== 'undefined' && UNIFILE_MODE === 'quine') {
    window.__unifile = app;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
