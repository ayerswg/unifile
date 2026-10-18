import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  parseFaAliases, mergeFaPacks, buildFaIconSets, lookupFaIcon, faIconNames, findFaRefs, FA_PREFIXES,
} from '../src/core/fa-icons.js';
import { FA_ALIASES } from '../src/core/fa-aliases.js';

const require = createRequire(import.meta.url);

// Small fixtures shaped like the iconify packs.
const solid = {
  prefix: 'fa6-solid', width: 512, height: 512,
  icons: { user: { body: '<path d="S-user"/>' }, house: { body: '<path d="S-house"/>' }, 'pen-to-square': { body: '<path d="S-pen"/>' } },
  aliases: { 'child-rifle': { parent: 'user' } },
};
const regular = {
  prefix: 'fa6-regular', width: 512, height: 512,
  icons: { user: { body: '<path d="R-user"/>' }, bell: { body: '<path d="R-bell"/>' } },
};
const brands = {
  prefix: 'fa6-brands', width: 448, height: 512,
  icons: { github: { body: '<path d="B-github"/>' }, twitter: { body: '<path d="B-twitter"/>', width: 512 } },
  aliases: { 'github-square': { parent: 'github' } },
};
const legacy = 'edit=pen-to-square bank=house nope=missing';

test('parseFaAliases: whitespace-separated old=new pairs', () => {
  const m = parseFaAliases('a=b\n  c=d   e=f');
  assert.deepEqual([...m], [['a', 'b'], ['c', 'd'], ['e', 'f']]);
});

test('mergeFaPacks: first pack wins a name; foreign packs carry their own size', () => {
  const fa = mergeFaPacks('fa', [solid, brands, regular], parseFaAliases(legacy));
  assert.equal(fa.prefix, 'fa');
  assert.equal(fa.icons.user.body, '<path d="S-user"/>');          // solid over regular
  assert.equal(fa.icons.bell.body, '<path d="R-bell"/>');           // regular fills what solid lacks
  assert.deepEqual(fa.icons.github, { width: 448, height: 512, body: '<path d="B-github"/>' }); // brands' default width travels
  assert.equal(fa.icons.twitter.width, 512);                        // an icon's own width is kept
  assert.equal(fa.icons.house.width, undefined);                    // the primary pack's icons are untouched
  const far = mergeFaPacks('far', [regular, solid, brands]);
  assert.equal(far.icons.user.body, '<path d="R-user"/>');
});

test('mergeFaPacks: pack aliases, legacy aliases and the fa- prefix all resolve', () => {
  const fa = mergeFaPacks('fa', [solid, brands, regular], parseFaAliases(legacy));
  assert.equal(lookupFaIcon(fa, 'child-rifle').body, '<path d="S-user"/>');     // solid's own alias
  assert.equal(lookupFaIcon(fa, 'github-square').body, '<path d="B-github"/>'); // brands' own alias
  assert.equal(lookupFaIcon(fa, 'edit').body, '<path d="S-pen"/>');            // FA5 name
  assert.equal(lookupFaIcon(fa, 'bank').body, '<path d="S-house"/>');          // FA4 name
  assert.equal(lookupFaIcon(fa, 'fa-user').body, '<path d="S-user"/>');        // `icon: "fa:fa-user"`
  assert.equal(lookupFaIcon(fa, 'fa-edit').body, '<path d="S-pen"/>');         // both at once
  assert.equal(lookupFaIcon(fa, 'nope'), null);                                // alias to a missing icon is dropped
  assert.equal(lookupFaIcon(fa, 'fa-'), null);
  assert.equal(lookupFaIcon(fa, 'zzz'), null);
  // The alias wrapper behaves like iconify expects: a plain lookup, undefined otherwise.
  assert.deepEqual(fa.aliases['fa-house'], { parent: 'house' });
  assert.equal(fa.aliases.house, undefined);
});

test('faIconNames: real icons only, sorted', () => {
  const fa = mergeFaPacks('fa', [solid, brands, regular], parseFaAliases(legacy));
  assert.deepEqual(faIconNames(fa), ['bell', 'github', 'house', 'pen-to-square', 'twitter', 'user']);
});

test('buildFaIconSets: one set per prefix, each style winning its own prefix', () => {
  const sets = buildFaIconSets({ solid, regular, brands }, legacy);
  assert.deepEqual(Object.keys(sets), FA_PREFIXES);
  for (const p of FA_PREFIXES) assert.equal(sets[p].prefix, p);
  assert.equal(sets.fa.icons.user.body,  '<path d="S-user"/>');
  assert.equal(sets.fas.icons.user.body, '<path d="S-user"/>');
  assert.equal(sets.far.icons.user.body, '<path d="R-user"/>');
  assert.equal(sets.fal.icons.user.body, '<path d="R-user"/>');
  assert.equal(sets.fab.icons.user.body, '<path d="S-user"/>');   // a non-brand name under fab still draws
  assert.equal(sets.far.icons.house.body, '<path d="S-house"/>'); // no regular house → solid
  assert.equal(sets.fa.icons.github.body, '<path d="B-github"/>'); // FA4's `fa fa-github`
});

test('findFaRefs: label tokens, icon attributes and architecture icons with offsets', () => {
  const src = 'flowchart LR\n  A[fa:fa-user Customer] --> B@{ icon: "fab:github", form: "circle" }\n' +
              '  C@{icon: far:bell}\n  service db(fa:database)[DB]\n  D[fak:fa-custom]';
  const refs = findFaRefs(src);
  assert.deepEqual(refs.map(r => [r.prefix, r.name, src.slice(r.from, r.to)]), [
    ['fa', 'user', 'fa:fa-user'],
    ['fab', 'github', 'fab:github'],
    ['far', 'bell', 'far:bell'],
    ['fa', 'database', 'fa:database'],
    ['fak', 'custom', 'fak:fa-custom'],
  ]);
  // `icon: "fa:fa-user"` is ONE reference (the label pattern), not two.
  assert.deepEqual(findFaRefs('A@{ icon: "fa:fa-user" }').map(r => r.name), ['user']);
  assert.deepEqual(findFaRefs('A[plain] --> B(no icons)'), []);
});

test('the real packs + the generated alias table: common names resolve under every prefix', () => {
  const brandsPack = require('@iconify-json/fa6-brands/icons.json');
  const sets = buildFaIconSets({
    solid:   require('@iconify-json/fa6-solid/icons.json'),
    regular: require('@iconify-json/fa6-regular/icons.json'),
    brands:  brandsPack,
  });
  assert.ok(faIconNames(sets.fa).length > 1800);  // solid ∪ brands ∪ regular, by name
  assert.ok(FA_ALIASES.split(/\s+/).filter(Boolean).length > 600);
  // The mermaid docs' own example (`fa:fa-ban`, `fa:fa-spinner`, `fa:fa-camera-retro`).
  for (const n of ['ban', 'spinner', 'camera-retro', 'user', 'bell', 'database', 'server']) {
    assert.ok(lookupFaIcon(sets.fa, n), `fa:${n}`);
  }
  assert.ok(lookupFaIcon(sets.fab, 'github'));
  assert.ok(lookupFaIcon(sets.fa, 'github'), 'FA4-style brand under fa');
  assert.ok(lookupFaIcon(sets.far, 'envelope'));
  // Legacy names: FA5 (`edit`, `trash-alt`, `sign-out-alt`) and FA4 (`bank`, `close`, `sign-out`).
  for (const n of ['edit', 'trash-alt', 'sign-out-alt', 'bank', 'close', 'sign-out', 'exchange', 'cog']) {
    assert.ok(lookupFaIcon(sets.fa, n), `legacy ${n}`);
  }
  assert.equal(lookupFaIcon(sets.fa, 'edit'), lookupFaIcon(sets.fa, 'pen-to-square'));
  assert.equal(lookupFaIcon(sets.fa, 'fa-user'), lookupFaIcon(sets.fa, 'user'));
  assert.equal(lookupFaIcon(sets.fa, 'no-such-icon'), null);
  // A brand icon merged under `fa` keeps its own box: an explicit width stays,
  // and one that relied on the brands pack's default (448, not solid's 512) carries it.
  assert.equal(lookupFaIcon(sets.fa, 'github').width, brandsPack.icons.github.width);
  const bare = Object.keys(brandsPack.icons).find(n => brandsPack.icons[n].width == null);
  assert.equal(lookupFaIcon(sets.fa, bare).width, 448);
});
