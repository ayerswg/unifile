/**
 * Font Awesome icons for mermaid, offline — the {diagram} app's icon packs.
 *
 * Registers the five Font Awesome class prefixes mermaid looks up (`fa`,
 * `fas`, `far`, `fab`, `fal` — see core/fa-icons.js for how the three Free
 * styles are merged under them) with `mermaid.registerIconPacks`, so that
 *
 *   A[fa:fa-user Customer]             a label token → an inline <svg class="label-icon">
 *   B@{ icon: "fab:github", form: "circle" }   an icon node
 *   service db(fa:database)[Database]  architecture-beta
 *
 * all draw with no webfont, no CSS and no network: the icons are vector paths
 * that travel inside the rendered svg (and so inside the SVG / PNG exports).
 *
 * The packs are the @iconify-json/fa6-* dependencies (~1.45 MB of JSON, ~470 KB
 * gzipped) bundled by esbuild as LAZY modules — `import()` here is inlined into
 * the single-file bundle but its module body only evaluates on the first
 * icon lookup (a document without icons never parses the table).
 */

import mermaid from 'mermaid';
import { buildFaIconSets, FA_PREFIXES } from '../core/fa-icons.js';

let _sets = null;

/** The merged icon sets, built once on first use (a promise). */
export function loadFaIconSets() {
  if (!_sets) {
    _sets = (async () => {
      const [solid, regular, brands] = await Promise.all([
        import('@iconify-json/fa6-solid/icons.json'),
        import('@iconify-json/fa6-regular/icons.json'),
        import('@iconify-json/fa6-brands/icons.json'),
      ]);
      return buildFaIconSets({ solid: solid.default, regular: regular.default, brands: brands.default });
    })();
  }
  return _sets;
}

mermaid.registerIconPacks(FA_PREFIXES.map(name => ({
  name,
  loader: async () => (await loadFaIconSets())[name],
})));
