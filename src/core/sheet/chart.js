/**
 * {spreadsheet} — charts (pure, Node-tested).
 *
 *   A1:C9 {chart: column, title: "Sales", at: E2, size: 480x300}
 *
 * A chart line names its DATA range; the settings pick the form (`column`,
 * `bar`, `line`, `area`, `pie`, `scatter`), the title, where the chart sits
 * (`at`: the top-left cell, default right of the data) and its size.  The
 * first column holds the categories (the x values for a scatter) and the
 * first row the series names when it reads as a header (`series: rows`
 * transposes).  `chartData` reads the computed values; `renderChartSvg`
 * draws one self-contained SVG the grid, the HTML export and the print page
 * all use (the .xlsx gets a real DrawingML chart — xlsx.js).
 *
 * Marks follow the house rules: thin bars with a 2px surface gap and rounded
 * data ends, 2px lines with small markers, a recessive grid, one y axis, a
 * legend for two or more series, direct labels only on pies, categorical hues
 * in a fixed validated order (never cycled past eight — extra series fold
 * into "Other").
 */

import { isDate, isError } from '../tables/formula.js';
import { formatValue } from './style.js';

export const CHART_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
export const CHART_PALETTE_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const CHART_DEFAULT_SIZE = { w: 480, h: 300 };

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The data a chart draws, from the computed workbook.
 * @returns {{ categories: string[], series: Array<{ name, values: (number|null)[] }>, xs: number[]|null }}
 */
export function chartData(book, sheet, chart) {
  const R = chart.range;
  const r2 = Math.min(R.r2, sheet.rows.length - 1), c2 = Math.min(R.c2, sheet.cols - 1);
  let grid = [];
  for (let r = R.r1; r <= r2; r++) {
    const row = [];
    for (let c = R.c1; c <= c2; c++) {
      const cell = sheet.grid[r]?.[c];
      row.push(cell && cell.r === r && cell.c === c ? { v: book.valueOf(cell), text: book.display(cell) } : { v: null, text: '' });
    }
    grid.push(row);
  }
  if (chart.series === 'rows') grid = grid[0] ? grid[0].map((_, c) => grid.map(row => row[c])) : [];
  if (!grid.length || !grid[0].length) return { categories: [], series: [], xs: null };
  const num = (x) => (typeof x.v === 'number' ? x.v : isDate(x.v) ? x.v.serial : null);
  // A header row: the first row's cells past the first are not numbers.
  const firstRow = grid[0];
  const hasHeader = firstRow.length > 1 && firstRow.slice(1).some(x => x.v != null && num(x) == null) || (R.r1 < sheet.headerRows && chart.series !== 'rows');
  const body = hasHeader ? grid.slice(1) : grid;
  const oneColumn = firstRow.length === 1;
  const categories = body.map((row, i) => (oneColumn ? String(i + 1) : (row[0].text || String(i + 1))));
  const firstCol = oneColumn ? 0 : 1;
  const series = [];
  for (let c = firstCol; c < firstRow.length; c++) {
    series.push({ name: hasHeader ? (firstRow[c].text || `Series ${c}`) : `Series ${c - firstCol + 1}`, values: body.map(row => num(row[c])) });
  }
  const xs = chart.type === 'scatter' && !oneColumn ? body.map(row => num(row[0])) : null;
  return { categories, series, xs };
}

/** Nice axis ticks: 4–6 steps of 1·2·2.5·5·10 × 10^n, spanning [min, max] (0 included for bars). */
export function niceTicks(min, max, includeZero = true) {
  if (includeZero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (!(max > min)) { max = min + 1; }
  const span = max - min;
  const raw = span / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * pow).find(k => span / k <= 6) ?? pow * 10;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Number(t.toFixed(10)));
  return { lo, hi, step, ticks };
}

const fmtTick = (n) => formatValue(n, Math.abs(n) >= 1000 ? '#,##0' : null);

/**
 * @param data   from chartData
 * @param opts   { type, title, width, height, legend, dark, text, muted, grid, surface }
 */
export function renderChartSvg(data, opts = {}) {
  const type = opts.type ?? 'column';
  const W = opts.width ?? CHART_DEFAULT_SIZE.w, H = opts.height ?? CHART_DEFAULT_SIZE.h;
  const palette = opts.dark ? CHART_PALETTE_DARK : CHART_PALETTE;
  const text = opts.text ?? (opts.dark ? '#dedede' : '#1a1a1a');
  const muted = opts.muted ?? (opts.dark ? '#9a9a9a' : '#777');
  const gridC = opts.grid ?? (opts.dark ? '#333' : '#e6e6e6');
  const surface = opts.surface ?? (opts.dark ? '#181818' : '#ffffff');
  const title = opts.title ?? '';
  let series = data.series.slice(0, 8);
  if (data.series.length > 8) {
    // Fold the extras into "Other" rather than inventing a ninth hue.
    const rest = data.series.slice(7);
    series = data.series.slice(0, 7).concat([{ name: 'Other', values: rest[0].values.map((_, i) => rest.reduce((t, s) => t + (s.values[i] ?? 0), 0)) }]);
  }
  const showLegend = opts.legend !== false && series.length >= 2 && type !== 'pie';
  const top = title ? 30 : 12;
  const bottom = 26 + (showLegend ? 22 : 0);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="uf-chart uf-chart-${type}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="11">`);
  out.push(`<rect width="${W}" height="${H}" fill="${surface}"/>`);
  if (title) out.push(`<text x="${W / 2}" y="18" text-anchor="middle" font-size="13" font-weight="600" fill="${text}">${esc(title)}</text>`);
  const n = data.categories.length;
  if (!n || !series.length) {
    out.push(`<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}">No data</text></svg>`);
    return out.join('');
  }

  if (type === 'pie') {
    const s = series[0];
    const vals = s.values.map(v => Math.max(0, v ?? 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = W / 2, cy = top + (H - top - bottom) / 2 + 4, R = Math.min(W, H - top - bottom) / 2 - 36;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0), x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
      const d = v / total >= 0.9999 ? `M${cx - R},${cy}a${R},${R} 0 1,1 ${2 * R},0a${R},${R} 0 1,1 -${2 * R},0` : `M${cx},${cy}L${x0},${y0}A${R},${R} 0 ${large},1 ${x1},${y1}Z`;
      out.push(`<path d="${d}" fill="${palette[i % 8]}" stroke="${surface}" stroke-width="2"><title>${esc(data.categories[i])}: ${esc(fmtTick(v))} (${(v / total * 100).toFixed(1)}%)</title></path>`);
      const am = (a0 + a1) / 2;
      if (v / total >= 0.04) {
        const lx = cx + (R + 16) * Math.cos(am), ly = cy + (R + 16) * Math.sin(am);
        out.push(`<text x="${lx}" y="${ly + 4}" text-anchor="${Math.cos(am) < -0.1 ? 'end' : Math.cos(am) > 0.1 ? 'start' : 'middle'}" fill="${text}">${esc(data.categories[i])} ${(v / total * 100).toFixed(0)}%</text>`);
      }
      a0 = a1;
    });
    out.push('</svg>');
    return out.join('');
  }

  const left = 48, right = 14;
  const plotW = W - left - right, plotH = H - top - bottom;
  const all = series.flatMap(s => s.values).filter(v => v != null);
  const horizontal = type === 'bar';
  const t = niceTicks(Math.min(...all), Math.max(...all), type !== 'scatter' && type !== 'line');
  const vScale = (v) => (horizontal ? left + ((v - t.lo) / (t.hi - t.lo)) * plotW : top + plotH - ((v - t.lo) / (t.hi - t.lo)) * plotH);

  // Grid + value axis.
  for (const tk of t.ticks) {
    if (horizontal) {
      const x = vScale(tk);
      out.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${top + plotH}" stroke="${gridC}"/><text x="${x}" y="${top + plotH + 14}" text-anchor="middle" fill="${muted}">${esc(fmtTick(tk))}</text>`);
    } else {
      const y = vScale(tk);
      out.push(`<line x1="${left}" y1="${y}" x2="${left + plotW}" y2="${y}" stroke="${gridC}"/><text x="${left - 6}" y="${y + 4}" text-anchor="end" fill="${muted}">${esc(fmtTick(tk))}</text>`);
    }
  }
  const zero = vScale(Math.max(t.lo, Math.min(0, t.hi)));
  if (horizontal) out.push(`<line x1="${zero}" y1="${top}" x2="${zero}" y2="${top + plotH}" stroke="${muted}"/>`);
  else out.push(`<line x1="${left}" y1="${zero}" x2="${left + plotW}" y2="${zero}" stroke="${muted}"/>`);

  if (type === 'scatter') {
    const xs = data.xs ?? data.categories.map((_, i) => i + 1);
    const xt = niceTicks(Math.min(...xs.filter(x => x != null)), Math.max(...xs.filter(x => x != null)), false);
    const xScale = (x) => left + ((x - xt.lo) / (xt.hi - xt.lo)) * plotW;
    for (const tk of xt.ticks) out.push(`<text x="${xScale(tk)}" y="${top + plotH + 14}" text-anchor="middle" fill="${muted}">${esc(fmtTick(tk))}</text>`);
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (v == null || xs[i] == null) return;
        out.push(`<circle cx="${xScale(xs[i])}" cy="${vScale(v)}" r="4" fill="${palette[si]}" stroke="${surface}" stroke-width="1.5"><title>${esc(s.name)}: ${esc(fmtTick(xs[i]))}, ${esc(fmtTick(v))}</title></circle>`);
      });
    });
  } else if (type === 'line' || type === 'area') {
    const xAt = (i) => left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 56))));
    data.categories.forEach((c, i) => { if (i % every === 0) out.push(`<text x="${xAt(i)}" y="${top + plotH + 14}" text-anchor="middle" fill="${muted}">${esc(c)}</text>`); });
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => (v == null ? null : [xAt(i), vScale(v)]));
      let d = '', open = false;
      pts.forEach(p => { if (!p) { open = false; return; } d += (open ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); open = true; });
      if (type === 'area') {
        const firstI = pts.findIndex(Boolean), lastI = pts.length - 1 - pts.slice().reverse().findIndex(Boolean);
        if (firstI >= 0) out.push(`<path d="${d}L${xAt(lastI).toFixed(1)},${zero}L${xAt(firstI).toFixed(1)},${zero}Z" fill="${palette[si]}" fill-opacity="0.22" stroke="none"/>`);
      }
      out.push(`<path d="${d}" fill="none" stroke="${palette[si]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      if (n <= 40) pts.forEach((p, i) => { if (p) out.push(`<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${palette[si]}" stroke="${surface}" stroke-width="1.5"><title>${esc(data.categories[i])} — ${esc(s.name)}: ${esc(fmtTick(s.values[i]))}</title></circle>`); });
    });
  } else {
    // column / bar: grouped, 2px gaps, rounded data ends anchored at zero.
    const groups = n, k = series.length;
    const band = (horizontal ? plotH : plotW) / groups;
    const inner = band * 0.72, bw = Math.max(2, (inner - 2 * (k - 1)) / k);
    data.categories.forEach((c, i) => {
      const g0 = (horizontal ? top : left) + i * band + (band - inner) / 2;
      const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((horizontal ? plotH / 16 : plotW / 56)))));
      if (i % every === 0) {
        if (horizontal) out.push(`<text x="${left - 6}" y="${g0 + inner / 2 + 4}" text-anchor="end" fill="${muted}">${esc(c)}</text>`);
        else out.push(`<text x="${g0 + inner / 2}" y="${top + plotH + 14}" text-anchor="middle" fill="${muted}">${esc(c)}</text>`);
      }
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v == null) return;
        const p0 = g0 + si * (bw + 2);
        const a = vScale(v), z = zero;
        const rr = Math.min(4, bw / 2);
        let d;
        if (horizontal) {
          const x0 = Math.min(a, z), x1 = Math.max(a, z), y0 = p0, y1 = p0 + bw;
          const r = Math.min(rr, (x1 - x0) / 2);
          d = v >= 0 ? `M${x0},${y0}H${x1 - r}a${r},${r} 0 0,1 ${r},${r}V${y1 - r}a${r},${r} 0 0,1 -${r},${r}H${x0}Z` : `M${x1},${y0}H${x0 + r}a${r},${r} 0 0,0 -${r},${r}V${y1 - r}a${r},${r} 0 0,0 ${r},${r}H${x1}Z`;
        } else {
          const y0 = Math.min(a, z), y1 = Math.max(a, z), x0 = p0, x1 = p0 + bw;
          const r = Math.min(rr, (y1 - y0) / 2);
          d = v >= 0 ? `M${x0},${y1}V${y0 + r}a${r},${r} 0 0,1 ${r},-${r}H${x1 - r}a${r},${r} 0 0,1 ${r},${r}V${y1}Z` : `M${x0},${y0}V${y1 - r}a${r},${r} 0 0,0 ${r},${r}H${x1 - r}a${r},${r} 0 0,0 ${r},-${r}V${y0}Z`;
        }
        out.push(`<path d="${d}" fill="${palette[si]}"><title>${esc(c)} — ${esc(s.name)}: ${esc(fmtTick(v))}</title></path>`);
      });
    });
  }

  if (showLegend) {
    let x = left;
    const y = H - 8;
    series.forEach((s, si) => {
      out.push(`<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${palette[si]}"/><text x="${x + 14}" y="${y}" fill="${text}">${esc(s.name)}</text>`);
      x += 14 + Math.min(140, s.name.length * 6.2) + 14;
    });
  }
  out.push('</svg>');
  return out.join('');
}
