import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toggleCommentEdits, applyEdits, mapOffset, commentSpecFor, frontMatterEnd, YAML_COMMENT,
} from '../src/core/line-comment.js';

const ABC = { line: '%', directive: /^%%/ };
const MERMAID = { line: '%%', directive: /^%%\{/ };
const HASH = { line: '#' };
const HTML = { block: { open: '<!--', close: '-->' } };

/** Toggle lines a..b of `text` and return the new text. */
function toggle(text, a, b, spec) {
  const lines = text.split('\n');
  const res = toggleCommentEdits(lines, a, b, spec);
  return res ? applyEdits(lines, res.edits).join('\n') : null;
}

test('line comment: comments the selected lines at the common indentation, and back', () => {
  assert.equal(toggle('C D E F|\nG A B c|', 0, 1, ABC), '% C D E F|\n% G A B c|');
  assert.equal(toggle('% C D E F|\n% G A B c|', 0, 1, ABC), 'C D E F|\nG A B c|');
  // Mixed → comment everything; the token lands at the minimum indent.
  assert.equal(toggle('  a\n    b\n  c', 0, 2, HASH), '  # a\n  #   b\n  # c');
  assert.equal(toggle('  # a\n  #   b\n  # c', 0, 2, HASH), '  a\n    b\n  c');
  // Partly commented → comment the rest too (then one toggle clears all).
  assert.equal(toggle('# a\nb', 0, 1, HASH), '# # a\n# b');
  // Uncomment strips the token and one following space only.
  assert.equal(toggle('#a\n#  b', 0, 1, HASH), 'a\n b');
});

test('line comment: blank lines are skipped unless they are the whole selection', () => {
  assert.equal(toggle('a\n\nb', 0, 2, HASH), '# a\n\n# b');
  assert.equal(toggle('# a\n\n# b', 0, 2, HASH), 'a\n\nb');
  assert.equal(toggle('', 0, 0, HASH), '# ');
  assert.equal(toggle('  ', 0, 0, HASH), '  # ');
  assert.equal(toggle('# ', 0, 0, HASH), '');
});

test('line comment: directives count as code, and the toggle round-trips over them', () => {
  // ABC: `%%MIDI` is a directive, not a comment.
  assert.equal(toggle('%%MIDI program 1', 0, 0, ABC), '% %%MIDI program 1');
  assert.equal(toggle('% %%MIDI program 1', 0, 0, ABC), '%%MIDI program 1');
  assert.equal(toggle('%%score (1 2)\nC D|', 0, 1, ABC), '% %%score (1 2)\n% C D|');
  // mermaid: `%%{init}%%` is a directive, a plain `%%` line a comment.
  assert.equal(toggle("%%{init: {'theme': 'dark'}}%%", 0, 0, MERMAID), "%% %%{init: {'theme': 'dark'}}%%");
  assert.equal(toggle('%% note\nA --> B', 0, 1, MERMAID), '%% %% note\n%% A --> B');
  assert.equal(toggle('%% A --> B', 0, 0, MERMAID), 'A --> B');
});

test('block comment: wraps the selected lines in one block, and unwraps it', () => {
  assert.equal(toggle('Hello', 0, 0, HTML), '<!-- Hello -->');
  assert.equal(toggle('<!-- Hello -->', 0, 0, HTML), 'Hello');
  assert.equal(toggle('<!--Hello-->', 0, 0, HTML), 'Hello');
  assert.equal(toggle('one\ntwo\nthree', 0, 2, HTML), '<!-- one\ntwo\nthree -->');
  assert.equal(toggle('<!-- one\ntwo\nthree -->', 0, 2, HTML), 'one\ntwo\nthree');
  // Leading / trailing blank lines stay outside the block.
  assert.equal(toggle('\n  one\ntwo\n', 0, 3, HTML), '\n  <!-- one\ntwo -->\n');
  assert.equal(toggle('\n  <!-- one\ntwo -->\n', 0, 3, HTML), '\n  one\ntwo\n');
  // An empty line alone gets an empty block; toggling it again clears it.
  assert.equal(toggle('', 0, 0, HTML), '<!--  -->');
  assert.equal(toggle('<!--  -->', 0, 0, HTML), '');
  assert.equal(toggle('<!---->', 0, 0, HTML), '');
  // Trailing whitespace after the closing marker survives an unwrap.
  assert.equal(toggle('<!-- a -->  ', 0, 0, HTML), 'a  ');
});

test('spec resolution: the leading front matter is YAML, the body is the DSL', () => {
  const lines = ['---', 'title: x', '---', 'C D E|'];
  assert.equal(frontMatterEnd(lines), 2);
  assert.equal(frontMatterEnd(['C D E|']), -1);
  assert.equal(frontMatterEnd(['---', 'title: x']), -1);
  assert.equal(frontMatterEnd(['---\r', 'a\r', '---\r']), 2);
  assert.equal(commentSpecFor(lines, 1, 1, ABC), YAML_COMMENT);
  assert.equal(commentSpecFor(lines, 0, 2, ABC), YAML_COMMENT);
  assert.equal(commentSpecFor(lines, 3, 3, ABC), ABC);
  assert.equal(commentSpecFor(lines, 1, 3, ABC), ABC);        // straddles → the DSL
  assert.equal(commentSpecFor(['a'], 0, 0, null), null);
  assert.equal(toggleCommentEdits(['a'], 0, 0, null), null);
  assert.equal(toggleCommentEdits(['a'], 0, 0, {}), null);
  assert.equal(toggle('title: x', 0, 0, YAML_COMMENT), '# title: x');
});

test('mapOffset keeps the caret on its text through the edits', () => {
  const lines = ['abc', 'def', 'ghi'];
  const { edits } = toggleCommentEdits(lines, 0, 2, HASH);
  // Caret at a line start moves after the inserted token (assoc 1).
  assert.equal(mapOffset(lines, edits, 0), 2);
  // Caret mid-line shifts by the token on its line + the earlier lines'.
  assert.equal(mapOffset(lines, edits, 1), 3);
  assert.equal(mapOffset(lines, edits, 5), 9);     // 'def' col 1 → line 1 start 6 + 2 + 1
  assert.equal(mapOffset(lines, edits, 11), 17);   // doc end
  // Uncommenting: a caret inside the removed token lands on the removal point.
  const c = ['# abc', '# def'];
  const un = toggleCommentEdits(c, 0, 1, HASH);
  assert.equal(mapOffset(c, un.edits, 1), 0);
  assert.equal(mapOffset(c, un.edits, 2), 0);
  assert.equal(mapOffset(c, un.edits, 3), 1);
  assert.equal(mapOffset(c, un.edits, 8), 4);      // 'def' col 2 → 'def' col 0... + line 0 shrank by 2
  // Block comment on one line: both edits on the same line.
  const h = ['<!-- Hello -->'];
  const hb = toggleCommentEdits(h, 0, 0, HTML);
  assert.equal(applyEdits(h, hb.edits)[0], 'Hello');
  assert.equal(mapOffset(h, hb.edits, 7), 2);
  assert.equal(mapOffset(h, hb.edits, 14), 5);
});
