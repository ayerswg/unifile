/**
 * Fountain Screenplay DSL plugin
 *
 * Fountain is a plain-text screenplay markup language (https://fountain.io).
 * Renders to styled HTML that mimics standard screenplay formatting.
 *
 * Supported elements:
 *   Title page, Scene headings, Action, Characters, Dialogue,
 *   Parentheticals, Transitions, Centered text, Page breaks,
 *   Synopses, Sections, Lyrics, Notes, Boneyard (comments),
 *   Forced elements.
 *
 * Styling adapts to context:
 *   • Print layouts (slides / document pages): no outer padding or background
 *     override — the page container provides those.
 *   • Standalone / webpage: screenplay-style layout that respects the current
 *     light or dark theme instead of forcing a white background.
 */

import { StreamLanguage } from '@codemirror/language';
import { registerDSL } from './registry.js';

// ---------------------------------------------------------------------------
// Fountain stream language for CodeMirror 6
// ---------------------------------------------------------------------------

const fountainLanguage = StreamLanguage.define({
  name: 'fountain',

  startState() {
    return {
      inTitlePage:      true,
      inDialogue:       false,
      inBoneyard:       false,
      prevWasCharacter: false,
    };
  },

  token(stream, state) {
    const sol = stream.sol();

    if (state.inBoneyard) {
      if (stream.match(/.*?\*\//)) state.inBoneyard = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (sol && stream.match(/\/\*/)) {
      if (!stream.match(/.*?\*\//)) state.inBoneyard = true;
      stream.skipToEnd();
      return 'comment';
    }
    if (sol && stream.match(/\/\*.*?\*\//)) return 'comment';
    if (sol && stream.match(/\[\[.*?\]\]/))  return 'comment';

    if (sol && stream.match(/^\s*$/, false) && stream.eol()) {
      state.inDialogue = false;
      state.prevWasCharacter = false;
      stream.next();
      return null;
    }

    if (state.inTitlePage && sol) {
      if (stream.match(/^[A-Za-z][A-Za-z\s]*:/)) return 'meta';
      state.inTitlePage = false;
    }

    if (sol && stream.match(/^#{1,3}\s/)) { stream.skipToEnd(); return 'heading'; }
    if (sol && stream.match(/^=(?!=)/))   { stream.skipToEnd(); return 'comment'; }
    if (sol && stream.match(/^={3,}\s*$/)) return 'operator';

    if (sol) {
      const rest = stream.string.slice(stream.pos);
      const isTransition =
        /\bTO:\s*$/.test(rest) ||
        /^(FADE IN:|FADE OUT\.|FADE TO BLACK\.|CUT TO:|SMASH CUT TO:|MATCH CUT TO:|JUMP CUT TO:|DISSOLVE TO:|IRIS IN:|IRIS OUT\.)/.test(rest.trim());
      if (isTransition) {
        state.inDialogue = false; state.prevWasCharacter = false;
        stream.skipToEnd(); return 'operator';
      }
    }

    if (sol && stream.match(/^>\s*/))  { stream.skipToEnd(); return 'string'; }
    if (sol && stream.match(/^~/))     { stream.skipToEnd(); return 'string'; }

    if (sol) {
      const rest = stream.string.slice(stream.pos).trim();
      if (/^\.(INT|EXT|INT\.\/EXT|I\/E|EST)\b/i.test(rest) ||
          /^(INT|EXT|INT\.\/EXT|I\/E|EST)\b/i.test(rest)) {
        state.inDialogue = false; state.prevWasCharacter = false;
        stream.skipToEnd(); return 'keyword';
      }
    }

    if (state.inDialogue && sol && stream.match(/^\(/)) {
      stream.skipToEnd(); return 'comment';
    }

    if (sol) {
      const rest = stream.string.slice(stream.pos).trim();
      const isCharacter =
        /^@/.test(rest) ||
        (/^[A-Z][A-Z0-9 '.]+(\s*\(.*\))?\s*$/.test(rest) &&
          rest.length > 1 &&
          !/^(INT|EXT|INT\.\/EXT|I\/E|EST)\b/.test(rest));
      if (isCharacter && !state.inDialogue) {
        state.prevWasCharacter = true;
        stream.skipToEnd(); return 'attributeName';
      }
    }

    if (state.prevWasCharacter && sol) {
      state.inDialogue = true;
      state.prevWasCharacter = false;
    }
    if (state.inDialogue && sol) { stream.skipToEnd(); return 'string'; }

    if (sol && stream.match(/^!/)) { stream.skipToEnd(); return null; }

    stream.next();
    return null;
  },
});

// ---------------------------------------------------------------------------
// Parser — converts source text to typed element objects with source offsets
// ---------------------------------------------------------------------------

/**
 * Parse a Fountain source string into an array of element descriptors.
 * Each element carries `srcFrom` and `srcTo` — byte offsets into `src`.
 *
 * @param {string} src
 * @returns {Array<{type:string, srcFrom:number, srcTo:number, [key:string]:any}>}
 */
function parseFountain(src) {
  const lines = src.split('\n');
  const lineStart = new Array(lines.length + 1);
  lineStart[0] = 0;
  for (let j = 0; j < lines.length; j++) {
    lineStart[j + 1] = lineStart[j] + lines[j].length + 1; // +1 for \n
  }

  const elements = [];
  let li = 0; // current absolute line index into `lines`

  // ── Title page ─────────────────────────────────────────────────────────────
  const titlePageData = {};
  const titlePageStart = lineStart[0];
  while (li < lines.length) {
    const line = lines[li];
    if (line.trim() === '') {
      if (Object.keys(titlePageData).length > 0) { li++; break; }
      else break;
    }
    const m = line.match(/^([A-Za-z][A-Za-z\s]*):\s*(.*)$/);
    // Reject all-caps "keys" — those are screenplay transitions (e.g. FADE IN:),
    // not title-page metadata.  Valid title page keys always contain lowercase.
    if (m && /[a-z]/.test(m[1])) {
      const key = m[1].trim();
      const valueLines = m[2].trim() ? [m[2].trim()] : [];
      li++;
      // Collect indented continuation lines (tab or leading spaces)
      while (li < lines.length && /^[ \t]/.test(lines[li])) {
        valueLines.push(lines[li].trim());
        li++;
      }
      titlePageData[key] = valueLines.join('\n');
    } else break;
  }
  if (Object.keys(titlePageData).length > 0) {
    elements.push({ type: 'title-page', data: titlePageData,
      srcFrom: titlePageStart, srcTo: lineStart[li] });
  }

  // ── Body ───────────────────────────────────────────────────────────────────
  // Strip boneyards from the body lines for content decisions, but keep the
  // original line indices for source-position tracking (line counts match).
  const bodyOffset = li; // absolute line index where the body starts
  const bodyLines  = _stripBoneyards(lines.slice(bodyOffset));

  let bi = 0; // index into bodyLines (= absolute index bodyOffset + bi)
  let inDialogueBlock      = false;
  let lastWasCharacter     = false;

  const absLine  = () => bodyOffset + bi;
  const from     = (startBi) => lineStart[bodyOffset + startBi];
  const to       = (endBi)   => lineStart[Math.min(bodyOffset + endBi, lines.length)];

  while (bi < bodyLines.length) {
    const rawLine = bodyLines[bi];
    const trimmed = rawLine.trim();

    // ── Blank line ────────────────────────────────────────────────────────────
    if (trimmed === '') {
      if (inDialogueBlock) { inDialogueBlock = false; lastWasCharacter = false; }
      elements.push({ type: 'blank', srcFrom: from(bi), srcTo: to(bi + 1) });
      bi++;
      continue;
    }

    // ── Page break: === ───────────────────────────────────────────────────────
    if (/^={3,}\s*$/.test(trimmed)) {
      elements.push({ type: 'page-break', srcFrom: from(bi), srcTo: to(bi + 1) });
      inDialogueBlock = false; lastWasCharacter = false;
      bi++; continue;
    }

    // ── Inline boneyard ───────────────────────────────────────────────────────
    if (/^\/\*.*\*\/\s*$/.test(trimmed)) { bi++; continue; }

    // ── Note: [[ ... ]] ───────────────────────────────────────────────────────
    if (/^\[\[/.test(trimmed)) {
      const startBi = bi;
      let noteText = trimmed;
      while (!/\]\]/.test(noteText) && bi + 1 < bodyLines.length) {
        bi++;
        noteText += ' ' + bodyLines[bi].trim();
      }
      const noteContent = noteText.replace(/^\[\[/, '').replace(/\]\].*$/, '').trim();
      elements.push({ type: 'note', text: noteContent,
        srcFrom: from(startBi), srcTo: to(bi + 1) });
      bi++; continue;
    }

    // ── Section: #, ##, ### ───────────────────────────────────────────────────
    const secM = trimmed.match(/^(#{1,3})\s+(.*)/);
    if (secM) {
      elements.push({ type: 'section', level: secM[1].length, text: secM[2],
        srcFrom: from(bi), srcTo: to(bi + 1) });
      inDialogueBlock = false; lastWasCharacter = false;
      bi++; continue;
    }

    // ── Synopsis: = line ──────────────────────────────────────────────────────
    if (/^=(?!=)/.test(trimmed)) {
      elements.push({ type: 'synopsis', text: trimmed.slice(1).trim(),
        srcFrom: from(bi), srcTo: to(bi + 1) });
      bi++; continue;
    }

    // ── Centered text: > text ─────────────────────────────────────────────────
    if (/^>/.test(trimmed)) {
      const centeredText = trimmed.replace(/^>\s*/, '').replace(/\s*<\s*$/, '');
      elements.push({ type: 'centered', text: centeredText,
        srcFrom: from(bi), srcTo: to(bi + 1) });
      inDialogueBlock = false; lastWasCharacter = false;
      bi++; continue;
    }

    // ── Lyrics: ~ line ────────────────────────────────────────────────────────
    if (/^~/.test(trimmed)) {
      elements.push({ type: 'lyric', text: trimmed.slice(1).trim(),
        srcFrom: from(bi), srcTo: to(bi + 1) });
      bi++; continue;
    }

    // ── Forced scene heading: .HEADING ────────────────────────────────────────
    if (/^\.(?!\.)/.test(trimmed)) {
      elements.push({ type: 'scene-heading', text: trimmed.slice(1).trim().toUpperCase(),
        srcFrom: from(bi), srcTo: to(bi + 1) });
      inDialogueBlock = false; lastWasCharacter = false;
      bi++; continue;
    }

    // ── Forced character: @Name ───────────────────────────────────────────────
    if (/^@/.test(trimmed)) {
      elements.push({ type: 'character', text: trimmed.slice(1).trim(),
        srcFrom: from(bi), srcTo: to(bi + 1) });
      lastWasCharacter = true; inDialogueBlock = true;
      bi++; continue;
    }

    // ── Forced action: !text ──────────────────────────────────────────────────
    if (/^!/.test(trimmed)) {
      elements.push({ type: 'action', text: _fmt(trimmed.slice(1)),
        srcFrom: from(bi), srcTo: to(bi + 1) });
      inDialogueBlock = false; lastWasCharacter = false;
      bi++; continue;
    }

    // ── Transition ────────────────────────────────────────────────────────────
    const isTransition =
      /\bTO:\s*$/.test(trimmed) ||
      /^(FADE IN:|FADE OUT\.|FADE TO BLACK\.|CUT TO:|SMASH CUT TO:|MATCH CUT TO:|JUMP CUT TO:|DISSOLVE TO:|IRIS IN:|IRIS OUT\.)/.test(trimmed);
    if (isTransition && !inDialogueBlock) {
      elements.push({ type: 'transition', text: trimmed,
        srcFrom: from(bi), srcTo: to(bi + 1) });
      inDialogueBlock = false; lastWasCharacter = false;
      bi++; continue;
    }

    // ── Scene heading: INT./EXT./etc. ─────────────────────────────────────────
    if (/^(INT\.|EXT\.|INT\.\/EXT\.|I\/E\s|EST\.)\s/i.test(trimmed) && !inDialogueBlock) {
      elements.push({ type: 'scene-heading', text: trimmed.toUpperCase(),
        srcFrom: from(bi), srcTo: to(bi + 1) });
      lastWasCharacter = false;
      bi++; continue;
    }

    // ── Inside a dialogue block ────────────────────────────────────────────────
    if (inDialogueBlock) {
      if (/^\(/.test(trimmed)) {
        elements.push({ type: 'parenthetical', text: trimmed,
          srcFrom: from(bi), srcTo: to(bi + 1) });
      } else {
        elements.push({ type: 'dialogue', text: _fmt(trimmed),
          srcFrom: from(bi), srcTo: to(bi + 1) });
      }
      lastWasCharacter = false;
      bi++; continue;
    }

    // ── Character cue: ALL CAPS ────────────────────────────────────────────────
    // Per Fountain spec, a character cue must be IMMEDIATELY followed by dialogue
    // with NO blank lines between them.  We check the very next line — if it's
    // blank (or absent), the all-caps line is action text, not a character name.
    if (_isCharacterCue(trimmed)) {
      const nextLine = bodyLines[bi + 1] ?? '';
      const nextTrimmed = nextLine.trim();
      if (nextTrimmed && !_looksLikeSceneOrTransition(nextTrimmed)) {
        elements.push({ type: 'character', text: trimmed,
          srcFrom: from(bi), srcTo: to(bi + 1) });
        lastWasCharacter = true; inDialogueBlock = true;
        bi++; continue;
      }
    }

    // ── Default: Action ───────────────────────────────────────────────────────
    elements.push({ type: 'action', text: _fmt(trimmed),
      srcFrom: from(bi), srcTo: to(bi + 1) });
    inDialogueBlock = false; lastWasCharacter = false;
    bi++;
  }

  return elements;
}

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

/** Strip block boneyards from a line array. Line count is preserved (blanked out). */
function _stripBoneyards(lines) {
  const result = [];
  let inside = false;
  for (const line of lines) {
    if (inside) {
      if (line.includes('*/')) {
        inside = false;
        result.push(line.slice(line.indexOf('*/') + 2) || '');
      } else {
        result.push('');
      }
    } else if (line.includes('/*')) {
      const before = line.slice(0, line.indexOf('/*'));
      if (line.includes('*/')) {
        const after = line.slice(line.lastIndexOf('*/') + 2);
        result.push(before + after);
      } else {
        inside = true;
        result.push(before || '');
      }
    } else {
      result.push(line);
    }
  }
  return result;
}

function _isCharacterCue(trimmed) {
  if (!trimmed) return false;
  // Strip ALL parenthetical extensions: (V.O.), (CONT'D), (O.S.), etc.
  // A character name like "EDWARD (V.O.)(CONT'D)" has multiple extensions;
  // we remove them all before checking the base name.
  const core = trimmed.replace(/\s*\([^)]*\)/g, '').trim();
  if (core.length < 2) return false;
  if (!/^[A-Z@][A-Z0-9 '.-]*[A-Z0-9.]$/.test(core) && !/^@/.test(trimmed)) return false;
  if (/^(INT|EXT|INT\.\/EXT|I\/E|EST)\b/.test(core)) return false;
  return true;
}

function _nextNonBlank(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() !== '') return lines[i];
  }
  return null;
}

function _looksLikeSceneOrTransition(t) {
  return (
    /^(INT\.|EXT\.|INT\.\/EXT\.|I\/E\s|EST\.)\s/i.test(t) ||
    /\bTO:\s*$/.test(t) ||
    /^(FADE IN:|FADE OUT\.|FADE TO BLACK\.|CUT TO:)/.test(t) ||
    /^#{1,3}\s/.test(t) ||
    /^={3,}/.test(t)
  );
}

/** Apply inline Fountain formatting (*italic*, **bold**, _underline_). */
function _fmt(text) {
  let t = _esc(text);
  t = t.replace(/\*{3}([^*]+)\*{3}/g, '<strong><em>$1</em></strong>');
  t = t.replace(/\*{2}([^*]+)\*{2}/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  t = t.replace(/_(.*?)_/g,     '<u>$1</u>');
  return t;
}

// ---------------------------------------------------------------------------
// Styles (injected once per render)
// ---------------------------------------------------------------------------

const FOUNTAIN_STYLE_ID = 'uf-fountain-styles';

function _ensureStyles() {
  if (document.getElementById(FOUNTAIN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FOUNTAIN_STYLE_ID;
  style.textContent = `
/* =======================================================================
   Fountain base — always applied
   All element nodes are <div>s so generic layout-container p/h* rules
   cannot override fountain's carefully measured column margins.
   ======================================================================= */
.fountain-screenplay {
  font-family: 'Courier Prime', 'Courier New', Courier, monospace;
  font-size: 12pt;
  line-height: 1.5;
}

/* =======================================================================
   Standalone mode — screenplay "paper" presentation
   Used when fountain is the top-level DSL (webpage or direct preview).
   ======================================================================= */
.fountain-standalone {
  padding: 1in 1in 1in 1.5in;
  max-width: 8.5in;
  margin: 0 auto;
  background: #f9f9f7;
  color: #111;
  border-radius: 2px;
  box-shadow: 0 2px 16px rgba(0,0,0,.30);
}
[data-theme="dark"] .fountain-standalone {
  background: #1e1e2e;
  color: #cdd6f4;
  box-shadow: none;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .fountain-standalone {
    background: #1e1e2e;
    color: #cdd6f4;
    box-shadow: none;
  }
}

/* =======================================================================
   Print mode — inside a slide frame or document page.
   The container already supplies background, padding, and size.
   ======================================================================= */
.fountain-print {
  /* no outer chrome — let the container handle it */
}

/* =======================================================================
   Title page
   In standalone mode: flex column, title/credit centred vertically,
   contact pinned to the bottom-left — mimics a proper screenplay title page.
   In print mode: natural flow (no viewport-relative min-height).
   ======================================================================= */
.fountain-standalone .fountain-title-page {
  display: flex;
  flex-direction: column;
  min-height: calc(11in - 2in);   /* standard page minus top+bottom margins */
  padding-bottom: 1em;
  border-bottom: 1px solid currentColor;
  opacity: 0.92;
}
.fountain-print .fountain-title-page {
  display: flex;
  flex-direction: column;
  /* Pad so the page feels like a full sheet without relying on a fixed parent height */
  min-height: 9in;
  padding-bottom: .5em;
  border-bottom: 1px solid currentColor;
  opacity: 0.92;
}

/* Center block: title / credit / author / source float to the vertical middle.
   flex:1 works when the parent has a defined height (standalone uses min-height on
   the viewport; print uses min-height: 9in).  Both resolve the flex context. */
.fountain-title-page .ft-center-block {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  padding: 2em 0;
}
.fountain-title-page .ft-title  {
  display: block;
  font-size: 18pt; font-weight: bold; text-transform: uppercase;
  margin-bottom: .6em;
}
.fountain-title-page .ft-credit {
  display: block;
  font-size: 12pt; margin-bottom: .25em;
}
.fountain-title-page .ft-author {
  display: block;
  font-size: 14pt; font-weight: bold; margin-bottom: .25em;
}
.fountain-title-page .ft-meta   {
  display: block;
  font-size: 11pt; opacity: .7; margin-top: .25em;
}
/* Contact sits at the bottom-left, outside the center block */
.fountain-title-page .ft-contact {
  display: block;
  font-size: 10pt; opacity: .7; text-align: left; margin-top: auto;
  white-space: pre-line;
}

/* =======================================================================
   Body elements
   All are display:block divs.  Margins are relative to the text-column
   width (the fountain-screenplay container minus its own padding), which
   matches standard US screenplay proportions (6" column, Courier 12pt).

   Standard column positions (% of 6" text column):
     Action / scene heading   : 0 % – 100 %
     Character cue            : 37 % from left  (≈ 2.2" / 6")
     Dialogue                 : 17 % – 75 %     (≈ 1" – 4.5" / 6")
     Parenthetical            : 24 % – 66 %     (≈ 1.4" – 4" / 6")
     Transition               : right-aligned
   ======================================================================= */
.fountain-scene-heading {
  display: block;
  font-weight: bold;
  text-transform: uppercase;
  text-decoration: underline;
  margin-top: 1.5em;
  margin-bottom: .25em;
}
.fountain-action {
  display: block;
  margin-top: 0;
  margin-bottom: .25em;
}
.fountain-character {
  display: block;
  margin-left: 37%;
  margin-top: .75em;
  margin-bottom: 0;
  text-transform: uppercase;
}
.fountain-dialogue {
  display: block;
  margin-left: 17%;
  margin-right: 25%;
  margin-top: 0;
  margin-bottom: 0;
}
.fountain-parenthetical {
  display: block;
  margin-left: 24%;
  margin-right: 34%;
  margin-top: 0;
  margin-bottom: 0;
  font-style: italic;
  opacity: .8;
}
.fountain-transition {
  display: block;
  text-align: right;
  text-transform: uppercase;
  margin-top: 1em;
  margin-bottom: .5em;
}
.fountain-centered {
  display: block;
  text-align: center;
  margin: .5em 0;
}
.fountain-lyric {
  display: block;
  margin-left: 17%;
  margin-right: 25%;
  font-style: italic;
}
.fountain-note {
  display: block;
  font-size: 10pt;
  opacity: .5;
  font-style: italic;
  border-left: 2px solid currentColor;
  padding-left: .5em;
  margin: .5em 0;
}
.fountain-synopsis {
  display: block;
  font-style: italic;
  opacity: .55;
  margin-left: 1em;
  margin-bottom: .25em;
  font-size: 11pt;
}
.fountain-section-1 {
  display: block;
  font-size: 14pt; font-weight: bold; text-transform: uppercase;
  margin-top: 2em; margin-bottom: .5em;
  border-bottom: 1px solid currentColor; opacity: .8;
}
.fountain-section-2 {
  display: block;
  font-size: 12pt; font-weight: bold; text-transform: uppercase;
  margin-top: 1.5em; margin-bottom: .25em; opacity: .75;
}
.fountain-section-3 {
  display: block;
  font-size: 12pt; font-weight: bold;
  margin-top: 1em; margin-bottom: .25em; opacity: .7;
}
.fountain-page-break {
  display: block;
  border-top: 1px dashed currentColor;
  margin: 2em 0;
  text-align: right;
  font-size: 9pt;
  opacity: .4;
}
.fountain-page-break::after { content: 'page break'; }
.fountain-blank { display: block; height: .5em; }
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// DOM renderer — builds elements with data-doc-from/to for click-back
// ---------------------------------------------------------------------------

function _makeTitlePage(el, base) {
  const d = el.data;
  const div = document.createElement('div');
  div.className = 'fountain-title-page';
  div.dataset.docFrom = base + el.srcFrom;
  div.dataset.docTo   = base + el.srcTo;

  // Center block: title, credit, author, source, and any extra meta float
  // to the vertical middle of the page.
  const center = document.createElement('div');
  center.className = 'ft-center-block';

  const addTo = (container, cls, text) => {
    if (!text) return;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const d = document.createElement('div');
      d.className = cls;
      d.innerHTML = _fmt(line);
      container.appendChild(d);
    }
  };

  addTo(center, 'ft-title',  d['Title']);
  addTo(center, 'ft-credit', d['Credit']);
  addTo(center, 'ft-author', d['Author'] || d['Authors']);
  addTo(center, 'ft-credit', d['Source']);
  for (const k of ['Draft date', 'Date', 'Copyright']) {
    if (d[k]) addTo(center, 'ft-meta', `${k}: ${d[k]}`);
  }
  for (const [k, v] of Object.entries(d)) {
    const known = ['Title','Credit','Author','Authors','Source','Draft date','Date','Copyright','Contact'];
    if (!known.includes(k)) addTo(center, 'ft-meta', `${k}: ${v}`);
  }
  div.appendChild(center);

  // Contact block anchored to the bottom-left
  addTo(div, 'ft-contact', d['Contact']);

  return div;
}

function _makeEl(tagName, className, htmlContent, elem, base) {
  const node = document.createElement(tagName);
  node.className = className;
  node.innerHTML = htmlContent;
  node.dataset.docFrom = base + elem.srcFrom;
  node.dataset.docTo   = base + elem.srcTo;
  return node;
}

// ---------------------------------------------------------------------------
// Public render / renderToString
// ---------------------------------------------------------------------------

async function render(content, el) {
  el.innerHTML = '';

  if (!content.trim()) {
    el.innerHTML = '<p class="preview-empty">Enter Fountain screenplay text to see the formatted output.</p>';
    return;
  }

  _ensureStyles();

  // Detect whether we're inside a print layout (slide frame or doc page).
  // Print contexts supply their own background and padding — we only add the
  // screenplay font/layout. Standalone mode adds the "paper" presentation.
  const inPrintContext = !!el.closest?.('.uf-slide-frame, .uf-doc-page');
  const modeClass      = inPrintContext ? 'fountain-print' : 'fountain-standalone';

  // Absolute document offset so data-doc-from values are full-doc positions.
  // dslContentFrom (set by layout renderers) is the offset of the first content
  // character after the #!fountain shebang line — use it when present so that
  // per-element click-back positions are correct when fountain is embedded in a
  // slide, document page, or webpage section.
  const base = parseInt(el.dataset.dslContentFrom ?? el.dataset.docFrom ?? '0', 10);

  try {
    const elements = parseFountain(content);

    const wrap = document.createElement('div');
    wrap.className = `fountain-screenplay ${modeClass}`;

    for (const elem of elements) {
      if (elem.type === 'title-page') {
        wrap.appendChild(_makeTitlePage(elem, base));
        continue;
      }
      switch (elem.type) {
        case 'scene-heading':
          wrap.appendChild(_makeEl('div', 'fountain-scene-heading', _esc(elem.text), elem, base));
          break;
        case 'action':
          wrap.appendChild(_makeEl('div', 'fountain-action', elem.text, elem, base));
          break;
        case 'character':
          wrap.appendChild(_makeEl('div', 'fountain-character', _esc(elem.text), elem, base));
          break;
        case 'dialogue':
          wrap.appendChild(_makeEl('div', 'fountain-dialogue', elem.text, elem, base));
          break;
        case 'parenthetical':
          wrap.appendChild(_makeEl('div', 'fountain-parenthetical', _esc(elem.text), elem, base));
          break;
        case 'transition':
          wrap.appendChild(_makeEl('div', 'fountain-transition', _esc(elem.text), elem, base));
          break;
        case 'centered':
          wrap.appendChild(_makeEl('div', 'fountain-centered', _esc(elem.text), elem, base));
          break;
        case 'lyric':
          wrap.appendChild(_makeEl('div', 'fountain-lyric', `~ ${_esc(elem.text)}`, elem, base));
          break;
        case 'note':
          wrap.appendChild(_makeEl('div', 'fountain-note', `[[${_esc(elem.text)}]]`, elem, base));
          break;
        case 'synopsis':
          wrap.appendChild(_makeEl('div', 'fountain-synopsis', `= ${_esc(elem.text)}`, elem, base));
          break;
        case 'section':
          wrap.appendChild(_makeEl('div', `fountain-section-${elem.level}`, _esc(elem.text), elem, base));
          break;
        case 'page-break': {
          const hr = document.createElement('div');
          hr.className = 'fountain-page-break';
          hr.dataset.docFrom = base + elem.srcFrom;
          hr.dataset.docTo   = base + elem.srcTo;
          wrap.appendChild(hr);
          break;
        }
        case 'blank': {
          const sp = document.createElement('div');
          sp.className = 'fountain-blank';
          wrap.appendChild(sp);
          break;
        }
      }
    }

    el.appendChild(wrap);
  } catch (e) {
    el.innerHTML = `<pre class="error">Fountain error:\n${_esc(e.message)}</pre>`;
  }
}

async function renderToString(content) {
  if (!content.trim()) return '';
  // For export, build a temporary container and extract HTML
  const tmp = document.createElement('div');
  await render(content, tmp);
  return tmp.innerHTML;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const fountainDSL = {
  id:         'fountain',
  label:      'Fn',
  version:    '1.0.0',
  name:       'Fountain Screenplay',
  extensions: ['.fountain', '.spmd'],
  editorMode: 'fountain',

  render,
  renderToString,

  getEditorExtensions() { return [fountainLanguage]; },

  detect(content) {
    return (
      /^Title:/im.test(content) ||
      /^(INT\.|EXT\.|INT\.\/EXT\.|I\/E)\s/im.test(content) ||
      /^FADE IN:/m.test(content)
    );
  },
};

registerDSL(fountainDSL);
export default fountainDSL;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
