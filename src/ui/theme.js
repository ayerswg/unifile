/**
 * Application colour-theme management.
 *
 * Supported preferences: 'dark' | 'light' | 'auto'
 *   dark  — always Catppuccin Mocha regardless of OS setting
 *   light — always Catppuccin Latte regardless of OS setting
 *   auto  — follows prefers-color-scheme (the default)
 *
 * Implementation: sets data-theme="dark" or data-theme="light" on <html>.
 * CSS variables in app.css react to the attribute.
 * When no attribute is present, the @media (prefers-color-scheme: light) rule
 * handles auto-switching between Mocha and Latte.
 */

import { loadUserPrefs, saveUserPrefs } from '../core/storage.js';
import { state } from './state.js';

const DARK_QUERY = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * Returns the currently effective theme ('dark' | 'light'), resolving 'auto'
 * by inspecting the OS preference.
 * @returns {'dark'|'light'}
 */
export function getEffectiveTheme() {
  const pref = loadUserPrefs().theme ?? 'auto';
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return DARK_QUERY.matches ? 'dark' : 'light';
}

/**
 * Apply a theme preference.
 * @param {'dark'|'light'|'auto'} pref
 */
export function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'light') {
    root.setAttribute('data-theme', 'light');
  } else if (pref === 'dark') {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.removeAttribute('data-theme'); // let @media rule take over
  }
  saveUserPrefs({ theme: pref });
  state.emit('theme-change', getEffectiveTheme());
}

/**
 * Read stored pref and apply it. Also wires up the OS-preference listener
 * so 'auto' mode reacts to OS changes live.
 * Call once during app init.
 */
export function initTheme() {
  const pref = loadUserPrefs().theme ?? 'auto';
  applyTheme(pref);

  // For 'auto' mode: re-emit theme-change when OS preference changes
  DARK_QUERY.addEventListener('change', () => {
    if ((loadUserPrefs().theme ?? 'auto') === 'auto') {
      state.emit('theme-change', getEffectiveTheme());
    }
  });
}
