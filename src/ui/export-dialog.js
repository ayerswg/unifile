/**
 * Export dialog
 *
 * Two categories of export:
 *   1. Quine export  – downloads a new standalone .htm quine file.
 *                      Only available when the document is clean (committed).
 *                      Filename: <title>.<7-char-hash>.htm
 *   2. Format export – converts the current content to the DSL's native
 *                      formats (HTML, PDF, SVG, MIDI, PNG, …).
 *                      Available regardless of dirty state.
 */

import { state, PANELS } from './state.js';
import { getDSL } from '../dsl/registry.js';
import { generateQuine, downloadFile, downloadBlob } from '../core/storage.js';
import { parseGlobalFrontMatter } from '../core/front-matter.js';

export class ExportDialog {
  constructor(container, handlers = {}) {
    this.el = container;
    this.handlers = handlers;
    this._unsub = [];

    this._unsub.push(state.on('panel-change', (panel) => {
      if (panel === PANELS.EXPORT) this.show();
      else this.hide();
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  show() {
    const dslId    = state.data?.dslType ?? 'markdown';
    const isDirty  = state.isDirty;
    const hash     = state.headHash;
    const shortH   = hash ? hash.slice(0, 7) : null;
    const filename = shortH ? quineFilename(state.title, shortH) : null;

    let exporters = {};
    try { exporters = getDSL(dslId).exporters ?? {}; } catch {}

    const { meta } = parseGlobalFrontMatter(state.currentContent ?? '');
    const layout = meta.layout;
    const isPrintableLayout = layout === 'document' || layout === 'slides';

    this.el.innerHTML = `
      <div class="dialog-overlay" id="export-overlay">
        <div class="dialog" role="dialog" aria-modal="true">
          <div class="dialog-header">
            <h2 class="dialog-title">Export</h2>
            <button class="dialog-close" id="export-close">&times;</button>
          </div>
          <div class="dialog-body">

            <div class="export-section">
              <h3 class="export-section-title">Quine export</h3>
              <p class="export-section-desc">
                Download a fully self-contained copy of this document including all
                version history. The recipient can open it offline and continue editing.
              </p>

              ${isDirty ? `
                <div class="export-dirty-notice">
                  <span class="export-dirty-icon">⚠</span>
                  You have uncommitted changes. Commit before exporting so the
                  filename reflects the exact state of the file.
                </div>
              ` : ''}

              <div class="export-option-row ${isDirty ? 'disabled' : ''}">
                <div class="export-option-info">
                  <strong>${escHtml(filename ?? '(commit required)')}</strong>
                  <span class="export-option-sub">
                    ${formatCommitCount(state.vcs)} · ${escHtml(dslId)}
                  </span>
                </div>
                <button class="btn btn-primary" id="export-quine" ${isDirty || !hash ? 'disabled' : ''}>
                  Download
                </button>
              </div>
            </div>

            <div class="export-section">
              <h3 class="export-section-title">Format export</h3>
              <p class="export-section-desc">
                Export the document content in another format.
                Version history is not included.
              </p>
              ${isPrintableLayout ? `
                <div class="export-option-row">
                  <div class="export-option-info">
                    <strong>Print / PDF</strong>
                    <span class="export-option-sub">Exactly as rendered — uses browser print dialog</span>
                  </div>
                  <button class="btn btn-secondary" id="export-print">Print</button>
                </div>
              ` : ''}
              ${Object.entries(exporters).length === 0 && !isPrintableLayout
                ? '<p class="export-empty">No format exporters available for this DSL.</p>'
                : Object.entries(exporters).map(([key, exp]) => `
                    <div class="export-option-row">
                      <div class="export-option-info">
                        <strong>${escHtml(exp.label)}</strong>
                        <span class="export-option-sub">${escHtml(exp.mime)}</span>
                      </div>
                      <button class="btn btn-secondary export-format-btn" data-key="${key}">
                        Export ${escHtml(exp.ext)}
                      </button>
                    </div>
                  `).join('')
              }
            </div>

          </div>
          <div class="dialog-footer">
            <button class="btn btn-ghost" id="export-cancel">Close</button>
          </div>
        </div>
      </div>
    `;

    this.el.style.display = '';
    this._bindEvents(exporters, filename);
  }

  hide() {
    this.el.innerHTML = '';
    this.el.style.display = 'none';
  }

  _bindEvents(exporters, filename) {
    this.el.querySelector('#export-close')?.addEventListener('click', () => state.closePanel());
    this.el.querySelector('#export-cancel')?.addEventListener('click', () => state.closePanel());
    this.el.querySelector('#export-overlay')?.addEventListener('click', e => {
      if (e.target.id === 'export-overlay') state.closePanel();
    });

    this.el.querySelector('#export-print')?.addEventListener('click', () => {
      state.closePanel();
      // Close panel first, then print so the dialog doesn't appear in the printout.
      setTimeout(() => this.handlers.print?.(), 100);
    });

    // Quine export (only fires when button is not disabled)
    this.el.querySelector('#export-quine')?.addEventListener('click', async () => {
      if (state.isDirty || !state.headHash) return;
      await this._exportQuine(filename);
    });

    // Format exports
    this.el.querySelectorAll('.export-format-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const exp = exporters[btn.dataset.key];
        if (exp) await this._exportFormat(exp, btn);
      });
    });
  }

  async _exportQuine(filename) {
    const btn = this.el.querySelector('#export-quine');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

    try {
      const preview = await this.handlers.renderPreview?.() ?? '';
      const data    = { ...state.data, ...state.vcs.serialize() };
      const html    = generateQuine(data, preview, state.title);
      downloadFile(html, filename, 'text/html');
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Download'; }
    }
  }

  async _exportFormat(exp, btn) {
    const origText = btn.textContent;
    btn.disabled   = true;
    btn.textContent = 'Exporting…';

    try {
      const result = await exp.export(state.currentContent);
      if (result instanceof Blob) {
        // Format exports use title + ext only (no hash/dsl suffix needed)
        const name = slugify(state.title) + exp.ext;
        if (exp.binary) {
          // Binary export (e.g. DOCX) — download Blob directly to avoid
          // corrupting binary data through a text() round-trip.
          downloadBlob(result, name);
        } else {
          downloadFile(await result.text(), name, exp.mime);
        }
      }
      // null → e.g. PDF handled by the print dialog; nothing to do
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    } finally {
      btn.disabled    = false;
      btn.textContent = origText;
    }
  }
}

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/**
 * Build the canonical quine filename.
 * Pattern: <slug>.<7-char-hash>.htm
 * Example: my-song.a1b2c3d.htm
 */
function quineFilename(title, shortHash) {
  return `${slugify(title)}.${shortHash}.htm`;
}

/** Convert a document title to a safe, lowercase filename slug. */
function slugify(str) {
  return String(str || 'untitled')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'untitled';
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatCommitCount(vcs) {
  if (!vcs) return '0 commits';
  const n = Object.keys(vcs.commits).length;
  return `${n} commit${n !== 1 ? 's' : ''}`;
}
