import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePageConfig, parseMargins, lengthToPx, parsePageNumbers, fillTokens, resolveDate, hasSlots,
} from '../src/core/page-config.js';

test('lengthToPx converts print units', () => {
  assert.equal(lengthToPx('96px'), 96);
  assert.equal(lengthToPx('1in'), 96);
  assert.equal(lengthToPx('72pt'), 96);
  assert.equal(Math.round(lengthToPx('2.54cm')), 96);
  assert.equal(Math.round(lengthToPx('25.4mm')), 96);
  assert.equal(lengthToPx('12'), 12);
  assert.equal(lengthToPx('nope', 7), 7);
});

test('parseMargins expands CSS shorthand in any unit', () => {
  assert.deepEqual(parseMargins('1in'), { top: 96, right: 96, bottom: 96, left: 96 });
  assert.deepEqual(parseMargins('72px 80px'), { top: 72, right: 80, bottom: 72, left: 80 });
  assert.deepEqual(parseMargins('10px 20px 30px'), { top: 10, right: 20, bottom: 30, left: 20 });
  assert.deepEqual(parseMargins('1 2 3 4'), { top: 1, right: 2, bottom: 3, left: 4 });
  assert.deepEqual(parseMargins(undefined), { top: 72, right: 80, bottom: 72, left: 80 });
});

test('parsePageNumbers understands on/off and positions', () => {
  assert.equal(parsePageNumbers('on'), 'bottom-center');
  assert.equal(parsePageNumbers('true'), 'bottom-center');
  assert.equal(parsePageNumbers('off'), null);
  assert.equal(parsePageNumbers('none'), null);
  assert.equal(parsePageNumbers('top-right'), 'top-right');
  assert.equal(parsePageNumbers(undefined, 'bottom-right'), 'bottom-right');
  assert.equal(parsePageNumbers('sideways', 'bottom-right'), 'bottom-right');
});

test('parsePageConfig derives usable area, slots and defaults', () => {
  const cfg = parsePageConfig({
    title: 'T', author: 'A', page: 'a4', margin: '1in',
    header: '{title}', 'footer-right': '{page}/{total}', 'page-numbers': 'on', 'title-page': 'true', font: 'serif',
  });
  assert.equal(cfg.pageW, 794);
  assert.equal(cfg.pageH, 1123);
  assert.equal(cfg.usableW, 794 - 192);
  assert.equal(cfg.usableH, 1123 - 192);
  assert.deepEqual(cfg.header, { left: '', center: '{title}', right: '' });
  assert.deepEqual(cfg.footer, { left: '', center: '', right: '{page}/{total}' });
  assert.equal(cfg.pageNumbers, 'bottom-center');
  assert.equal(cfg.titlePage, true);
  assert.match(cfg.font, /Georgia/);
  assert.equal(hasSlots(cfg.header), true);
  assert.equal(hasSlots({ left: '', center: '', right: '' }), false);

  const d = parsePageConfig({});
  assert.equal(d.pageName, 'letter');
  assert.equal(d.pageNumbers, null);
  assert.equal(d.titlePage, false);
  assert.equal(d.font, '');
  assert.equal(parsePageConfig({ page: '600x800' }).pageW, 600);
  assert.equal(parsePageConfig({}, { pageNumbers: 'bottom-right' }).pageNumbers, 'bottom-right');
});

test('fillTokens substitutes and escapes', () => {
  const html = fillTokens('Page {page} of {total} — {title} <b>', { page: 2, total: 9, title: 'A & B' });
  assert.equal(html, 'Page 2 of 9 — A &amp; B &lt;b&gt;');
  assert.match(fillTokens('{total}', { page: 1 }), /<span data-uf-total><\/span>/);
  assert.match(fillTokens('{date}', { date: '2026-10-01' }), /2026-10-01/);
});

test('resolveDate prints verbatim dates and today', () => {
  assert.equal(resolveDate('1 Oct 2026'), '1 Oct 2026');
  const fixed = new Date(2026, 9, 1);
  assert.equal(resolveDate('today', fixed), fixed.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
  assert.equal(resolveDate('', fixed), resolveDate('today', fixed));
});
