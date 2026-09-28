/**
 * Build identity + "is that build newer than me?" — shared by every shell's
 * update check (ui/update-check.js, upub/app.js, udraft/app.js) and by the
 * site's version.json writer (build/sync-site.mjs mirrors nothing anymore: it
 * imports this).  Pure — no DOM, Node-testable (test/build-info.test.mjs).
 *
 * A build is identified by THREE things, all stamped by esbuild `define`s in
 * build/build.mjs (guarded below for any non-built context):
 *
 *   version   the semantic version (newer of the latest git tag / package.json)
 *   commit    7-char commit hash + `commitAt` commit time (UTC ISO)
 *   channel   'stable' (built from `main`) | 'dev' (the `dev` branch, feature
 *             previews, local builds)
 *
 * Two update rules, chosen by the RUNNING build's channel:
 *
 *   stable → a release is newer when its VERSION outranks ours (SemVer 2.0
 *            precedence: rc.2 > rc.1, and 1.0.0 > 1.0.0-rc.2).  Commits are
 *            ignored — main deploys between bumps without offering anything.
 *   dev    → the COMMIT is the version.  Every push to `dev` deploys to
 *            dev.unifile.app with no tag bump, so a build is newer when its
 *            commit hash differs and its commit time is later than ours (the
 *            "later" guard keeps a stale CDN edge — or a rolled-back branch —
 *            from bouncing us backwards).  A version bump still counts too.
 */

/* global UNIFILE_VERSION, UNIFILE_BUILT, UNIFILE_COMMIT, UNIFILE_COMMIT_AT, UNIFILE_CHANNEL */

/** The running build, as stamped at build time. */
export const BUILD = Object.freeze({
  version:  (typeof UNIFILE_VERSION   !== 'undefined') ? UNIFILE_VERSION   : '0.0.0',
  built:    (typeof UNIFILE_BUILT     !== 'undefined') ? UNIFILE_BUILT     : '',
  commit:   (typeof UNIFILE_COMMIT    !== 'undefined') ? UNIFILE_COMMIT    : '',
  commitAt: (typeof UNIFILE_COMMIT_AT !== 'undefined') ? UNIFILE_COMMIT_AT : '',
  channel:  (typeof UNIFILE_CHANNEL   !== 'undefined') ? UNIFILE_CHANNEL   : 'stable',
});

/** True when this build tracks the dev channel (commit-based updates). */
export function isDevChannel(build = BUILD) { return build.channel === 'dev'; }

// ---------------------------------------------------------------------------
// SemVer 2.0 precedence
// ---------------------------------------------------------------------------

/** Parse `1.2.3-rc.4` → { core:[1,2,3], pre:['rc','4'] | null } (leading v stripped). */
function _parse(v) {
  const [core, pre] = String(v ?? '').trim().replace(/^v/, '').split('-');
  const n = core.split('.').map(x => parseInt(x, 10) || 0);
  return { core: [n[0] || 0, n[1] || 0, n[2] || 0], pre: pre ? pre.split('.') : null };
}

/**
 * SemVer 2.0 precedence compare → +1 if a > b, -1 if a < b, 0 if equal.
 * A release outranks its pre-releases (1.0.0 > 1.0.0-rc.2); pre-release
 * identifiers compare per spec (rc.2 > rc.1; numeric < alphanumeric).
 */
export function cmpSemver(a, b) {
  const A = _parse(a), B = _parse(b);
  for (let i = 0; i < 3; i++) if (A.core[i] !== B.core[i]) return A.core[i] > B.core[i] ? 1 : -1;
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;          // a is the final release → newer than any pre-release
  if (!B.pre) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;   // shorter pre-release set has lower precedence
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x > +y ? 1 : -1; }
    else if (xn !== yn) return xn ? -1 : 1;   // numeric identifiers rank below alphanumeric
    else if (x !== y) return x > y ? 1 : -1;   // ASCII order
  }
  return 0;
}

// ---------------------------------------------------------------------------
// version.json → build info
// ---------------------------------------------------------------------------

/**
 * Normalise a fetched version.json into a build-info object.  `latest` is the
 * newest published version overall (there is no stable/RC channel split —
 * `stable`/`version` are kept for older clients).
 */
export function remoteBuild(data) {
  const d = data || {};
  return {
    version:  String(d.latest ?? d.stable ?? d.version ?? ''),
    built:    d.built ?? d.released ?? '',
    commit:   String(d.commit ?? ''),
    commitAt: String(d.commitAt ?? ''),
    channel:  d.channel ?? '',
  };
}

/** `2026-09-28T10:12:33Z` → ms since epoch, or NaN when absent/unparsable. */
function _ms(iso) { return iso ? Date.parse(iso) : NaN; }

/**
 * Is `remote` a newer build than `local`?  Returns the reason ('version' |
 * 'commit') or null.  The rule depends on `local.channel` (see file header).
 *
 * Dev: a different commit with a LATER commit time wins; equal/unknown times
 * with a different hash also win only when we have no time to compare (an
 * older version.json without `commitAt` — e.g. the first deploy after this
 * scheme lands).  A different hash with an EARLIER time is not an update.
 */
export function newerBuild(remote, local = BUILD) {
  if (!remote) return null;
  if (remote.version && cmpSemver(remote.version, local.version) > 0) return 'version';
  if (!isDevChannel(local)) return null;
  if (!remote.commit || !local.commit || remote.commit === local.commit) return null;
  const r = _ms(remote.commitAt), l = _ms(local.commitAt);
  if (Number.isNaN(r) || Number.isNaN(l)) return 'commit';
  return r > l ? 'commit' : null;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** `2026-09-28T10:12:33Z` → `2026-09-28 10:12Z` (minute precision, UTC). */
export function formatCommitAt(iso) {
  if (!iso) return '';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso));
  return m ? `${m[1]} ${m[2]}Z` : String(iso);
}

/**
 * Short build label.  Stable: `v0.4.3`.  Dev (or `{commit:true}`):
 * `abc1234 (2026-09-28 10:12Z)` — the hash is the identity there, so it leads;
 * the version is appended only when `version:true` asks for it.
 */
export function formatBuild(b, { commit, version } = {}) {
  if (!b) return '';
  const showCommit = commit ?? (isDevChannel(b) || isDevChannel());
  const v = b.version ? `v${b.version}` : '';
  if (!showCommit || !b.commit) return v;
  const at = formatCommitAt(b.commitAt);
  const c = at ? `${b.commit} (${at})` : b.commit;
  return version && v ? `${c} · ${v}` : c;
}
