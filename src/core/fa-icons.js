/**
 * Font Awesome icon sets for the {diagram} app — pure, Node-tested
 * (test/fa-icons.test.mjs), no DOM, no mermaid.
 *
 * mermaid draws icons from iconify icon sets registered under a PREFIX: a
 * `fa:fa-user` token in a label looks up `user` in the set named `fa` (its own
 * `replaceIconSubstring` strips the `fa-`), `@{ icon: "fab:github" }` looks up
 * `github` in `fab`, an architecture `(fa:server)` likewise.  Font Awesome
 * ships three Free styles as three iconify packs (@iconify-json/fa6-solid /
 * -regular / -brands, CC BY 4.0) whose icons overlap by name (`user` exists
 * solid AND regular).  This module folds them into ONE merged set per Font
 * Awesome class prefix, differing only in which style wins a name:
 *
 *   fa / fas  solid › brands › regular    (`fa fa-github` was valid in FA4)
 *   far / fal regular › solid › brands    (light is Pro; regular is the closest free look)
 *   fab       brands › solid › regular
 *
 * so every name draws under every prefix and a wrong prefix still shows the
 * icon rather than a blank.  Legacy names (FA4/FA5: `edit`, `bank`, `close`,
 * `trash-alt` …) resolve through the generated alias table in fa-aliases.js,
 * and `fa-user` is accepted where mermaid wants `user` (`icon: "fa:fa-user"`).
 * `fak:` (Font Awesome Kit = a user's own uploaded icons) has no offline set.
 */

import { FA_ALIASES } from './fa-aliases.js';

/** The class prefixes mermaid recognises (`fa[bklrs]?`) that we can serve. */
export const FA_PREFIXES = ['fa', 'fas', 'far', 'fab', 'fal'];

/** `old=new` whitespace-separated pairs → Map(old → new). */
export function parseFaAliases(text = FA_ALIASES) {
  const map = new Map();
  for (const entry of text.split(/\s+/)) {
    const i = entry.indexOf('=');
    if (i > 0) map.set(entry.slice(0, i), entry.slice(i + 1));
  }
  return map;
}

/**
 * Merge iconify packs (in precedence order — the first pack holding a name
 * wins) into one iconify icon set called `prefix`.
 *
 * iconify fills an icon's missing `width`/`height` from the SET's defaults,
 * which are the primary pack's here — an icon taken from a pack with other
 * defaults (brands: 448 wide vs solid: 512) carries its own so it keeps its
 * proportions.  Pack aliases come along; `legacy` adds `old → new` parents for
 * names the packs don't hold; and the alias table is wrapped so that
 * `fa-<name>` resolves to `<name>` without 1 900 extra entries.
 *
 * @param {string} prefix
 * @param {object[]} packs   iconify JSON packs, highest precedence first
 * @param {Map<string,string>} [legacy]
 */
export function mergeFaPacks(prefix, packs, legacy = new Map()) {
  const { width, height } = packs[0];
  const icons = {};
  for (const pack of packs) {
    const foreign = pack.width !== width || pack.height !== height;
    for (const [name, icon] of Object.entries(pack.icons ?? {})) {
      if (icons[name]) continue;
      icons[name] = foreign ? { width: pack.width, height: pack.height, ...icon } : icon;
    }
  }
  const aliases = {};
  for (const pack of packs) {
    for (const [name, alias] of Object.entries(pack.aliases ?? {})) {
      if (!icons[name] && !aliases[name]) aliases[name] = alias;
    }
  }
  for (const [oldName, target] of legacy) {
    if (!icons[oldName] && !aliases[oldName] && (icons[target] || aliases[target])) {
      aliases[oldName] = { parent: target };
    }
  }
  const tolerant = new Proxy(aliases, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && k.startsWith('fa-') && k.length > 3) return { parent: k.slice(3) };
      return undefined;
    },
  });
  return { prefix, width, height, icons, aliases: tolerant };
}

/**
 * The five sets mermaid is given, from the three raw Font Awesome 6 Free packs.
 * @param {{solid: object, regular: object, brands: object}} packs
 * @param {string} [aliasText]  the `old=new` table (fa-aliases.js by default)
 * @returns {Record<string, object>}  keyed by FA_PREFIXES
 */
export function buildFaIconSets({ solid, regular, brands }, aliasText = FA_ALIASES) {
  const legacy = parseFaAliases(aliasText);
  const solidFirst   = mergeFaPacks('fa',  [solid, brands, regular], legacy);
  const regularFirst = mergeFaPacks('far', [regular, solid, brands], legacy);
  const brandsFirst  = mergeFaPacks('fab', [brands, solid, regular], legacy);
  return {
    fa:  solidFirst,
    fas: { ...solidFirst, prefix: 'fas' },
    far: regularFirst,
    fab: brandsFirst,
    fal: { ...regularFirst, prefix: 'fal' },
  };
}

/**
 * Resolve a name in a merged set the way @iconify/utils' getIconData does:
 * a real icon, else follow alias parents (cycle-safe).  Returns the icon data
 * or null — this is what the linter and the tests ask.
 */
export function lookupFaIcon(set, name) {
  const seen = new Set();
  let n = name;
  while (n && !seen.has(n)) {
    if (set.icons[n]) return set.icons[n];
    seen.add(n);
    n = set.aliases[n]?.parent;
  }
  return null;
}

/** The real icon names of a set, sorted — the completion list. */
export function faIconNames(set) {
  return Object.keys(set.icons).sort();
}

// ---------------------------------------------------------------------------
// Where a diagram mentions Font Awesome (lint + completion)
// ---------------------------------------------------------------------------

/** A label token, exactly mermaid's own pattern (`fa:fa-user`, `fab:fa-github`). */
export const FA_LABEL_RE = /\b(fa[bklrs]?):fa-([\w-]+)/g;
/** The `@{ icon: "fa:user" }` attribute (quotes optional) and architecture's `(fa:server)`. */
export const FA_ICON_ATTR_RE = /\b(?:icon\s*:\s*["']?|\()(fa[bklrs]?):(?!fa-)([\w-]+)/g;

/**
 * Every Font Awesome reference in a diagram body, in document order.
 * @returns {{prefix: string, name: string, from: number, to: number}[]}
 *   `from`/`to` bracket the whole token (`fa:fa-user`); offsets relative to `text`.
 */
export function findFaRefs(text) {
  const refs = [];
  for (const m of text.matchAll(FA_LABEL_RE)) {
    refs.push({ prefix: m[1], name: m[2], from: m.index, to: m.index + m[0].length });
  }
  for (const m of text.matchAll(FA_ICON_ATTR_RE)) {
    const token = `${m[1]}:${m[2]}`;
    const from = m.index + m[0].length - token.length;
    refs.push({ prefix: m[1], name: m[2], from, to: from + token.length });
  }
  return refs.sort((a, b) => a.from - b.from);
}
