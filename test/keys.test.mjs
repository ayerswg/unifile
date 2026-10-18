import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShortcut, detectMac } from '../src/core/keys.js';

test('formatShortcut reads Mod as ⌘ on a Mac and Ctrl elsewhere', () => {
  assert.equal(formatShortcut('Mod-/', true), '⌘/');
  assert.equal(formatShortcut('Mod-/', false), 'Ctrl+/');
  assert.equal(formatShortcut('Mod-s', true), '⌘S');
  assert.equal(formatShortcut('Mod-s', false), 'Ctrl+S');
});

test('formatShortcut orders modifiers the platform way', () => {
  assert.equal(formatShortcut('Mod-Shift-s', true), '⇧⌘S');
  assert.equal(formatShortcut('Shift-Mod-s', true), '⇧⌘S');
  assert.equal(formatShortcut('Mod-Shift-s', false), 'Ctrl+Shift+S');
  assert.equal(formatShortcut('Mod-Alt-m', true), '⌥⌘M');
  assert.equal(formatShortcut('Mod-Alt-m', false), 'Ctrl+Alt+M');
  assert.equal(formatShortcut('Alt-Shift-f', true), '⌥⇧F');
  assert.equal(formatShortcut('Alt-Shift-f', false), 'Alt+Shift+F');
  assert.equal(formatShortcut('Mod-Shift-,', true), '⇧⌘,');
  assert.equal(formatShortcut('Mod-Shift-,', false), 'Ctrl+Shift+,');
});

test('formatShortcut handles named keys, bare keys and the minus key', () => {
  assert.equal(formatShortcut('Shift-Tab', true), '⇧⇥');
  assert.equal(formatShortcut('Shift-Tab', false), 'Shift+Tab');
  assert.equal(formatShortcut('Tab', true), '⇥');
  assert.equal(formatShortcut('Tab', false), 'Tab');
  assert.equal(formatShortcut('Alt-1', true), '⌥1');
  assert.equal(formatShortcut('Alt-1', false), 'Alt+1');
  assert.equal(formatShortcut('Mod--', true), '⌘-');
  assert.equal(formatShortcut('Mod--', false), 'Ctrl+-');
  assert.equal(formatShortcut('Alt', true), '⌥');
  assert.equal(formatShortcut('Alt', false), 'Alt');
  assert.equal(formatShortcut('Mod', true), '⌘');
  assert.equal(formatShortcut('Mod', false), 'Ctrl');
  assert.equal(formatShortcut('Mod-Enter', true), '⌘↩');
  assert.equal(formatShortcut('Mod-Enter', false), 'Ctrl+Enter');
  // Ctrl and Mod collapse to one "Ctrl" on a PC, stay distinct on a Mac.
  assert.equal(formatShortcut('Ctrl-Mod-a', false), 'Ctrl+A');
  assert.equal(formatShortcut('Ctrl-Mod-a', true), '⌃⌘A');
});

test('detectMac reads the platform, then the user agent', () => {
  assert.equal(detectMac(undefined), false);
  assert.equal(detectMac({ platform: 'MacIntel' }), true);
  assert.equal(detectMac({ userAgentData: { platform: 'macOS' } }), true);
  assert.equal(detectMac({ platform: 'iPad' }), true);
  assert.equal(detectMac({ platform: 'Win32' }), false);
  assert.equal(detectMac({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux)' }), false);
  assert.equal(detectMac({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' }), true);
  assert.equal(detectMac({ platform: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), false);
});
