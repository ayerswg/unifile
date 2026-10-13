import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensOf, collectSymbols, diagramTypeOf, createState, tokenizeLine, DIAGRAM_KEYWORDS, familyOf } from '../src/core/mermaid-syntax.js';

const toks = (src) => tokensOf(src).map(t => `${t.type}:${t.text}`);
const types = (src, type) => tokensOf(src).filter(t => t.type === type).map(t => t.text);

test('diagramTypeOf: first meaningful line, past comments, directives and a leading --- block', () => {
  assert.deepEqual(diagramTypeOf('flowchart LR\nA-->B'), { keyword: 'flowchart', family: 'flowchart', line: 0 });
  assert.deepEqual(diagramTypeOf('%% note\n\n  graph TD'), { keyword: 'graph', family: 'flowchart', line: 2 });
  assert.deepEqual(diagramTypeOf('---\ntitle: x\n---\n%%{init: {"theme":"dark"}}%%\nsequenceDiagram'),
    { keyword: 'sequenceDiagram', family: 'sequence', line: 4 });
  assert.equal(diagramTypeOf('flowcharts LR'), null);   // not a keyword
  assert.equal(diagramTypeOf(''), null);
  assert.equal(familyOf('flowchart-elk'), 'flowchart');
  assert.ok(DIAGRAM_KEYWORDS.indexOf('flowchart-elk') < DIAGRAM_KEYWORDS.indexOf('flowchart'), 'longest keyword first');
});

test('flowchart: spaceless links split the id from the arrow (mermaid NODE_STRING rule)', () => {
  assert.deepEqual(toks('flowchart LR\nA-->B'), ['keyword:flowchart', 'atom:LR', 'variableName:A', 'operator:-->', 'variableName:B']);
  assert.deepEqual(toks('graph TD\nA==>B'), ['keyword:graph', 'atom:TD', 'variableName:A', 'operator:==>', 'variableName:B']);
  assert.deepEqual(toks('graph TD\nA-.->B'), ['keyword:graph', 'atom:TD', 'variableName:A', 'operator:-.->', 'variableName:B']);
  // A hyphen inside an id stays an id when not followed by > - .
  assert.deepEqual(types('flowchart LR\nmy-node-1 --> other.node', 'variableName'), ['my-node-1', 'other.node']);
});

test('flowchart: every link form is one operator token', () => {
  const src = 'flowchart LR\nA --- B\nA --o B\nA --x B\nA <--> B\nA o--o B\nA x--x B\nA ==== B\nA -..-> B\nA ~~~ B\nA -.- B\nA ---> B';
  assert.deepEqual(types(src, 'operator'), ['---', '--o', '--x', '<-->', 'o--o', 'x--x', '====', '-..->', '~~~', '-.-', '--->']);
});

test('flowchart: edge labels — |text| and -- text -->', () => {
  assert.deepEqual(toks('flowchart LR\nA -->|Yes| B'),
    ['keyword:flowchart', 'atom:LR', 'variableName:A', 'operator:-->', 'punctuation:|', 'string:Yes', 'punctuation:|', 'variableName:B']);
  assert.deepEqual(toks('flowchart LR\nA -- some text --> B'),
    ['keyword:flowchart', 'atom:LR', 'variableName:A', 'operator:--', 'string: some text ', 'operator:-->', 'variableName:B']);
  assert.deepEqual(types('flowchart LR\nA == thick ==> B\nA -. dotted .-> B', 'operator'), ['==', '==>', '-.', '.->']);
});

test('flowchart: shapes — the label is a string between punctuation', () => {
  const src = 'flowchart TD\nA[rect] --> B(round) --> C{dia} --> D((circ)) --> E([stadium]) --> F[[sub]] --> G[(db)] --> H{{hex}} --> I[/para/] --> J[\\alt\\] --> K>asym] --> L(((dbl))) --> M[/trap\\]';
  assert.deepEqual(types(src, 'string'), ['rect', 'round', 'dia', 'circ', 'stadium', 'sub', 'db', 'hex', 'para', 'alt', 'asym', 'dbl', 'trap']);
  assert.deepEqual(types(src, 'variableName'), 'A B C D E F G H I J K L M'.split(' '));
});

test('flowchart: a quoted / markdown label spans lines', () => {
  const src = 'flowchart LR\nA["`**bold**\nsecond line`"] --> B\nB --> C';
  const t = tokensOf(src);
  const strings = t.filter(x => x.type === 'string').map(x => x.text);
  assert.deepEqual(strings, ['"`**bold**', 'second line`"']);
  // The closer and the following link are still seen after the string ends.
  assert.deepEqual(t.filter(x => x.type === 'operator').map(x => x.text), ['-->', '-->']);
  assert.deepEqual(t.filter(x => x.type === 'variableName').map(x => x.text), ['A', 'B', 'B', 'C']);
  // An unquoted label that runs to the next line keeps being a label.
  const s2 = tokensOf('flowchart LR\nA[line one\nline two] --> B');
  assert.deepEqual(s2.filter(x => x.type === 'string').map(x => x.text), ['line one', 'line two']);
});

test('flowchart: @{ } metadata, :::class, & chaining, statements', () => {
  assert.deepEqual(toks('flowchart LR\nA@{ shape: docs, label: "Docs" }'),
    ['keyword:flowchart', 'atom:LR', 'variableName:A', 'punctuation:@{', 'propertyName:shape', 'punctuation::', 'atom:docs',
     'punctuation:,', 'propertyName:label', 'punctuation::', 'string:"Docs"', 'punctuation:}']);
  assert.deepEqual(toks('flowchart LR\nA:::big & B'),
    ['keyword:flowchart', 'atom:LR', 'variableName:A', 'punctuation::::', 'className:big', 'punctuation:&', 'variableName:B']);
  assert.deepEqual(toks('flowchart LR\nclassDef big fill:#f9f,stroke:#333'),
    ['keyword:flowchart', 'atom:LR', 'keyword:classDef', 'className:big', 'propertyName:fill', 'atom:#f9f', 'punctuation:,', 'propertyName:stroke', 'atom:#333']);
  assert.deepEqual(toks('flowchart LR\nclass A,B big'), ['keyword:flowchart', 'atom:LR', 'keyword:class', 'variableName:A,B', 'className:big']);
  assert.deepEqual(toks('flowchart LR\nsubgraph one [Title]\ndirection TB\nend'),
    ['keyword:flowchart', 'atom:LR', 'keyword:subgraph', 'variableName:one', 'punctuation:[', 'string:Title', 'punctuation:]', 'keyword:direction', 'atom:TB', 'keyword:end']);
  assert.deepEqual(toks('flowchart LR\nsubgraph Title words'), ['keyword:flowchart', 'atom:LR', 'keyword:subgraph', 'variableName:Title', 'string:words']);
  assert.deepEqual(toks('flowchart LR\nclick A "https://x" _blank'), ['keyword:flowchart', 'atom:LR', 'keyword:click', 'variableName:A', 'string:"https://x"', 'keyword:_blank']);
  assert.deepEqual(toks('flowchart LR\n%% a comment\nA'), ['keyword:flowchart', 'atom:LR', 'comment:%% a comment', 'variableName:A']);
  assert.deepEqual(toks('%%{init: {"theme": "dark"}}%%\nflowchart LR'), ['meta:%%{init: {"theme": "dark"}}%%', 'keyword:flowchart', 'atom:LR']);
});

test('flowchart: indented header and keywords used as node text are not keywords', () => {
  assert.deepEqual(toks('   flowchart TB\n   A --> B'), ['keyword:flowchart', 'atom:TB', 'variableName:A', 'operator:-->', 'variableName:B']);
  // `end` inside a label is label text; `direction` mid-line is not a statement keyword.
  assert.deepEqual(types('flowchart LR\nA[the end] --> B', 'string'), ['the end']);
});

test('sequence diagram', () => {
  assert.deepEqual(toks('sequenceDiagram\nparticipant A as Alice\nA->>+B: Hello\nNote over A,B: hi\nloop Every minute\nend'),
    ['keyword:sequenceDiagram', 'keyword:participant', 'variableName:A', 'keyword:as', 'string:Alice',
     'variableName:A', 'operator:->>', 'punctuation:+', 'variableName:B', 'punctuation::', 'string: Hello',
     'keyword:Note', 'keyword:over', 'variableName:A', 'variableName:B', 'punctuation::', 'string: hi',
     'keyword:loop', 'string: Every minute', 'keyword:end']);
  assert.deepEqual(types('sequenceDiagram\nA-->>B: x\nA-x B: y\nA--)B: z\nA<<->>B: w', 'operator'), ['-->>', '-x', '--)', '<<->>']);
  assert.deepEqual(types('sequenceDiagram\nWeb App->>Server: GET', 'variableName'), ['Web App', 'Server']);
});

test('class diagram', () => {
  assert.deepEqual(toks('classDiagram\nclass Animal {\n+int age\n+isMammal() bool\n-run()*\n}\nAnimal <|-- Duck : inherits\n<<interface>> Animal'),
    ['keyword:classDiagram', 'keyword:class', 'className:Animal', 'punctuation:{',
     'punctuation:+', 'typeName:int', 'propertyName:age',
     'punctuation:+', 'propertyName:isMammal', 'punctuation:(', 'punctuation:)', 'typeName:bool',
     'punctuation:-', 'propertyName:run', 'punctuation:(', 'punctuation:)', 'punctuation:}',
     'className:Animal', 'operator:<|--', 'className:Duck', 'punctuation::', 'string:inherits',
     'meta:<<interface>>', 'className:Animal']);
  assert.deepEqual(types('classDiagram\nA *-- B\nA o-- B\nA --> B\nA ..> B\nA ..|> B\nA -- B', 'operator'), ['*--', 'o--', '-->', '..>', '..|>', '--']);
});

test('state diagram', () => {
  assert.deepEqual(toks('stateDiagram-v2\n[*] --> Still\nstate "Desc" as s2\nstate f <<fork>>\nnote right of Still: text'),
    ['keyword:stateDiagram-v2', 'atom:[*]', 'operator:-->', 'variableName:Still', 'keyword:state', 'string:"Desc"', 'keyword:as', 'variableName:s2',
     'keyword:state', 'variableName:f', 'meta:<<fork>>', 'keyword:note', 'keyword:right of', 'variableName:Still', 'punctuation::', 'string: text']);
});

test('er diagram', () => {
  assert.deepEqual(toks('erDiagram\nCUSTOMER ||--o{ ORDER : places\nCUSTOMER {\nstring name PK "the name"\n}'),
    ['keyword:erDiagram', 'variableName:CUSTOMER', 'operator:||--o{', 'variableName:ORDER', 'punctuation::', 'string: places',
     'variableName:CUSTOMER', 'punctuation:{', 'typeName:string', 'propertyName:name', 'keyword:PK', 'string:"the name"', 'punctuation:}']);
  assert.deepEqual(types('erDiagram\nA }|..|{ B : x\nA |o--o| B : y', 'operator'), ['}|..|{', '|o--o|']);
});

test('gantt, pie, gitGraph, mindmap', () => {
  assert.deepEqual(toks('gantt\ntitle A Gantt\ndateFormat YYYY-MM-DD\nsection S\nA task :a1, 2014-01-01, 30d\nB :done, after a1, 20d'),
    ['keyword:gantt', 'keyword:title', 'string:A Gantt', 'keyword:dateFormat', 'atom:YYYY-MM-DD', 'keyword:section', 'string:S',
     'string:A task ', 'punctuation::', 'variableName:a1', 'number:2014-01-01', 'number:30d',
     'string:B ', 'punctuation::', 'keyword:done', 'keyword:after', 'variableName:a1', 'number:20d']);
  assert.deepEqual(toks('pie title Pets\n"Dogs" : 386'), ['keyword:pie', 'keyword:title', 'string:Pets', 'string:"Dogs"', 'punctuation::', 'number:386']);
  assert.deepEqual(toks('gitGraph\ncommit id: "A" type: HIGHLIGHT\nbranch dev\ncheckout dev'),
    ['keyword:gitGraph', 'keyword:commit', 'keyword:id', 'punctuation::', 'string:"A"', 'keyword:type', 'punctuation::', 'keyword:HIGHLIGHT',
     'keyword:branch', 'variableName:dev', 'keyword:checkout', 'variableName:dev']);
  assert.deepEqual(toks('mindmap\nroot((Root))\n  A\n  ::icon(fa fa-book)'),
    ['keyword:mindmap', 'variableName:root', 'punctuation:((', 'string:Root', 'punctuation:))', 'variableName:A', 'meta:::icon(fa fa-book)']);
});

test('a leading --- front matter block is highlighted as YAML', () => {
  assert.deepEqual(toks('---\ntitle: x\nconfig:\n  look: handDrawn\n---\nflowchart LR'),
    ['meta:---', 'propertyName:title', 'punctuation::', 'propertyName:config', 'punctuation::', 'propertyName:look', 'punctuation::', 'meta:---', 'keyword:flowchart', 'atom:LR']);
});

test('tokenizeLine never loops and keeps state across lines', () => {
  const st = createState();
  tokenizeLine('flowchart LR', st);
  tokenizeLine('A["open', st);
  assert.equal(st.string, '"');
  assert.equal(st.label, ']');
  tokenizeLine('still open', st);
  assert.equal(st.string, '"');
  const t = tokenizeLine('closed"] --> B', st);
  assert.equal(st.string, null); assert.equal(st.label, null);
  assert.deepEqual(t.map(x => x.type), ['string', 'punctuation', 'operator', 'variableName']);
  // Garbage never hangs
  for (const junk of ["'''", '"""', '@{{{', ':::', '--', '|||', '[[[', ')))', '\\', '`']) {
    const s = createState(); tokenizeLine('flowchart LR', s); tokenizeLine(junk, s); tokenizeLine(junk, s);
  }
});

test('collectSymbols: ids once each with counts, classes, subgraphs', () => {
  const s = collectSymbols('flowchart LR\nA-->B\nB --> C[x]\nclass A,B big\nclassDef big fill:#f9f\nsubgraph S [t]\nend\nclick B "u"');
  assert.equal(s.family, 'flowchart');
  assert.deepEqual([...s.names.keys()], ['A', 'B', 'C', 'S']);
  assert.equal(s.names.get('B'), 4);
  assert.deepEqual([...s.classes.keys()], ['big']);
  assert.equal(s.classes.get('big'), 2);
  assert.deepEqual([...s.subgraphs], ['S']);
  const q = collectSymbols('sequenceDiagram\nparticipant A as Alice\nA->>B: hi');
  assert.deepEqual([...q.names.keys()], ['A', 'B']);
  const c = collectSymbols('classDiagram\nAnimal <|-- Duck\nclass Fish');
  assert.deepEqual([...c.classes.keys()], ['Animal', 'Duck', 'Fish']);
  const g = collectSymbols('gitGraph\ncommit\nbranch dev\ncheckout dev\nbranch feat');
  assert.deepEqual([...g.names.keys()], ['dev', 'feat']);
});
