/**
 * Keyboard-shortcut labels that read right on the user's OS.
 *
 * Bindings are written the CodeMirror way (`Mod-Shift-s`, `Mod-/`, `Alt-1`):
 * `Mod` is ⌘ on a Mac (and an iPad with a keyboard) and Ctrl everywhere else —
 * CodeMirror resolves the KEY that way already; this module resolves the LABEL
 * the menus, tooltips and help show for it, so a Mac reads ⌘/ where Windows and
 * Linux read Ctrl+/.  Pure (the platform is a parameter; `IS_MAC` is detected
 * once from `navigator`), unit-tested in test/keys.test.mjs.
 */

/**
 * @param {{ platform?: string, userAgent?: string, userAgentData?: { platform?: string } } | undefined} nav
 */
export function detectMac(nav = globalThis.navigator) {
  if (!nav) return false;
  const platform = nav.userAgentData?.platform || nav.platform || '';
  if (platform) return /mac|iphone|ipad|ipod/i.test(platform);
  return /Mac|iPhone|iPad|iPod/.test(nav.userAgent || '');
}

export const IS_MAC = detectMac();

// Apple's glyphs, in Apple's canonical order: ⌃ ⌥ ⇧ ⌘.
const MAC_MODS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];
// Everyone else spells them out: Ctrl+Alt+Shift+Key.
const PC_MODS = { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
const PC_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'];

const MAC_KEYS = { Enter: '↩', Backspace: '⌫', Delete: '⌦', Escape: '⎋', Tab: '⇥', Space: '␣',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const PC_KEYS = { Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

/**
 * `formatShortcut('Mod-Shift-s')` → `⇧⌘S` on a Mac, `Ctrl+Shift+S` elsewhere;
 * `'Mod-/'` → `⌘/` / `Ctrl+/`; `'Alt-1'` → `⌥1` / `Alt+1`; `'Shift-Tab'` →
 * `⇧⇥` / `Shift+Tab`; a lone `'Alt'` → `⌥` / `Alt`.  Modifiers are `Mod`, `Ctrl`, `Alt`, `Shift` (any
 * order in the input); the key is the last `-`-separated part (`Mod--` is Mod
 * and the minus key).
 * @param {string} chord
 * @param {boolean} [mac]
 */
export function formatShortcut(chord, mac = IS_MAC) {
  const parts = String(chord).split(/-(?=.)/);
  let key = parts.pop();
  // A lone modifier (`Alt` for "hold Alt and drag") is a label, not a key.
  if (key in PC_MODS && !parts.length) return (mac ? MAC_MODS : PC_MODS)[key];
  const mods = new Set(parts);
  if (mods.has('Meta') || mods.has('Cmd')) { mods.delete('Meta'); mods.delete('Cmd'); mods.add('Mod'); }
  const order = mac ? MAC_ORDER : PC_ORDER;
  const names = mac ? MAC_MODS : PC_MODS;
  const keyName = key.length === 1 ? key.toUpperCase() : ((mac ? MAC_KEYS : PC_KEYS)[key] ?? key);
  const seen = new Set();
  const out = [];
  for (const m of order) {
    if (!mods.has(m)) continue;
    const label = names[m];
    if (seen.has(label)) continue;     // Mod + Ctrl both read "Ctrl" on a PC
    seen.add(label);
    out.push(label);
  }
  return mac ? out.join('') + keyName : [...out, keyName].join('+');
}
