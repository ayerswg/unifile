import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandVoices, voicePrefixOf, sourceLineBreaks, hasLinebreakDirective } from '../src/core/abc-shorthand.js';
import { buildVoiceMap, voiceIdOfLine, voiceTagOfLine } from '../src/core/abc-voices.js';

test('voicePrefixOf: @id only at the line start, id = [A-Za-z0-9_]+', () => {
  assert.equal(voicePrefixOf('@1 A2 B2 |'), '1');
  assert.equal(voicePrefixOf('@RH|c2 d2|'), 'RH');
  assert.equal(voicePrefixOf('@Sop_2'), 'Sop_2');
  assert.equal(voicePrefixOf(' @1 A2'), null);       // not at the start
  assert.equal(voicePrefixOf('A2 @1 B2'), null);     // mid-line: not a prefix
  assert.equal(voicePrefixOf('@ 1'), null);
  assert.equal(voicePrefixOf('"@x" A2'), null);      // an annotation, not a prefix
});

test('expandVoices: @id becomes [V:id], other lines untouched', () => {
  const r = expandVoices('X:1\nK:C\n@1 A2 B2 |\n@2 F2 G2 |\nc2 d2 |\n');
  assert.equal(r.text, 'X:1\nK:C\n[V:1] A2 B2 |\n[V:2] F2 G2 |\nc2 d2 |\n');
  assert.equal(r.changed, true);
  const same = expandVoices('X:1\nK:C\n[V:1] A2 |\n');
  assert.equal(same.changed, false);
  assert.equal(same.text, 'X:1\nK:C\n[V:1] A2 |\n');
  assert.equal(same.toExpanded(7), 7);
  assert.equal(same.toSource(7), 7);
});

test('expandVoices: offset maps round-trip every music character', () => {
  const src = 'K:C\n@1 A2 B2 |\n@Sop c2 |\nd2 |\n';
  const r = expandVoices(src);
  const exp = r.text;
  // Each source char that is not part of a prefix maps to the same character.
  for (let i = 0; i < src.length; i++) {
    const e = r.toExpanded(i);
    if (src[i] === '@') { assert.equal(exp[e], '['); continue; }
    assert.equal(exp[e], src[i], `source ${i} (${JSON.stringify(src[i])}) → expanded ${e}`);
    assert.equal(r.toSource(e), i, `expanded ${e} → source`);
  }
  // Monotone both ways.
  for (let e = 1; e < exp.length; e++) assert.ok(r.toSource(e) >= r.toSource(e - 1));
  for (let i = 1; i < src.length; i++) assert.ok(r.toExpanded(i) >= r.toExpanded(i - 1));
  // Inside `[V:` → the `@`; the `]` → the id's last char; end of text maps to end.
  const at = exp.indexOf('[V:1]');
  assert.equal(r.toSource(at + 1), src.indexOf('@1'));
  assert.equal(r.toSource(at + 4), src.indexOf('@1') + 1);
  assert.equal(r.toSource(exp.length), src.length);
  assert.equal(r.toExpanded(src.length), exp.length);
  // A note range in the expanded text maps to the same note in the source.
  const noteE = exp.indexOf('c2');
  assert.equal(src.slice(r.toSource(noteE), r.toSource(noteE + 2)), 'c2');
  const noteS = src.indexOf('B2');
  assert.equal(exp.slice(r.toExpanded(noteS), r.toExpanded(noteS + 2)), 'B2');
});

test('expandVoices: a prefixed line is 3 chars longer, lines stay 1:1', () => {
  const r = expandVoices('@1 A|\n@22 B|\nC|');
  assert.equal(r.text.split('\n').length, 3);
  assert.equal(r.text, '[V:1] A|\n[V:22] B|\nC|');
});

test('sourceLineBreaks / hasLinebreakDirective: the flow opt-out', () => {
  assert.equal(sourceLineBreaks('X:1\nK:C\nA|'), false);
  assert.equal(sourceLineBreaks('%%linebreak $\nX:1'), false);
  assert.equal(sourceLineBreaks('%%linebreak <EOL>\nX:1'), true);
  assert.equal(sourceLineBreaks('%%linebreak <EOL> $\nX:1'), true);
  assert.equal(sourceLineBreaks('X:1\nI:linebreak <EOL>\nK:C'), true);
  assert.equal(hasLinebreakDirective('%%linebreak <none>\nX:1'), true);
  assert.equal(hasLinebreakDirective('X:1\n%% linebreak'), false);
});

test('abc-voices: @id lines count as voice lines in the map and the tag', () => {
  assert.equal(voiceIdOfLine('@2 c2 d2 |'), '2');
  assert.equal(voiceIdOfLine('V:2 clef=bass'), '2');
  assert.equal(voiceIdOfLine('c2 d2 |'), null);
  assert.deepEqual(voiceTagOfLine('@RH c2 |'), { from: 0, to: 3, id: 'RH' });
  assert.deepEqual(voiceTagOfLine('[V:LH] C,2 |'), { from: 0, to: 6, id: 'LH' });
  assert.deepEqual(voiceTagOfLine('V:T clef=treble'), { from: 0, to: 3, id: 'T' });
  assert.equal(voiceTagOfLine('A2 [V:1] B2'), null);
  const src = 'X:1\nV:1\nV:2\nK:C\n@1 A2 B2 |\n@2 F2 G2 |\n@1 c2 |\nd2 |\n';
  const vm = buildVoiceMap(src);
  assert.deepEqual(vm.order, ['1', '2']);
  assert.equal(vm.at(src.indexOf('A2')), '1');
  assert.equal(vm.at(src.indexOf('F2')), '2');
  assert.equal(vm.at(src.indexOf('c2')), '1');
  assert.equal(vm.at(src.indexOf('d2')), '1');   // an unprefixed line keeps the voice
  assert.equal(vm.at(0), null);
  // The expanded text yields the same order (so colours agree across editor + engines).
  assert.deepEqual(buildVoiceMap(expandVoices(src).text).order, ['1', '2']);
});
