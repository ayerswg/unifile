/**
 * {spreadsheet} — sequences (pure, Node-tested).
 *
 * `A2:A13 {seq: 1}` fills a range with generated values instead of listing
 * them: the cells are real to formulas and exports but are never written out
 * one by one.  The start decides the kind:
 *
 *   {seq: 1}                      1, 2, 3 …            step: 1 (any number)
 *   {seq: 100, step: -5}          100, 95, 90 …
 *   {seq: 2026-01-01}             ISO dates a day apart  step: 1 | 7 | 1 week |
 *                                                        2 weeks | 1 month | 1 year
 *   {seq: Jan}  {seq: Monday}     month / weekday names, cycling; the start's
 *                                 spelling (short / long, case) is kept
 *   {seq: Item 1}                 text ending in a number: Item 2, Item 3 …
 *   {seq: Q1, step: 1}            same (Q2, Q3, Q4, Q5 …)
 */

import { formatNumber } from '../tables/formula.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Parse a `step` value: a number, or `N day(s)|week(s)|month(s)|year(s)`. */
export function parseStep(s) {
  if (s == null || s === '') return { n: 1, unit: null };
  const t = String(s).trim().toLowerCase();
  if (/^[-+]?\d*\.?\d+$/.test(t)) return { n: Number(t), unit: null };
  const m = /^([-+]?\d*\.?\d+)?\s*(day|week|month|year)s?$/.exec(t);
  if (m) return { n: m[1] == null ? 1 : Number(m[1]), unit: m[2] };
  return null;
}

/** The canonical spelling of a step. */
export function formatStep(step) {
  if (!step.unit) return formatNumber(step.n);
  return `${formatNumber(step.n)} ${step.unit}${Math.abs(step.n) === 1 ? '' : 's'}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }

function addMonths(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last)));
}

/**
 * The first `count` values of a sequence.
 * @param {string} start   the `seq:` value
 * @param {object|null} step   from parseStep (null → 1)
 * @returns {string[] | null}   null when the start is not a sequence start
 */
export function generateSequence(start, step, count) {
  const st = step ?? { n: 1, unit: null };
  const s = String(start ?? '').trim();
  const n = Math.max(0, count | 0);
  if (!s) return null;
  // Numbers
  if (/^[-+]?\d*\.?\d+$/.test(s)) {
    const a = Number(s);
    const d = st.unit ? st.n : st.n;
    return Array.from({ length: n }, (_, i) => formatNumber(a + i * d));
  }
  // ISO dates
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dm) {
    const base = new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3]));
    if (Number.isNaN(base.getTime())) return null;
    const unit = st.unit ?? 'day';
    const k = st.n;
    return Array.from({ length: n }, (_, i) => {
      if (unit === 'day') return isoDate(new Date(base.getTime() + i * k * 86400000));
      if (unit === 'week') return isoDate(new Date(base.getTime() + i * k * 7 * 86400000));
      if (unit === 'month') return isoDate(addMonths(base, i * k));
      return isoDate(addMonths(base, i * k * 12));
    });
  }
  // Month / weekday names, cycling, keeping the start's spelling style.
  const lower = s.toLowerCase();
  for (const [names, len] of [[MONTHS, 12], [DAYS, 7]]) {
    const idx = names.findIndex(nm => nm === lower || (lower.length >= 3 && nm.startsWith(lower) && lower.length <= 3));
    if (idx >= 0) {
      const short = lower.length <= 3;
      const style = s === s.toUpperCase() ? 'upper' : s[0] === s[0].toUpperCase() ? 'title' : 'lower';
      return Array.from({ length: n }, (_, i) => {
        let nm = names[(((idx + i * Math.round(st.n)) % len) + len) % len];
        if (short) nm = nm.slice(0, 3);
        if (style === 'upper') nm = nm.toUpperCase();
        else if (style === 'title') nm = nm[0].toUpperCase() + nm.slice(1);
        return nm;
      });
    }
  }
  // Text with a trailing number
  const tm = /^(.*?)(\d+)$/.exec(s);
  if (tm) {
    const a = parseInt(tm[2], 10), width = tm[2].length;
    return Array.from({ length: n }, (_, i) => tm[1] + String(a + i * Math.round(st.n)).padStart(tm[2][0] === '0' ? width : 0, '0'));
  }
  return null;
}
