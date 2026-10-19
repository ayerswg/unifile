/**
 * A Standard MIDI File (format 1) from abc2svg's timing (core/abc-timing.js).
 *
 * {compose}'s MIDI export used to be abcjs's `getMidiFile`, a second parse of
 * the text by an engine that reads some tunes differently from the one that
 * draws the score (2026-10, the one-parser work). This writer takes the same
 * `timing` the transport plays: one track per voice, the voice's `%%MIDI
 * program` first, every note on/off at its ms with one velocity (abc2svg's rows
 * carry no dynamics), grace notes included, `%%MIDI control` rows as CCs.
 *
 * Time base: 500 ticks per quarter at a fixed tempo of 500 000 µs per quarter,
 * so ONE TICK IS ONE MILLISECOND — the timing's ms land on the grid exactly and
 * tempo changes inside the tune are already baked into the ms (ToAudio applied
 * them). Pure, Node-tested in test/midi-file.test.mjs.
 */

const PPQ = 500;               // ticks per quarter note
const US_PER_QUARTER = 500000; // µs — ♩ = 120, so a tick is 1 ms

/** Big-endian 32/16-bit and MIDI variable-length quantities. */
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
function vlq(n) {
  n = Math.max(0, Math.round(n));
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const chunk = (tag, bytes) => [...[...tag].map(ch => ch.charCodeAt(0)), ...u32(bytes.length), ...bytes];

/**
 * @param {import('./abc-timing.js').timingFromEvents extends (...a: any) => infer R ? R : never} timing
 * @param {{ volume?: number, title?: string }} [opts]  `volume` = velocity 1–127 (default 95)
 * @returns {Uint8Array}  the .mid file
 */
export function midiFileFromTiming(timing, { volume = 95, title = '' } = {}) {
  const vel = Math.max(1, Math.min(127, Math.round(volume)));
  // Group by voice index (score order). Channel = voice index mod 16, skipping 9 (drums).
  const voices = new Map();
  const lane = (vi) => {
    let v = voices.get(vi);
    if (!v) { v = { events: [], program: 0 }; voices.set(vi, v); }
    return v;
  };
  for (const n of timing.notes ?? []) {
    if (!(n.durMs > 0)) continue;
    const v = lane(n.voiceIndex);
    v.program = n.instr & 0x7f;
    const pitch = Math.max(0, Math.min(127, Math.round(n.midi)));
    v.events.push({ at: n.ms, order: 1, bytes: [0x90, pitch, vel] });
    v.events.push({ at: n.ms + n.durMs, order: 0, bytes: [0x80, pitch, 0] });   // offs before ons at the same tick
  }
  for (const c of timing.controls ?? []) {
    if (c.ctrl < 0 || c.ctrl > 127) continue;                 // 121 (reset) rows are ToAudio's own bookkeeping
    lane(c.voiceIndex).events.push({ at: c.ms, order: -1, bytes: [0xB0, c.ctrl & 0x7f, Math.max(0, Math.min(127, Math.round(c.value)))] });
  }

  const tracks = [];
  // Track 0: tempo (+ the title as a text meta event).
  const meta = [];
  if (title) {
    const t = [...new TextEncoder().encode(String(title))].slice(0, 127);
    meta.push(0, 0xff, 0x03, ...vlq(t.length), ...t);
  }
  meta.push(0, 0xff, 0x51, 0x03, (US_PER_QUARTER >>> 16) & 255, (US_PER_QUARTER >>> 8) & 255, US_PER_QUARTER & 255);
  meta.push(0, 0xff, 0x2f, 0x00);
  tracks.push(meta);

  const order = [...voices.keys()].sort((a, b) => a - b);
  order.forEach((vi, i) => {
    const v = voices.get(vi);
    let ch = i % 16; if (ch >= 9) ch = (ch + 1) % 16;       // never the percussion channel
    const bytes = [0, 0xC0 | ch, v.program & 0x7f];
    const name = [...new TextEncoder().encode(timing.voices?.[vi] ? `Voice ${timing.voices[vi]}` : `Voice ${vi + 1}`)];
    bytes.unshift(0, 0xff, 0x03, ...vlq(name.length), ...name);
    v.events.sort((a, b) => a.at - b.at || a.order - b.order);
    let last = 0;
    for (const e of v.events) {
      const tick = Math.round(e.at);
      bytes.push(...vlq(tick - last), e.bytes[0] | ch, e.bytes[1], e.bytes[2]);
      last = tick;
    }
    bytes.push(0, 0xff, 0x2f, 0x00);
    tracks.push(bytes);
  });

  const header = chunk('MThd', [...u16(1), ...u16(tracks.length), ...u16(PPQ)]);
  const body = tracks.flatMap(t => chunk('MTrk', t));
  return new Uint8Array([...header, ...body]);
}

export const MIDI_PPQ = PPQ;
