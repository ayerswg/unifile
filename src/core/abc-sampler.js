/**
 * {compose}'s piano: a Web Audio sampler over the committed FluidR3 soundfont
 * (src/assets/piano-soundfont.js — 88 mp3 data URIs, one per key, MIDI.js
 * format), playing abc2svg's timing (core/abc-timing.js) straight on the
 * audio clock.
 *
 * It replaces abcjs's CreateSynth (2026-10, the abcjs retirement), which mixed
 * the WHOLE tune into one buffer before the first sound — a second or more on
 * a phone, the slow start the `abcStarting` work had to paper over — and a
 * `playEvent` that built a throwaway synth per audition. Here a Play schedules
 * the notes of the next second or so and keeps a look-ahead going, so sound
 * starts at once, pause/seek are a stop and a new `play(fromMs)`, and a note
 * already sounding at the seek point starts mid-sample. The audition is one
 * `playNote`.
 *
 * Browser-only (AudioContext); the pure pieces (`noteName`, `nearestSample`,
 * `scheduleWindow`) are exported for the Node tests.
 */

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];   // MIDI.js spells flats

/** MIDI number → the soundfont's key name (`60` → `C4`, `70` → `Bb4`). */
export function noteName(midi) {
  const m = Math.round(midi);
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/**
 * The sample to play for `midi`: its own key when the font has it, else the
 * nearest key within an octave, with the playback rate that pitches it right
 * (a fractional `midi` — microtones — rides on the rate too).
 * @param {number} midi
 * @param {(name: string) => boolean} has  whether the font holds a key
 * @returns {{ name: string, rate: number }|null}
 */
export function nearestSample(midi, has) {
  const m = Math.round(midi);
  for (let d = 0; d <= 12; d++) {
    for (const k of d === 0 ? [m] : [m - d, m + d]) {
      const name = noteName(k);
      if (has(name)) return { name, rate: Math.pow(2, (midi - k) / 12) };
    }
  }
  return null;
}

/**
 * Which notes a look-ahead pass schedules and how: from index `i` in `notes`
 * (sorted by `ms`), every note with an onset up to `horizonMs`, skipping those
 * already over at `fromMs`, muted, or at/after `stopMs`; a note sounding across
 * `fromMs` starts `offsetMs` into its sample. Pure, so the window logic is tested.
 * @returns {{ next: number, items: {note: object, atMs: number, offsetMs: number, durMs: number}[] }}
 */
export function scheduleWindow(notes, i, { fromMs, horizonMs, stopMs = null, isMuted = null }) {
  const items = [];
  while (i < notes.length && notes[i].ms <= horizonMs) {
    const n = notes[i++];
    const end = n.ms + n.durMs;
    if (!(n.durMs > 0) || end <= fromMs) continue;
    if (stopMs != null && n.ms >= stopMs - 0.5) continue;
    if (isMuted && isMuted(n.start)) continue;
    const offsetMs = Math.max(0, fromMs - n.ms);
    items.push({ note: n, atMs: Math.max(n.ms, fromMs), offsetMs, durMs: n.durMs - offsetMs });
  }
  return { next: i, items };
}

const LOOKAHEAD_SEC = 1.2;   // schedule this far ahead of the audio clock …
const TICK_MS = 200;         // … checking this often
const RELEASE_SEC = 0.08;    // the fade at a note's end (the piano sample's own decay does the rest)

export class PianoSampler {
  /**
   * @param {AudioContext} ctx  the app's persistent context (see abcjs.js _acquireAudioContext)
   * @param {Record<string, string>} font  key name → `data:audio/mp3;base64,…`
   */
  constructor(ctx, font) {
    this.ctx = ctx;
    this.font = font;
    this.buffers = new Map();
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    this._live = new Set();
    this._loading = null;
  }

  /** Decode every sample once (≈ a few hundred ms); safe to call repeatedly. */
  load() {
    if (!this._loading) {
      this._loading = Promise.all(Object.entries(this.font).map(async ([name, uri]) => {
        try {
          const b64 = String(uri).slice(String(uri).indexOf(',') + 1);
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          this.buffers.set(name, await this.ctx.decodeAudioData(bytes.buffer));
        } catch { /* a key that will not decode is simply missing — nearestSample covers it */ }
      })).then(() => { if (!this.buffers.size) throw new Error('no piano sample could be decoded'); });
    }
    return this._loading;
  }

  get ready() { return this.buffers.size > 0; }

  /** One voice: a buffer source with a gain envelope, started at `when` (ctx seconds). */
  _voice(midi, velocity, when, durSec, offsetSec = 0) {
    const s = nearestSample(midi, (name) => this.buffers.has(name));
    if (!s) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get(s.name);
    src.playbackRate.value = s.rate;
    const g = this.ctx.createGain();
    const v = Math.max(0.02, Math.min(1, (velocity ?? 95) / 127));
    const amp = v * v;                                     // velocity → loudness, roughly perceptual
    const end = when + Math.max(0.03, durSec);
    g.gain.setValueAtTime(amp, when);
    g.gain.setValueAtTime(amp, end);
    g.gain.linearRampToValueAtTime(0, end + RELEASE_SEC);
    src.connect(g);
    g.connect(this.master);
    const h = { src, g };
    this._live.add(h);
    src.onended = () => { this._live.delete(h); try { g.disconnect(); } catch { /* already gone */ } };
    src.start(when, Math.max(0, offsetSec));
    src.stop(end + RELEASE_SEC + 0.01);
    return h;
  }

  /** Sound one note now (the audition, the piano roll's drag feedback). */
  playNote(midi, durMs = 300, velocity = 95) {
    if (!this.ready) return;
    this._voice(midi, velocity, this.ctx.currentTime, Math.max(0.05, durMs / 1000));
  }

  /**
   * Play `notes` (core/abc-timing.js timing notes, sorted by `ms`) from `fromMs`.
   * @param {object[]} notes  `{ ms, durMs, midi, velocity, start }`
   * @param {{ fromMs?: number, stopMs?: number|null, isMuted?: (start:number)=>boolean, onEnded?: () => void }} [opts]
   *   `stopMs` = play nothing starting at/after it (a selected range); `onEnded` fires once the last
   *   scheduled note has sounded out (not after a `stop()`).
   * @returns {{ stop: () => void }}  stops and releases everything, including notes queued but not yet begun
   */
  play(notes, { fromMs = 0, stopMs = null, isMuted = null, onEnded = null } = {}) {
    const base = this.ctx.currentTime + 0.03;             // tune ms → ctx time: base + (ms − fromMs) / 1000
    let i = 0, endMs = fromMs, timer = null, stopped = false;
    const schedule = () => {
      if (stopped) return;
      const nowMs = (this.ctx.currentTime - base) * 1000 + fromMs;
      const { next, items } = scheduleWindow(notes, i, { fromMs, horizonMs: nowMs + LOOKAHEAD_SEC * 1000, stopMs, isMuted });
      i = next;
      for (const it of items) {
        this._voice(it.note.midi, it.note.velocity, base + (it.atMs - fromMs) / 1000, it.durMs / 1000, it.offsetMs / 1000);
        if (it.atMs + it.durMs > endMs) endMs = it.atMs + it.durMs;
      }
      if (i < notes.length) timer = setTimeout(schedule, TICK_MS);
      else if (onEnded) {
        const leftMs = (base - this.ctx.currentTime) * 1000 + (endMs - fromMs) + RELEASE_SEC * 1000 + 100;
        timer = setTimeout(() => { if (!stopped) onEnded(); }, Math.max(0, leftMs));
      }
    };
    schedule();
    return {
      stop: () => { stopped = true; clearTimeout(timer); this.stopAll(); },
    };
  }

  /** Release every sounding or queued voice within ~50 ms. */
  stopAll() {
    const now = this.ctx.currentTime;
    for (const h of this._live) {
      try {
        h.g.gain.cancelScheduledValues(now);
        h.g.gain.setValueAtTime(h.g.gain.value, now);
        h.g.gain.linearRampToValueAtTime(0, now + 0.05);
        h.src.stop(now + 0.06);
      } catch { /* a source that never started, or already ended */ }
    }
    this._live.clear();
  }
}
