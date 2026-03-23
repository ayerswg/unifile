/**
 * Timeline model renderer — time is the primary coordinate axis.
 *
 * Document content declares tracks and events. Time can be expressed as:
 *   - Clock time:    0:00, 1:30:00, 00:30.500
 *   - ISO dates:     2026-01-15, 2026-Q1
 *   - Relative:      0, 4, 16 (bare numbers, interpreted as beats/bars/units)
 *   - Labels:        "Intro", "Day 1", "Phase 1" (ordered by appearance)
 *
 * Syntax
 * ──────
 *   track "Track Name" [options]
 *     [start..end] label [options]
 *     [point] label [options]
 *
 *   Where start..end is a range and a bare point is an instant.
 *
 * Track options: color=#hex  height=N
 * Event options: color=#hex  fill=#hex  id=name
 *
 * Example (music):
 *   ---
 *   model: timeline
 *   scale: bars
 *   tempo: 120
 *   ---
 *   track "Drums"
 *     [0..8] Intro beat
 *     [8..24] Verse groove
 *     [24..32] Chorus fill
 *   track "Vocals"
 *     [8..16] Verse 1
 *     [24..32] Chorus
 *   track "Guitar"
 *     [0..32] Rhythm
 *     [20..24] Solo
 *
 * Example (project timeline):
 *   ---
 *   model: timeline
 *   ---
 *   track "Design"
 *     [2026-01..2026-03] Wireframes
 *     [2026-03..2026-06] Visual Design
 *   track "Engineering"
 *     [2026-02..2026-07] Backend API
 *     [2026-04..2026-08] Frontend
 *   track "Launch"
 *     [2026-09] Release Day
 *
 * Front matter:
 *   scale     — label for the time axis (bars, beats, seconds, dates, etc.)
 *   start     — first time point to show (default: auto from events)
 *   end       — last time point to show (default: auto from events)
 *   snap      — grid interval (default: auto)
 */

import { parseGlobalFrontMatter } from '../core/front-matter.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function renderTimeline(content, container) {
  const { meta, bodyFrom } = parseGlobalFrontMatter(content);
  const body = content.slice(bodyFrom).trim();

  container.innerHTML = '';
  container.classList.add('timeline-model-mode');

  if (!body) {
    container.innerHTML = '<p class="preview-empty">Declare tracks and events using timeline syntax.<br><small>track "Name"<br>  [start..end] Label</small></p>';
    return;
  }

  const { tracks, timePoints } = _parse(body, bodyFrom);

  if (!tracks.length) {
    container.innerHTML = '<p class="preview-empty">No tracks found. Use: track "Name" then indent events as [start..end] Label</p>';
    return;
  }

  // Build ordered, normalised time axis
  const axis = _buildAxis(timePoints, meta.start, meta.end);

  const wrap = document.createElement('div');
  wrap.className = 'uf-tl-wrap';
  container.appendChild(wrap);

  // Time axis header
  const header = document.createElement('div');
  header.className = 'uf-tl-header';
  const corner = document.createElement('div');
  corner.className = 'uf-tl-corner';
  corner.textContent = meta.scale ?? '';
  header.appendChild(corner);

  for (const pt of axis) {
    const cell = document.createElement('div');
    cell.className = 'uf-tl-time-label';
    cell.textContent = pt.label;
    header.appendChild(cell);
  }
  wrap.appendChild(header);

  // Track rows
  for (const track of tracks) {
    const row = document.createElement('div');
    row.className = 'uf-tl-row';
    row.dataset.docFrom = track.srcFrom;

    const lbl = document.createElement('div');
    lbl.className = 'uf-tl-track-label';
    lbl.textContent = track.name;
    if (track.opts.color) lbl.style.borderLeftColor = track.opts.color;
    row.appendChild(lbl);

    const cells = document.createElement('div');
    cells.className = 'uf-tl-cells';
    cells.style.gridTemplateColumns = `repeat(${axis.length}, 1fr)`;
    row.appendChild(cells);

    // Empty slots
    for (let i = 0; i < axis.length; i++) {
      const slot = document.createElement('div');
      slot.className = 'uf-tl-slot';
      cells.appendChild(slot);
    }

    // Place events
    for (const evt of track.events) {
      const startIdx = axis.findIndex(p => p.key === evt.startKey);
      const endKey   = evt.endKey ?? evt.startKey;
      let endIdx     = axis.findIndex(p => p.key === endKey);
      if (endIdx < startIdx) endIdx = startIdx;

      const card = document.createElement('div');
      card.className = 'uf-tl-event';
      card.textContent = evt.label;
      card.dataset.docFrom = evt.srcFrom;
      const span = endIdx - startIdx + 1;
      card.style.gridColumn = `${startIdx + 1} / span ${span}`;
      if (evt.opts.color || track.opts.color)
        card.style.borderLeftColor = evt.opts.color ?? track.opts.color;
      if (evt.opts.fill) card.style.background = evt.opts.fill;
      cells.appendChild(card);
    }

    wrap.appendChild(row);
  }
}

export function teardownTimeline(container) {
  container.classList.remove('timeline-model-mode');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function _parse(body, bodyOffset) {
  const lines      = body.split('\n');
  const tracks     = [];
  const timePoints = new Map(); // key → label, ordered by insertion
  let   currentTrack = null;
  let   lineOffset   = bodyOffset;

  for (const line of lines) {
    const raw = line.trimEnd();
    const trimmed = raw.trimStart();

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) {
      lineOffset += line.length + 1;
      continue;
    }

    const depth = raw.length - trimmed.length;

    if (depth === 0 && /^track\s/i.test(trimmed)) {
      // Track declaration
      const rest = trimmed.slice(6).trim();
      const { text: name, opts } = _parseOpts(rest);
      currentTrack = { name: name.replace(/^["']|["']$/g, ''), opts, events: [], srcFrom: lineOffset };
      tracks.push(currentTrack);
    } else if (depth > 0 && currentTrack) {
      // Event declaration inside a track
      const evt = _parseEvent(trimmed, lineOffset, timePoints);
      if (evt) currentTrack.events.push(evt);
    }

    lineOffset += line.length + 1;
  }

  return { tracks, timePoints };
}

function _parseEvent(text, srcFrom, timePoints) {
  // [start..end] label  or  [point] label
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(text);
  if (!m) return null;

  const rangeStr = m[1].trim();
  const rest     = m[2].trim();
  const { text: label, opts } = _parseOpts(rest);

  let startStr, endStr;
  if (rangeStr.includes('..')) {
    [startStr, endStr] = rangeStr.split('..').map(s => s.trim());
  } else {
    startStr = rangeStr;
    endStr   = null;
  }

  const startKey = _normaliseTime(startStr);
  const endKey   = endStr ? _normaliseTime(endStr) : null;

  // Register time points in order
  if (!timePoints.has(startKey)) timePoints.set(startKey, startStr);
  if (endKey && !timePoints.has(endKey)) timePoints.set(endKey, endStr);

  return { startKey, endKey, label, opts, srcFrom };
}

function _parseOpts(text) {
  // Split trailing key=value pairs from the label
  const parts  = text.split(/\s+/);
  const optMap = {};
  const labelParts = [];

  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0 && /^[a-z-]+=/.test(p)) {
      optMap[p.slice(0, eq).toLowerCase()] = p.slice(eq + 1).replace(/^["']|["']$/g, '');
    } else {
      labelParts.push(p);
    }
  }

  return { text: labelParts.join(' ').replace(/^["']|["']$/g, ''), opts: optMap };
}

// Normalise a time string to a stable sort key
function _normaliseTime(t) {
  if (!t) return '0';
  const s = t.trim();

  // ISO date YYYY-MM-DD → sortable string
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Quarter: 2026-Q1 → 2026-Q1 (lexicographic sorts correctly within a year)
  if (/^\d{4}-Q[1-4]$/.test(s)) return s;
  // Year-month: 2026-01 → sortable
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  // Clock: H:MM or H:MM:SS → normalise to total seconds
  const clock = /^(\d+):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(s);
  if (clock) {
    const h = parseInt(clock[1], 10);
    const m = parseInt(clock[2], 10);
    const sec = parseInt(clock[3] ?? '0', 10);
    const ms  = parseFloat('0.' + (clock[4] ?? '0'));
    return String(h * 3600 + m * 60 + sec + ms).padStart(12, '0');
  }
  // Bare number
  if (/^\d+(\.\d+)?$/.test(s)) return String(parseFloat(s)).padStart(12, '0');
  // Label — use as-is (preserves insertion order)
  return s;
}

// ---------------------------------------------------------------------------
// Axis building
// ---------------------------------------------------------------------------

function _buildAxis(timePoints, metaStart, metaEnd) {
  // Sort by key
  const sorted = [...timePoints.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return sorted.map(([key, label]) => ({ key, label }));
}
