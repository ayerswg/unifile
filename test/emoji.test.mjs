import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchEmoji, emojiForShortcode, allEmoji } from '../src/core/emoji.js';

test('the table loads and exact shortcodes resolve', () => {
  assert.ok(allEmoji().length > 1500);
  assert.equal(emojiForShortcode('smile'), '😄');
  assert.equal(emojiForShortcode('rocket'), '🚀');
  assert.equal(emojiForShortcode('+1'), '👍');
  assert.equal(emojiForShortcode('not_an_emoji_xyz'), null);
});

test('searchEmoji ranks prefix matches first and keeps table order', () => {
  const sm = searchEmoji('sm');
  assert.ok(sm.length > 0);
  assert.ok(sm.every(h => h.emoji && h.code && typeof h.desc === 'string'));
  assert.equal(sm[0].code.startsWith('sm'), true);
  // 😃 :smiley: is the first `sm…` shortcode in gemoji order, 😄 :smile: next
  assert.deepEqual(sm.slice(0, 2).map(h => h.emoji), ['😃', '😄']);
  // exact code outranks longer prefixes
  assert.equal(searchEmoji('smile')[0].code, 'smile');
  // tags and descriptions still find things
  assert.ok(searchEmoji('hooray').some(h => h.emoji === '🙌'));
  assert.ok(searchEmoji('thumbs').some(h => h.emoji === '👍'));
  assert.deepEqual(searchEmoji(''), []);
  assert.equal(searchEmoji('s', 5).length, 5);
});
