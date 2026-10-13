/**
 * Mermaid syntax intelligence — pure, Node-tested (test/mermaid-syntax.test.mjs).
 *
 * The {diagram} editor's tokenizer (highlighting), its symbol table (the node
 * ids / participants / classes already in the document, for completion) and
 * the keyword tables both share.  No DOM, no CodeMirror: `dsl/mermaid.js`
 * wraps `tokenizeLine` in a StreamLanguage and feeds `collectSymbols` to its
 * completion source.
 *
 * The tokenizer follows mermaid's own lexers where it matters:
 *   - a flowchart node id is mermaid's NODE_STRING: letters/digits/`_` and
 *     most punctuation, with `-` allowed only when NOT followed by `>`, `-` or
 *     `.` and `=` only when not followed by `>`, `=` or `.` — so `A-->B` is
 *     `A` + `-->` + `B` while `my-node` is one id (the old `[\w-]+` regex ate
 *     `A--` as a name, which is why spaceless links looked broken);
 *   - every link form: `-->` `---` `--o` `--x` `<-->` `-.->` `-..-` `==>` `===`
 *     `~~~`, with `|label|` or `-- label -->` / `== label ==>` / `-. label .->`
 *     edge text;
 *   - shape brackets (`[ ]` `( )` `{ }` `([ ])` `[[ ]]` `[( )]` `(( ))`
 *     `((( )))` `{{ }}` `[/ /]` `[\ \]` `[/ \]` `[\ /]` `> ]` `(- -)`) whose
 *     label is text — and a quoted `"…"` / markdown `"`…`"` label may span
 *     LINES, so the tokenizer carries string + label state across lines;
 *   - `@{ … }` node metadata, `:::class`, `&` chaining, `%%` comments and
 *     `%%{init: …}%%` directives.
 *
 * Token types are CodeMirror stream-parser tag names: keyword · variableName
 * (an id) · className · typeName · propertyName · string · number · operator
 * (links / relations) · punctuation · meta · comment · atom.
 */

// ---------------------------------------------------------------------------
// Diagram types
// ---------------------------------------------------------------------------

/** keyword → family (the tokenizer / completion mode). */
export const DIAGRAM_FAMILY = {
  flowchart: 'flowchart', 'flowchart-elk': 'flowchart', graph: 'flowchart', 'swimlane-beta': 'flowchart',
  sequenceDiagram: 'sequence',
  classDiagram: 'class', 'classDiagram-v2': 'class',
  stateDiagram: 'state', 'stateDiagram-v2': 'state',
  erDiagram: 'er',
  gantt: 'gantt',
  pie: 'pie',
  journey: 'journey',
  gitGraph: 'git',
  mindmap: 'mindmap',
  timeline: 'timeline',
  quadrantChart: 'quadrant',
  requirementDiagram: 'requirement', requirement: 'requirement',
  kanban: 'kanban',
  'packet-beta': 'packet', packet: 'packet',
  'architecture-beta': 'architecture',
  'xychart-beta': 'xychart', xychart: 'xychart',
  'sankey-beta': 'sankey', sankey: 'sankey',
  'radar-beta': 'radar',
  'treemap-beta': 'treemap', treemap: 'treemap',
  'block-beta': 'block', block: 'block',
  C4Context: 'c4', C4Container: 'c4', C4Component: 'c4', C4Dynamic: 'c4', C4Deployment: 'c4',
  'usecase-beta': 'generic', 'venn-beta': 'generic', 'wardley-beta': 'generic', 'railroad-beta': 'generic',
  'ishikawa-beta': 'generic', 'treeView-beta': 'generic', 'cynefin-beta': 'generic', zenuml: 'generic',
};

/** Every diagram keyword, longest first (so `flowchart-elk` wins over `flowchart`). */
export const DIAGRAM_KEYWORDS = Object.keys(DIAGRAM_FAMILY).sort((a, b) => b.length - a.length);

const DIAGRAM_RE = new RegExp('^(' + DIAGRAM_KEYWORDS.map(escapeRe).join('|') + ')(?![\\w-])');

/** Flow directions (`flowchart LR`, `direction TB`). */
export const DIRECTIONS = ['TB', 'TD', 'BT', 'RL', 'LR'];

/**
 * Keywords per family.  `start` = statement keywords (the first word of a
 * line); `inline` = keywords that follow something else on the line.
 */
export const KEYWORDS = {
  flowchart: {
    start: ['subgraph', 'end', 'direction', 'classDef', 'class', 'style', 'linkStyle', 'click'],
    inline: ['direction', 'href', 'call', 'callback', 'default', 'interpolate', '_blank', '_self', '_parent', '_top'],
  },
  sequence: {
    start: ['participant', 'actor', 'activate', 'deactivate', 'Note', 'note', 'loop', 'alt', 'else', 'opt', 'par', 'and',
            'critical', 'option', 'break', 'rect', 'end', 'autonumber', 'box', 'title', 'create', 'destroy', 'links',
            'link', 'properties', 'accTitle', 'accDescr'],
    inline: ['as', 'participant', 'actor', 'left of', 'right of', 'over', 'off', 'transparent'],
  },
  class: {
    start: ['class', 'namespace', 'note', 'direction', 'classDef', 'style', 'cssClass', 'callback', 'link', 'click',
            'accTitle', 'accDescr'],
    inline: ['for', 'href', 'call', '_blank', '_self', '_parent', '_top'],
  },
  state: {
    start: ['state', 'note', 'end', 'direction', 'classDef', 'class', 'style', 'hide', 'accTitle', 'accDescr'],
    inline: ['as', 'left of', 'right of', 'note', 'empty', 'description'],
  },
  er: {
    start: ['direction', 'style', 'classDef', 'class', 'accTitle', 'accDescr'],
    inline: ['to', 'one', 'zero', 'many', 'only', 'or', 'more', 'optionally', 'PK', 'FK', 'UK'],
  },
  gantt: {
    start: ['title', 'dateFormat', 'axisFormat', 'tickInterval', 'excludes', 'includes', 'todayMarker', 'section',
            'weekday', 'weekend', 'inclusiveEndDates', 'topAxis', 'displayMode', 'click', 'accTitle', 'accDescr'],
    inline: ['done', 'active', 'crit', 'milestone', 'vert', 'after', 'until', 'href', 'call', 'off', 'weekends',
             'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'compact'],
  },
  pie: { start: ['title', 'showData', 'accTitle', 'accDescr'], inline: [] },
  journey: { start: ['title', 'section', 'accTitle', 'accDescr'], inline: [] },
  git: {
    start: ['commit', 'branch', 'checkout', 'switch', 'merge', 'cherry-pick', 'accTitle', 'accDescr'],
    inline: ['id', 'tag', 'type', 'order', 'parent', 'NORMAL', 'REVERSE', 'HIGHLIGHT'],
  },
  mindmap: { start: [], inline: ['icon'] },
  timeline: { start: ['title', 'section', 'accTitle', 'accDescr'], inline: [] },
  quadrant: {
    start: ['title', 'x-axis', 'y-axis', 'quadrant-1', 'quadrant-2', 'quadrant-3', 'quadrant-4', 'classDef',
            'accTitle', 'accDescr'],
    inline: ['-->'],
  },
  requirement: {
    start: ['requirement', 'functionalRequirement', 'interfaceRequirement', 'performanceRequirement',
            'physicalRequirement', 'designConstraint', 'element', 'direction', 'style', 'classDef', 'class',
            'accTitle', 'accDescr'],
    inline: ['id', 'text', 'risk', 'verifymethod', 'type', 'docref', 'Low', 'Medium', 'High', 'Analysis',
             'Inspection', 'Test', 'Demonstration', 'contains', 'copies', 'derives', 'satisfies', 'verifies',
             'refines', 'traces'],
  },
  kanban: { start: [], inline: ['assigned', 'ticket', 'priority', 'icon', 'Very High', 'High', 'Low', 'Very Low'] },
  packet: { start: ['title', 'accTitle', 'accDescr'], inline: [] },
  architecture: { start: ['group', 'service', 'junction', 'accTitle', 'accDescr'], inline: ['in'] },
  xychart: { start: ['title', 'x-axis', 'y-axis', 'bar', 'line', 'accTitle', 'accDescr'], inline: [] },
  sankey: { start: [], inline: [] },
  radar: {
    start: ['title', 'axis', 'curve', 'showLegend', 'max', 'min', 'graticule', 'ticks', 'accTitle', 'accDescr'],
    inline: ['circle', 'polygon', 'true', 'false'],
  },
  treemap: { start: [], inline: [] },
  block: {
    start: ['columns', 'space', 'block', 'end', 'classDef', 'class', 'style', 'accTitle', 'accDescr'],
    inline: ['right', 'left', 'up', 'down', 'x', 'y'],
  },
  c4: {
    start: ['title', 'Person', 'Person_Ext', 'System', 'System_Ext', 'SystemDb', 'SystemQueue', 'SystemDb_Ext',
            'SystemQueue_Ext', 'Container', 'ContainerDb', 'ContainerQueue', 'Container_Ext', 'ContainerDb_Ext',
            'ContainerQueue_Ext', 'Component', 'ComponentDb', 'ComponentQueue', 'Component_Ext', 'ComponentDb_Ext',
            'ComponentQueue_Ext', 'Boundary', 'Enterprise_Boundary', 'System_Boundary', 'Container_Boundary', 'Node',
            'Node_L', 'Node_R', 'Deployment_Node', 'Rel', 'BiRel', 'Rel_U', 'Rel_D', 'Rel_L', 'Rel_R', 'Rel_Up',
            'Rel_Down', 'Rel_Left', 'Rel_Right', 'Rel_Back', 'RelIndex', 'UpdateElementStyle', 'UpdateRelStyle',
            'UpdateLayoutConfig', 'UpdateBoundaryStyle', 'accTitle', 'accDescr'],
    inline: [],
  },
  generic: { start: ['title', 'accTitle', 'accDescr'], inline: [] },
};

/** Flowchart link forms offered by completion (and their meaning). */
export const FLOW_LINKS = [
  ['-->', 'arrow'], ['---', 'open link'], ['-.->', 'dotted arrow'], ['-.-', 'dotted link'],
  ['==>', 'thick arrow'], ['===', 'thick link'], ['~~~', 'invisible link'],
  ['--o', 'circle edge'], ['--x', 'cross edge'], ['<-->', 'two-way arrow'], ['o--o', 'two-way circle'], ['x--x', 'two-way cross'],
  ['-->|text|', 'arrow with a label'], ['-- text -->', 'arrow with a label'],
];

/** Sequence message arrows offered by completion. */
export const SEQUENCE_ARROWS = [
  ['->>', 'solid arrow'], ['-->>', 'dotted arrow'], ['->', 'solid line'], ['-->', 'dotted line'],
  ['-x', 'solid cross'], ['--x', 'dotted cross'], ['-)', 'solid async'], ['--)', 'dotted async'],
  ['<<->>', 'bidirectional'], ['<<-->>', 'dotted bidirectional'],
];

/** Class relations offered by completion. */
export const CLASS_RELATIONS = [
  ['<|--', 'inheritance'], ['--|>', 'inheritance'], ['*--', 'composition'], ['--*', 'composition'],
  ['o--', 'aggregation'], ['--o', 'aggregation'], ['-->', 'association'], ['<--', 'association'],
  ['--', 'link'], ['..>', 'dependency'], ['<..', 'dependency'], ['..|>', 'realization'], ['<|..', 'realization'], ['..', 'dashed link'],
];

/** ER relations (crow's foot) offered by completion. */
export const ER_RELATIONS = [
  ['||--||', 'one to one'], ['||--o{', 'one to zero or more'], ['||--|{', 'one to one or more'],
  ['|o--o|', 'zero or one to zero or one'], ['}o--o{', 'many to many'], ['}|--|{', 'one or more to one or more'],
  ['||..o{', 'one to many (non-identifying)'], ['}|..|{', 'many to many (non-identifying)'],
];

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

// mermaid's NODE_STRING (flow lexer): letters, digits and most punctuation;
// `-` only when not followed by `>`/`-`/`.`, `=` only when not followed by
// `>`/`=`/`.` — the two lookaheads are what make `A-->B` three tokens.
const FLOW_ID_RE = /^(?:[\p{L}\p{N}_!$%'+.`?\\/]|-(?![>\-.])|=(?![>=.]))+/u;

// Flowchart links.  Order matters: labelled openers before plain links.
//   plain:   `[xo<]?--+[-xo>]`   `[xo<]?==+[=xo>]`   `[xo<]?-?\.+-[xo>]?`   `~~~+`
//   opener:  `[xo<]?--`  (then text until `--+[-xo>]`), `==`, `-.`
const FLOW_LINK_RE   = /^(?:[xo<]?--+[-xo>]|[xo<]?==+[=xo>]|[xo<]?-?\.+-[xo>]?|~~~+)/;
const FLOW_OPEN_RE   = /^(?:[xo<]?--|[xo<]?==|[xo<]?-\.)/;
const FLOW_CLOSE_RE  = { '-': /--+[-xo>]/, '=': /==+[=xo>]/, '.': /\.+-[xo>]?/ };

// Shape openers → their closer.  Longest first.
const FLOW_SHAPES = [
  ['(((', ')))'], ['((', '))'], ['([', '])'], ['[[', ']]'], ['[(', ')]'], ['[/', '/]'], ['[\\', '\\]'],
  ['{{', '}}'], ['(-', '-)'], ['[|', ']'], ['>', ']'], ['(', ')'], ['[', ']'], ['{', '}'],
];
// Every closer a label may end with (the `[/ \]` / `[\ /]` trapezoids mix).
const FLOW_CLOSERS = [')))', '))', '])', ']]', ')]', '/]', '\\]', '}}', '-)', ']', ')', '}'];

const SEQ_ARROW_RE = /^(?:<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->)/;
const CLASS_REL_RE = /^(?:<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|--|\.\.)/;
const ER_REL_RE    = /^(?:[|}o][|o{]?(?:--|\.\.)[|{o][|o{]?)/;

const WORD_RE = /^[\p{L}_][\p{L}\p{N}_-]*/u;
const NUMBER_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?![\p{L}_])/u;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Tokenizer state (carried across lines).
 *   family    the diagram family once the header line was seen (null before)
 *   fm        inside a leading `---` front matter block
 *   string    inside a string: '"' | 'md' (a `"`…`"` markdown string) | "'"
 *   label     inside a shape label: the closer text ('`]`', '`))`', …)
 *   attrs     inside an `@{ … }` metadata block
 *   edge      inside `-- text -->` edge text: '-' | '=' | '.'
 *   directive inside a `%%{ … }%%` directive
 *   block     inside a `{ … }` body (class / er / state / requirement) — depth
 */
export function createState() {
  return { family: null, fm: false, string: null, label: null, attrs: false, edge: null, directive: false, block: 0, line: 0 };
}

export function copyState(s) {
  return { family: s.family, fm: s.fm, string: s.string, label: s.label, attrs: s.attrs, edge: s.edge,
           directive: s.directive, block: s.block, line: s.line };
}

/** The family of a diagram keyword (null when it is not one). */
export function familyOf(keyword) { return DIAGRAM_FAMILY[keyword] ?? null; }

/**
 * The diagram keyword of a body: the first non-blank, non-comment line past a
 * leading `---` block / `%%{…}%%` directives.  `{ keyword, family, line }`
 * (line = 0-based index) or null.
 */
export function diagramTypeOf(text) {
  const lines = text.split('\n');
  let fm = false, directive = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (i === 0 && t === '---') { fm = true; continue; }
    if (fm) { if (t === '---') fm = false; continue; }
    if (directive) { if (t.includes('}%%')) directive = false; continue; }
    if (!t) continue;
    if (t.startsWith('%%{')) { if (!t.includes('}%%')) directive = true; continue; }
    if (t.startsWith('%%')) continue;
    const m = DIAGRAM_RE.exec(t);
    return m ? { keyword: m[1], family: DIAGRAM_FAMILY[m[1]], line: i } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize ONE line.  Returns `[{ from, to, type }]` (line-relative offsets,
 * only the typed spans — gaps are plain text) and advances `state`.
 */
export function tokenizeLine(text, state) {
  const out = [];
  const emit = (from, to, type) => { if (to > from && type) out.push({ from, to, type }); };
  let pos = 0;
  const lineNo = state.line++;

  // ── Cross-line constructs first ──────────────────────────────────────────
  if (state.fm) {
    if (/^---\s*$/.test(text)) { state.fm = false; emit(0, text.length, 'meta'); return out; }
    const m = /^(\s*)([^:\s][^:]*)(:)/.exec(text);
    if (m) { emit(m[1].length, m[1].length + m[2].length, 'propertyName'); emit(m[1].length + m[2].length, m[0].length, 'punctuation'); }
    const c = /(^|\s)(#.*)$/.exec(text);
    if (c) emit(c.index + c[1].length, text.length, 'comment');
    return out;
  }
  if (lineNo === 0 && /^---\s*$/.test(text)) { state.fm = true; emit(0, text.length, 'meta'); return out; }

  if (state.directive) {
    const i = text.indexOf('}%%');
    if (i < 0) { emit(0, text.length, 'meta'); return out; }
    emit(0, i + 3, 'meta'); state.directive = false; pos = i + 3;
  }

  while (pos < text.length) {
    // Inside a string (may have started on an earlier line).
    if (state.string) { pos = _string(text, pos, state, emit); continue; }
    // Inside a shape label — text until the closer (quotes inside are strings).
    if (state.label) { pos = _flowLabel(text, pos, state, emit); continue; }
    // Inside `@{ … }` metadata.
    if (state.attrs) { pos = _attrs(text, pos, state, emit); continue; }
    // Inside `-- text -->` edge text.
    if (state.edge) { pos = _edgeText(text, pos, state, emit); continue; }

    const ch = text[pos];
    if (ch === ' ' || ch === '\t' || ch === '\r') { pos++; continue; }
    const rest = text.slice(pos);

    // `%%{init: …}%%` directive, `%% comment`
    if (rest.startsWith('%%{')) {
      const end = rest.indexOf('}%%');
      if (end < 0) { emit(pos, text.length, 'meta'); state.directive = true; return out; }
      emit(pos, pos + end + 3, 'meta'); pos += end + 3; continue;
    }
    if (rest.startsWith('%%')) { emit(pos, text.length, 'comment'); return out; }

    // Header line: the diagram keyword (+ direction).
    if (!state.family) {
      const m = DIAGRAM_RE.exec(rest);
      if (m) {
        state.family = DIAGRAM_FAMILY[m[1]];
        emit(pos, pos + m[1].length, 'keyword');
        pos += m[1].length;
        if (state.family === 'flowchart') {
          const d = /^\s*(TB|TD|BT|RL|LR|BR|<|>|\^|v\b)/.exec(text.slice(pos));
          if (d) { emit(pos + d[0].length - d[1].length, pos + d[0].length, 'atom'); pos += d[0].length; }
        } else if (state.family === 'git') {
          const d = /^\s*(TB|BT|LR):?/.exec(text.slice(pos));
          if (d) { emit(pos + d[0].length - d[1].length - (d[0].endsWith(':') ? 1 : 0), pos + d[0].length, 'atom'); pos += d[0].length; }
        }
        continue;
      }
      // Not a diagram keyword: plain text until a header shows up.
      pos = _generic(text, pos, state, emit, 'generic', out.length === 0);
      continue;
    }

    const atStart = out.length === 0 || out.every(t => t.type === 'comment' || t.type === 'meta');
    const prev = out.length ? out[out.length - 1].type : null;
    switch (state.family) {
      case 'flowchart': pos = _flowchart(text, pos, state, emit, atStart, prev); break;
      case 'sequence':  pos = _sequence(text, pos, state, emit, atStart); break;
      case 'class':     pos = _classDiagram(text, pos, state, emit, atStart); break;
      case 'state':     pos = _stateDiagram(text, pos, state, emit, atStart); break;
      case 'er':        pos = _erDiagram(text, pos, state, emit, atStart); break;
      case 'gantt':     pos = _gantt(text, pos, state, emit, atStart); break;
      default:          pos = _generic(text, pos, state, emit, state.family, atStart); break;
    }
  }
  return out;
}

// ── Shared pieces ─────────────────────────────────────────────────────────

/** Continue / finish a string that is open in `state.string`. */
function _string(text, pos, state, emit) {
  const kind = state.string;
  let end = -1, closerLen = 1;
  if (kind === 'md') { end = text.indexOf('`"', pos); closerLen = 2; }
  else end = text.indexOf(kind, pos);
  if (end < 0) { emit(pos, text.length, 'string'); return text.length; }
  emit(pos, end + closerLen, 'string');
  state.string = null;
  return end + closerLen;
}

/**
 * Open a string at `pos` (text[pos] is `"` or, when `allowSingle`, `'`) and
 * emit what is on this line of it as ONE span; the string stays open in
 * `state.string` when it runs past the line.  Returns the new pos.
 */
function _openString(text, pos, state, emit, allowSingle = true) {
  const ch = text[pos];
  if (ch !== '"' && !(ch === "'" && allowSingle)) return pos + 1;
  state.string = ch === "'" ? "'" : text[pos + 1] === '`' ? 'md' : '"';
  const start = pos;
  const next = _string(text, pos + (state.string === 'md' ? 2 : 1), state, () => {});
  emit(start, next, 'string');
  return next;
}

/** `@{ key: value, … }` — keys are properties, values strings/atoms. May span lines. */
function _attrs(text, pos, state, emit) {
  while (pos < text.length) {
    if (state.string) { pos = _string(text, pos, state, emit); continue; }
    const ch = text[pos];
    if (ch === '}') { emit(pos, pos + 1, 'punctuation'); state.attrs = false; return pos + 1; }
    if (ch === '"' || ch === "'") { pos = _openString(text, pos, state, emit); continue; }
    if (ch === ',' || ch === ':') { emit(pos, pos + 1, 'punctuation'); pos++; continue; }
    const key = /^\s*([\p{L}_][\p{L}\p{N}_-]*)(?=\s*:)/u.exec(text.slice(pos));
    if (key) { emit(pos + key[0].length - key[1].length, pos + key[0].length, 'propertyName'); pos += key[0].length; continue; }
    const val = /^[^,}"'\s][^,}"']*/.exec(text.slice(pos));
    if (val) { emit(pos, pos + val[0].trimEnd().length, 'atom'); pos += val[0].length; continue; }
    pos++;
  }
  return pos;
}

/** Keyword at a statement start / inline keyword. */
function _keywordAt(rest, list) {
  for (const k of list) {
    if (rest.startsWith(k) && !/[\p{L}\p{N}_-]/u.test(rest[k.length] ?? '')) return k;
  }
  return null;
}

// ── Flowchart ──────────────────────────────────────────────────────────────

function _flowchart(text, pos, state, emit, atStart, prevTok) {
  const rest = text.slice(pos);

  // Statement keywords (only as the first word of a line) + their arguments.
  if (atStart) {
    const kw = _keywordAt(rest, KEYWORDS.flowchart.start);
    if (kw) {
      emit(pos, pos + kw.length, 'keyword');
      pos += kw.length;
      if (kw === 'direction') {
        const d = /^\s*(TB|TD|BT|RL|LR)\b/.exec(text.slice(pos));
        if (d) { emit(pos + d[0].length - d[1].length, pos + d[0].length, 'atom'); pos += d[0].length; }
        return pos;
      }
      if (kw === 'subgraph') {
        // `subgraph id [title]` (the label follows as a shape) or `subgraph title words`
        const m = /^\s*([^\s[\]]+)/.exec(text.slice(pos));
        if (m) { emit(pos + m[0].length - m[1].length, pos + m[0].length, 'variableName'); pos += m[0].length; }
        const after = text.slice(pos);
        if (after.trim() && !after.trimStart().startsWith('[')) { emit(pos + after.length - after.trimStart().length, text.length, 'string'); return text.length; }
        return pos;
      }
      if (kw === 'classDef') {
        const m = /^\s*([\p{L}\p{N}_,-]+)/u.exec(text.slice(pos));
        if (m) { emit(pos + m[0].length - m[1].length, pos + m[0].length, 'className'); pos += m[0].length; }
        return _styleProps(text, pos, emit);
      }
      if (kw === 'class') {
        const m = /^\s*([^\s]+)\s+([\p{L}\p{N}_,-]+)/u.exec(text.slice(pos));
        if (m) {
          const a = pos + m[0].indexOf(m[1]);
          emit(a, a + m[1].length, 'variableName');
          const b = pos + m[0].length - m[2].length;
          emit(b, b + m[2].length, 'className');
          return pos + m[0].length;
        }
        return pos;
      }
      if (kw === 'style') {
        const m = /^\s*([^\s]+)/.exec(text.slice(pos));
        if (m) { emit(pos + m[0].length - m[1].length, pos + m[0].length, 'variableName'); pos += m[0].length; }
        return _styleProps(text, pos, emit);
      }
      if (kw === 'linkStyle') {
        const m = /^\s*([\d,\s]+|default)/.exec(text.slice(pos));
        if (m) { emit(pos + m[0].length - m[1].length, pos + m[0].length, 'number'); pos += m[0].length; }
        return _styleProps(text, pos, emit);
      }
      if (kw === 'click') {
        const m = /^\s*([^\s]+)/.exec(text.slice(pos));
        if (m) { emit(pos + m[0].length - m[1].length, pos + m[0].length, 'variableName'); pos += m[0].length; }
        return pos;
      }
      return pos;
    }
  }
  // Inline keywords (`href`, `call`, `_blank` …)
  const ikw = _keywordAt(rest, KEYWORDS.flowchart.inline);
  if (ikw && (pos === 0 || /\s/.test(text[pos - 1]))) { emit(pos, pos + ikw.length, 'keyword'); return pos + ikw.length; }

  // Links — before ids (an id cannot start with `-` / `=` / `.` / `~` / `<`).
  let m = FLOW_LINK_RE.exec(rest);
  if (m) {
    emit(pos, pos + m[0].length, 'operator');
    pos += m[0].length;
    // `|edge label|`
    const lbl = /^\s*\|/.exec(text.slice(pos));
    if (lbl) {
      const open = pos + lbl[0].length - 1;
      const close = text.indexOf('|', open + 1);
      emit(open, open + 1, 'punctuation');
      if (close < 0) { emit(open + 1, text.length, 'string'); return text.length; }
      emit(open + 1, close, 'string'); emit(close, close + 1, 'punctuation');
      return close + 1;
    }
    return pos;
  }
  m = FLOW_OPEN_RE.exec(rest);
  if (m) {
    emit(pos, pos + m[0].length, 'operator');
    state.edge = m[0].endsWith('.') ? '.' : m[0][m[0].length - 1];
    return pos + m[0].length;
  }

  // Shape openers (a label follows) — only right after an id (`A[`) or at a
  // statement start; `>` is also the asymmetric opener.
  for (const [open, close] of FLOW_SHAPES) {
    if (rest.startsWith(open) && (open !== '>' || prevTok === 'variableName')) {
      emit(pos, pos + open.length, 'punctuation');
      state.label = close;
      return pos + open.length;
    }
  }

  if (rest.startsWith('@{')) { emit(pos, pos + 2, 'punctuation'); state.attrs = true; return pos + 2; }
  if (rest.startsWith(':::')) {
    const c = /^:::([\p{L}\p{N}_,-]+)/u.exec(rest);
    emit(pos, pos + 3, 'punctuation');
    if (c) { emit(pos + 3, pos + c[0].length, 'className'); return pos + c[0].length; }
    return pos + 3;
  }
  if (rest[0] === '&' || rest[0] === ';') { emit(pos, pos + 1, 'punctuation'); return pos + 1; }
  if (rest[0] === '"') return _openString(text, pos, state, emit, false);

  m = FLOW_ID_RE.exec(rest);
  if (m) { emit(pos, pos + m[0].length, 'variableName'); return pos + m[0].length; }
  return pos + 1;
}

/** `fill:#f9f,stroke:#333,stroke-width:4px` → property / punctuation / value. */
function _styleProps(text, pos, emit) {
  const re = /([\p{L}\p{N}_-]+)(\s*:\s*)([^,]*)|(,)/guy;
  const lead = /\s*/y; lead.lastIndex = pos; lead.exec(text);
  re.lastIndex = lead.lastIndex;
  let m;
  while ((m = re.exec(text))) {
    if (m[4]) { emit(m.index, m.index + 1, 'punctuation'); }
    else {
      emit(m.index, m.index + m[1].length, 'propertyName');
      const v = m.index + m[1].length + m[2].length;
      emit(v, v + m[3].trimEnd().length, 'atom');
    }
    // skip whitespace between entries
    const ws = /\s*/y; ws.lastIndex = re.lastIndex; ws.exec(text); re.lastIndex = ws.lastIndex;
  }
  return text.length;
}

/** Text inside a shape label until its closer; quotes inside are strings. */
function _flowLabel(text, pos, state, emit) {
  const close = state.label;
  while (pos < text.length) {
    if (state.string) { pos = _string(text, pos, state, emit); continue; }
    const rest = text.slice(pos);
    // The matching closer, or any closer of the same bracket family (`[/ \]`).
    const hit = rest.startsWith(close) ? close
      : FLOW_CLOSERS.find(c => rest.startsWith(c) && c[c.length - 1] === close[close.length - 1]);
    if (hit) { emit(pos, pos + hit.length, 'punctuation'); state.label = null; return pos + hit.length; }
    if (rest[0] === '"') { pos = _openString(text, pos, state, emit, false); continue; }
    // A run of label text (stop before a quote or a possible closer char)
    const t = /^[^"\])}\\/-]+|^[\]\\/)}-]/.exec(rest);
    emit(pos, pos + t[0].length, 'string');
    pos += t[0].length;
  }
  return pos;
}

/** `-- text -->` edge text until the closing arrow. */
function _edgeText(text, pos, state, emit) {
  const re = FLOW_CLOSE_RE[state.edge];
  const m = re.exec(text.slice(pos));
  if (!m) { emit(pos, text.length, 'string'); return text.length; }
  emit(pos, pos + m.index, 'string');
  emit(pos + m.index, pos + m.index + m[0].length, 'operator');
  state.edge = null;
  return pos + m.index + m[0].length;
}

// ── Sequence ───────────────────────────────────────────────────────────────

function _sequence(text, pos, state, emit, atStart) {
  const rest = text.slice(pos);
  if (atStart) {
    const kw = _keywordAt(rest, KEYWORDS.sequence.start);
    if (kw) {
      emit(pos, pos + kw.length, 'keyword');
      pos += kw.length;
      const after = text.slice(pos);
      switch (kw) {
        case 'participant': case 'actor': case 'create': case 'destroy': case 'activate': case 'deactivate': {
          // `participant A as Alice` / `create participant A`
          const inner = _keywordAt(after.trimStart(), ['participant', 'actor']);
          if (inner) { const s = pos + after.length - after.trimStart().length; emit(s, s + inner.length, 'keyword'); pos = s + inner.length; }
          const m = /^\s*([^\n:]+?)(?=\s+as\s|\s*$|:)/.exec(text.slice(pos));
          if (m) {
            emit(pos + m[0].length - m[1].length, pos + m[0].length, 'variableName'); pos += m[0].length;
            const as = /^\s+as\s+/.exec(text.slice(pos));
            if (as) { emit(pos + as[0].length - as[0].trimStart().length, pos + as[0].length - (as[0].length - as[0].trimEnd().length), 'keyword'); pos += as[0].length; emit(pos, text.length, 'string'); return text.length; }
          }
          return pos;
        }
        case 'Note': case 'note': {
          const side = /^\s*(left of|right of|over)\s*/.exec(after);
          if (side) {
            emit(pos + side[0].length - side[0].trimStart().length, pos + side[0].length - side[0].trimStart().length + side[1].length, 'keyword');
            pos += side[0].length;
          }
          const colon = text.indexOf(':', pos);
          const end = colon < 0 ? text.length : colon;
          for (const p of text.slice(pos, end).split(',')) {
            const s = pos + text.slice(pos, end).indexOf(p);
            const lead = p.length - p.trimStart().length;
            emit(s + lead, s + lead + p.trim().length, 'variableName');
          }
          if (colon >= 0) { emit(colon, colon + 1, 'punctuation'); emit(colon + 1, text.length, 'string'); }
          return text.length;
        }
        case 'loop': case 'alt': case 'else': case 'opt': case 'par': case 'and': case 'critical': case 'option':
        case 'break': case 'rect': case 'box': case 'title': case 'accTitle': case 'accDescr':
          emit(pos, text.length, 'string');
          return text.length;
        default: return pos;
      }
    }
  }
  // Message: `A->>+B: text`
  const arrow = SEQ_ARROW_RE.exec(rest);
  if (arrow) {
    emit(pos, pos + arrow[0].length, 'operator'); pos += arrow[0].length;
    const act = /^[+-]/.exec(text.slice(pos));
    if (act) { emit(pos, pos + 1, 'punctuation'); pos++; }
    const target = /^\s*([^:\n]+?)\s*(?=:|$)/.exec(text.slice(pos));
    if (target) { emit(pos + target[0].indexOf(target[1]), pos + target[0].indexOf(target[1]) + target[1].length, 'variableName'); pos += target[0].length; }
    return pos;
  }
  if (rest[0] === ':') { emit(pos, pos + 1, 'punctuation'); emit(pos + 1, text.length, 'string'); return text.length; }
  // A participant name before an arrow (up to the arrow)
  const m = /^[^:\n]*?(?=\s*(?:<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->)|$)/.exec(rest);
  if (m && m[0].trim()) {
    const lead = m[0].length - m[0].trimStart().length;
    emit(pos + lead, pos + m[0].trimEnd().length, 'variableName');
    return pos + m[0].length;
  }
  return pos + 1;
}

// ── Class diagram ──────────────────────────────────────────────────────────

function _classDiagram(text, pos, state, emit, atStart) {
  const rest = text.slice(pos);
  if (rest[0] === '{') { emit(pos, pos + 1, 'punctuation'); state.block++; return pos + 1; }
  if (rest[0] === '}') { emit(pos, pos + 1, 'punctuation'); state.block = Math.max(0, state.block - 1); return pos + 1; }
  if (rest[0] === '"') return _openString(text, pos, state, emit, false);
  // `<<interface>>`
  const ann = /^<<[^>]*>>/.exec(rest);
  if (ann) { emit(pos, pos + ann[0].length, 'meta'); return pos + ann[0].length; }

  if (atStart) {
    const kw = _keywordAt(rest, KEYWORDS.class.start);
    if (kw && !(state.block && kw !== 'class')) {
      emit(pos, pos + kw.length, 'keyword'); pos += kw.length;
      if (kw === 'direction') { const d = /^\s*(TB|TD|BT|RL|LR)\b/.exec(text.slice(pos)); if (d) { emit(pos + d[0].length - d[1].length, pos + d[0].length, 'atom'); pos += d[0].length; } return pos; }
      if (kw === 'class' || kw === 'namespace' || kw === 'cssClass' || kw === 'style') {
        const m = /^\s*([\p{L}\p{N}_~<>,-]+)/u.exec(text.slice(pos));
        if (m) { emit(pos + m[0].length - m[1].length, pos + m[0].length, 'className'); pos += m[0].length; }
        if (kw === 'style') return _styleProps(text, pos, emit);
        return pos;
      }
      if (kw === 'classDef') {
        const m = /^\s*([\p{L}\p{N}_,-]+)/u.exec(text.slice(pos));
        if (m) { emit(pos + m[0].length - m[1].length, pos + m[0].length, 'className'); pos += m[0].length; }
        return _styleProps(text, pos, emit);
      }
      if (kw === 'note') {
        const m = /^\s*for\s+([\p{L}\p{N}_-]+)/u.exec(text.slice(pos));
        if (m) { const f = pos + m[0].indexOf('for'); emit(f, f + 3, 'keyword'); emit(pos + m[0].length - m[1].length, pos + m[0].length, 'className'); pos += m[0].length; }
        return pos;
      }
      return pos;
    }
    // Inside a class body: a member line — `+int id`, `+method(x) List~int~`,
    // `-abstract()*`, `+static()$`.
    if (state.block) return _classMember(text, pos, emit);
  }
  if (rest.startsWith(':::')) {
    emit(pos, pos + 3, 'punctuation');
    const c = /^[\p{L}\p{N}_,-]+/u.exec(text.slice(pos + 3));
    if (c) emit(pos + 3, pos + 3 + c[0].length, 'className');
    return pos + 3 + (c?.[0].length ?? 0);
  }
  const relm = CLASS_REL_RE.exec(rest);
  if (relm) { emit(pos, pos + relm[0].length, 'operator'); return pos + relm[0].length; }
  if (rest[0] === ':') {
    // `Class : +member` (member) or `A --> B : label`
    emit(pos, pos + 1, 'punctuation'); pos++;
    const after = text.slice(pos);
    const vis = /^\s*[+\-#~]/.exec(after);
    if (vis) { emit(pos + vis[0].length - 1, pos + vis[0].length, 'punctuation'); emit(pos + vis[0].length, text.length, 'propertyName'); }
    else emit(pos + (after.length - after.trimStart().length), text.length, 'string');
    return text.length;
  }
  const ikw = _keywordAt(rest, KEYWORDS.class.inline);
  if (ikw && (pos === 0 || /\s/.test(text[pos - 1]))) { emit(pos, pos + ikw.length, 'keyword'); return pos + ikw.length; }
  const m = /^[\p{L}_][\p{L}\p{N}_~<>]*/u.exec(rest);
  if (m) { emit(pos, pos + m[0].length, 'className'); return pos + m[0].length; }
  return pos + 1;
}

/** A class-body member line: visibility, name(args) return-type / type name. */
function _classMember(text, pos, emit) {
  if (/^[+\-#~]/.test(text[pos])) { emit(pos, pos + 1, 'punctuation'); pos++; }
  const rest = text.slice(pos);
  const lead = rest.length - rest.trimStart().length;
  const meth = /^\s*([\p{L}_][\p{L}\p{N}_~<>]*)\s*\(([^)]*)\)\s*([*$]*)\s*([\p{L}_][\p{L}\p{N}_~<>]*)?/u.exec(rest);
  if (meth) {
    const s = pos + lead;
    emit(s, s + meth[1].length, 'propertyName');
    const open = pos + rest.indexOf('(');
    emit(open, open + 1, 'punctuation');
    emit(open + 1, open + 1 + meth[2].length, 'string');
    emit(open + 1 + meth[2].length, open + 2 + meth[2].length, 'punctuation');
    if (meth[4]) { const r = pos + meth[0].length - meth[4].length; emit(r, r + meth[4].length, 'typeName'); }
    return pos + meth[0].length;
  }
  const attr = /^\s*([\p{L}_][\p{L}\p{N}_~<>]*)(?:\s+([\p{L}_][\p{L}\p{N}_]*))?/u.exec(rest);
  if (attr) {
    const s = pos + lead;
    if (attr[2]) {
      emit(s, s + attr[1].length, 'typeName');
      const n = pos + attr[0].length - attr[2].length;
      emit(n, n + attr[2].length, 'propertyName');
    } else emit(s, s + attr[1].length, 'propertyName');
    return pos + attr[0].length;
  }
  return pos + 1;
}

// ── State diagram ──────────────────────────────────────────────────────────

function _stateDiagram(text, pos, state, emit, atStart) {
  const rest = text.slice(pos);
  if (rest.startsWith('[*]')) { emit(pos, pos + 3, 'atom'); return pos + 3; }
  if (rest.startsWith('-->')) { emit(pos, pos + 3, 'operator'); return pos + 3; }
  if (rest.startsWith('--') && atStart) { emit(pos, pos + 2, 'punctuation'); return pos + 2; }
  if (rest[0] === '{') { emit(pos, pos + 1, 'punctuation'); state.block++; return pos + 1; }
  if (rest[0] === '}') { emit(pos, pos + 1, 'punctuation'); state.block = Math.max(0, state.block - 1); return pos + 1; }
  if (rest[0] === '"') return _openString(text, pos, state, emit, false);
  const ann = /^<<[^>]*>>/.exec(rest);
  if (ann) { emit(pos, pos + ann[0].length, 'meta'); return pos + ann[0].length; }
  if (rest[0] === ':') { emit(pos, pos + 1, 'punctuation'); emit(pos + 1, text.length, 'string'); return text.length; }
  if (rest.startsWith(':::')) { emit(pos, pos + 3, 'punctuation'); const c = /^[\p{L}\p{N}_,-]+/u.exec(text.slice(pos + 3)); if (c) emit(pos + 3, pos + 3 + c[0].length, 'className'); return pos + 3 + (c?.[0].length ?? 0); }
  if (atStart) {
    const kw = _keywordAt(rest, KEYWORDS.state.start);
    if (kw) {
      emit(pos, pos + kw.length, 'keyword'); pos += kw.length;
      if (kw === 'direction') { const d = /^\s*(TB|TD|BT|RL|LR)\b/.exec(text.slice(pos)); if (d) { emit(pos + d[0].length - d[1].length, pos + d[0].length, 'atom'); pos += d[0].length; } return pos; }
      if (kw === 'note') {
        const side = /^\s*(left of|right of)\s+([^\s:]+)/.exec(text.slice(pos));
        if (side) {
          const s = pos + side[0].length - side[0].trimStart().length;
          emit(s, s + side[1].length, 'keyword');
          emit(pos + side[0].length - side[2].length, pos + side[0].length, 'variableName');
          pos += side[0].length;
        }
        const colon = text.indexOf(':', pos);
        if (colon >= 0) { emit(colon, colon + 1, 'punctuation'); emit(colon + 1, text.length, 'string'); }
        return text.length;
      }
      if (kw === 'end') { const n = /^\s*note\b/.exec(text.slice(pos)); if (n) { emit(pos + n[0].length - 4, pos + n[0].length, 'keyword'); pos += n[0].length; } return pos; }
      if (kw === 'hide') { emit(pos, text.length, 'keyword'); return text.length; }
      if (kw === 'classDef') { const m = /^\s*([\p{L}\p{N}_,-]+)/u.exec(text.slice(pos)); if (m) { emit(pos + m[0].length - m[1].length, pos + m[0].length, 'className'); pos += m[0].length; } return _styleProps(text, pos, emit); }
      if (kw === 'class') { const m = /^\s*([^\s]+)\s+([\p{L}\p{N}_,-]+)/u.exec(text.slice(pos)); if (m) { const a = pos + m[0].indexOf(m[1]); emit(a, a + m[1].length, 'variableName'); emit(pos + m[0].length - m[2].length, pos + m[0].length, 'className'); return pos + m[0].length; } return pos; }
      if (kw === 'style') { const m = /^\s*([^\s]+)/.exec(text.slice(pos)); if (m) { emit(pos + m[0].length - m[1].length, pos + m[0].length, 'variableName'); pos += m[0].length; } return _styleProps(text, pos, emit); }
      return pos;   // `state` — the id / "description" as follows
    }
  }
  const as = /^as\s/.exec(rest);
  if (as && /\s/.test(text[pos - 1] ?? ' ')) { emit(pos, pos + 2, 'keyword'); return pos + 2; }
  const m = /^[\p{L}\p{N}_-]+/u.exec(rest);
  if (m) { emit(pos, pos + m[0].length, 'variableName'); return pos + m[0].length; }
  return pos + 1;
}

// ── ER diagram ─────────────────────────────────────────────────────────────

function _erDiagram(text, pos, state, emit, atStart) {
  const rest = text.slice(pos);
  // Relations first: `}|..|{` starts with a brace.
  const rel = ER_REL_RE.exec(rest);
  if (rel) { emit(pos, pos + rel[0].length, 'operator'); return pos + rel[0].length; }
  if (rest[0] === '{') { emit(pos, pos + 1, 'punctuation'); state.block++; return pos + 1; }
  if (rest[0] === '}') { emit(pos, pos + 1, 'punctuation'); state.block = Math.max(0, state.block - 1); return pos + 1; }
  if (rest[0] === '"') return _openString(text, pos, state, emit, false);
  if (state.block && atStart) {
    // attribute: `type name [PK|FK|UK] ["comment"]`
    const m = /^([\p{L}_][\p{L}\p{N}_()\[\]-]*)\s+([\p{L}_][\p{L}\p{N}_-]*)/u.exec(rest);
    if (m) {
      emit(pos, pos + m[1].length, 'typeName');
      emit(pos + m[0].length - m[2].length, pos + m[0].length, 'propertyName');
      pos += m[0].length;
      const keys = /^(\s*(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)/.exec(text.slice(pos));
      if (keys) { emit(pos + keys[0].length - keys[0].trimStart().length, pos + keys[0].length, 'keyword'); pos += keys[0].length; }
      return pos;
    }
  }
  if (rest[0] === ':') { emit(pos, pos + 1, 'punctuation'); emit(pos + 1, text.length, 'string'); return text.length; }
  if (atStart) {
    const kw = _keywordAt(rest, KEYWORDS.er.start);
    if (kw) { emit(pos, pos + kw.length, 'keyword'); pos += kw.length; if (kw === 'direction') { const d = /^\s*(TB|TD|BT|RL|LR)\b/.exec(text.slice(pos)); if (d) { emit(pos + d[0].length - d[1].length, pos + d[0].length, 'atom'); pos += d[0].length; } } return pos; }
  }
  const ikw = _keywordAt(rest, KEYWORDS.er.inline);
  if (ikw && /\s/.test(text[pos - 1] ?? ' ')) { emit(pos, pos + ikw.length, 'keyword'); return pos + ikw.length; }
  const m = /^[\p{L}_][\p{L}\p{N}_-]*/u.exec(rest);
  if (m) { emit(pos, pos + m[0].length, 'variableName'); return pos + m[0].length; }
  if (rest.startsWith('[')) { const c = text.indexOf(']', pos); const e = c < 0 ? text.length : c + 1; emit(pos, e, 'string'); return e; }
  return pos + 1;
}

// ── Gantt ──────────────────────────────────────────────────────────────────

function _gantt(text, pos, state, emit, atStart) {
  const rest = text.slice(pos);
  if (atStart) {
    const kw = _keywordAt(rest, KEYWORDS.gantt.start);
    if (kw) {
      emit(pos, pos + kw.length, 'keyword'); pos += kw.length;
      if (kw === 'click') { const m = /^\s*([^\s]+)/.exec(text.slice(pos)); if (m) { emit(pos + m[0].length - m[1].length, pos + m[0].length, 'variableName'); pos += m[0].length; } return pos; }
      emit(pos + (text.slice(pos).length - text.slice(pos).trimStart().length), text.length, kw === 'section' || kw === 'title' ? 'string' : 'atom');
      return text.length;
    }
    // Task: `name : tags, id, start, end`
    const colon = text.indexOf(':', pos);
    if (colon < 0) return text.length;
    emit(pos, colon, 'string');
    emit(colon, colon + 1, 'punctuation');
    pos = colon + 1;
    for (const part of text.slice(pos).split(',')) {
      const s = pos; pos += part.length + 1;
      const lead = part.length - part.trimStart().length;
      const t = part.trim();
      if (!t) continue;
      const kw2 = _keywordAt(t, ['done', 'active', 'crit', 'milestone', 'vert']);
      if (kw2 === t) { emit(s + lead, s + lead + t.length, 'keyword'); continue; }
      const dep = /^(after|until)\s+(.*)$/.exec(t);
      if (dep) { emit(s + lead, s + lead + dep[1].length, 'keyword'); emit(s + lead + dep[1].length + 1, s + lead + t.length, 'variableName'); continue; }
      if (/^\d{4}-\d{2}-\d{2}/.test(t) || /^\d+[hdwmsM]?$/.test(t) || /^\d{1,2}:\d{2}/.test(t)) { emit(s + lead, s + lead + t.length, 'number'); continue; }
      emit(s + lead, s + lead + t.length, 'variableName');
    }
    return text.length;
  }
  return text.length;
}

// ── Generic (pie, git, mindmap, timeline, journey, quadrant, …) ────────────

function _generic(text, pos, state, emit, family, atStart) {
  const rest = text.slice(pos);
  const kws = KEYWORDS[family] ?? KEYWORDS.generic;
  if (rest[0] === '"' || rest[0] === "'") return _openString(text, pos, state, emit) || pos + 1;
  if (atStart) {
    const kw = _keywordAt(rest, kws.start);
    if (kw) {
      emit(pos, pos + kw.length, 'keyword'); pos += kw.length;
      // Free text after a titling keyword
      if (/^(title|section|accTitle|accDescr|x-axis|y-axis|quadrant-\d)$/.test(kw) && family !== 'xychart') {
        const after = text.slice(pos);
        emit(pos + after.length - after.trimStart().length, text.length, 'string');
        return text.length;
      }
      return pos;
    }
  }
  // `pie title Pets` / `pie showData`: titling keywords may follow the header.
  const ikw = _keywordAt(rest, kws.inline) || _keywordAt(rest, kws.start.filter(k => /^(title|showData)$/.test(k)));
  if (ikw && (pos === 0 || /[\s,{:(]/.test(text[pos - 1]))) {
    emit(pos, pos + ikw.length, 'keyword'); pos += ikw.length;
    if (ikw === 'title') { const after = text.slice(pos); emit(pos + after.length - after.trimStart().length, text.length, 'string'); return text.length; }
    return pos;
  }
  if (rest.startsWith('@{')) { emit(pos, pos + 2, 'punctuation'); state.attrs = true; return pos + 2; }
  if (rest.startsWith('::icon(')) { const c = text.indexOf(')', pos); const e = c < 0 ? text.length : c + 1; emit(pos, e, 'meta'); return e; }
  if (rest.startsWith(':::')) { emit(pos, pos + 3, 'punctuation'); const c = /^[\p{L}\p{N}_,-]+/u.exec(text.slice(pos + 3)); if (c) emit(pos + 3, pos + 3 + c[0].length, 'className'); return pos + 3 + (c?.[0].length ?? 0); }
  const arrow = /^(?:<-->|-->|->|<-|--|\.\.>|==>|~~~)/.exec(rest);
  if (arrow) { emit(pos, pos + arrow[0].length, 'operator'); return pos + arrow[0].length; }
  // Mindmap / block / kanban / architecture shapes: id then a bracketed label
  if (family === 'mindmap' || family === 'kanban' || family === 'block' || family === 'architecture' || family === 'timeline' || family === 'journey' || family === 'treemap') {
    for (const [open, close] of FLOW_SHAPES) {
      if (rest.startsWith(open) && open !== '>' && open !== '{') { emit(pos, pos + open.length, 'punctuation'); state.label = close; return pos + open.length; }
    }
  }
  const num = NUMBER_RE.exec(rest);
  if (num) { emit(pos, pos + num[0].length, 'number'); return pos + num[0].length; }
  if (/^[:,;|]/.test(rest)) { emit(pos, pos + 1, 'punctuation'); return pos + 1; }
  if (/^[[\](){}]/.test(rest)) { emit(pos, pos + 1, 'punctuation'); return pos + 1; }
  const m = WORD_RE.exec(rest);
  if (m) { emit(pos, pos + m[0].length, family === 'c4' ? 'name' : 'variableName'); return pos + m[0].length; }
  return pos + 1;
}

// ---------------------------------------------------------------------------
// Symbols — what is already in the document (for completion)
// ---------------------------------------------------------------------------

/**
 * Tokenize a whole body and collect its identifiers.
 *   names    Map id → count (node ids / participants / states / entities …, in order of first appearance)
 *   classes  Map name → count (`classDef` names, class diagram classes)
 *   family   the diagram family (null without a header)
 */
export function collectSymbols(text) {
  const state = createState();
  const names = new Map();
  const classes = new Map();
  const subgraphs = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasAtSubgraph = /^\s*subgraph\s/.test(line);
    for (const t of tokenizeLine(line, state)) {
      const word = line.slice(t.from, t.to);
      if (t.type === 'variableName' || t.type === 'name') {
        // `class A,B big` names several ids in one token.
        for (const id of word.split(',')) {
          if (!id) continue;
          if (wasAtSubgraph) subgraphs.add(id);
          names.set(id, (names.get(id) ?? 0) + 1);
        }
      } else if (t.type === 'className') {
        for (const c of word.split(',')) if (c) classes.set(c, (classes.get(c) ?? 0) + 1);
      }
    }
  }
  return { family: state.family, names, classes, subgraphs };
}

/**
 * Every token of a body with absolute offsets — the test suite's view and a
 * convenient debugging aid (`tokensOf(src).map(t => t.type + ':' + t.text)`).
 */
export function tokensOf(text) {
  const state = createState();
  const out = [];
  let off = 0;
  for (const line of text.split('\n')) {
    for (const t of tokenizeLine(line, state)) out.push({ from: off + t.from, to: off + t.to, type: t.type, text: line.slice(t.from, t.to) });
    off += line.length + 1;
  }
  return out;
}
