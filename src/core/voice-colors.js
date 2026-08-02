/**
 * Default per-voice colors — the DAW "track color" convention, assigned
 * deterministically by a voice's position in the score order (see
 * abc-voices.js buildVoiceMap().order).  Used by the piano roll (note fills +
 * voice chips); intended to spread to other voice UI (gutter marks, mixer)
 * so a voice keeps one identity everywhere.
 *
 * Colors live in CSS custom properties (--voice-0 … --voice-7, themed for
 * dark/light in app.css); this module resolves them for canvas drawing with a
 * hex fallback matching the dark theme.
 */

export const VOICE_COLOR_COUNT = 8;

// Catppuccin Mocha accents (matches the app's dark palette): blue, peach,
// green, mauve, teal, yellow, red, sky.
const FALLBACK = [
  '#89b4fa', '#fab387', '#a6e3a1', '#cba6f7',
  '#94e2d5', '#f9e2af', '#f38ba8', '#89dceb',
];

/** CSS var() reference for a voice's color (for DOM styling). */
export function voiceColorVar(index) {
  const i = ((index % VOICE_COLOR_COUNT) + VOICE_COLOR_COUNT) % VOICE_COLOR_COUNT;
  return `var(--voice-${i}, ${FALLBACK[i]})`;
}

/** Resolved color string for a voice (for canvas drawing). */
export function resolveVoiceColor(index, el = document.documentElement) {
  const i = ((index % VOICE_COLOR_COUNT) + VOICE_COLOR_COUNT) % VOICE_COLOR_COUNT;
  try {
    const v = getComputedStyle(el).getPropertyValue(`--voice-${i}`).trim();
    if (v) return v;
  } catch { /* detached element */ }
  return FALLBACK[i];
}
