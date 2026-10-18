/**
 * Build identity — the pieces of "which build is this?" that are NOT the
 * semantic version: the commit hash + commit time, and the release channel.
 * Shared by build.mjs (stamped into every bundle as UNIFILE_COMMIT /
 * UNIFILE_COMMIT_AT / UNIFILE_CHANNEL) and sync-site.mjs (published in
 * docs/version.json) so the app and the site can never disagree on how a
 * build is identified.
 *
 * Why the commit matters: the dev channel (dev.unifile.app = the `dev`
 * branch's Cloudflare Pages preview) deploys EVERY push with no version bump,
 * so on that channel the commit is the version — the in-app update check
 * compares commits there (src/core/build-info.js), not tags.
 *
 * Cloudflare's shallow checkout has no tags but does have HEAD, and Pages also
 * exports CF_PAGES_COMMIT_SHA / CF_PAGES_BRANCH.
 */

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC' }
    }).toString().trim() || null;
  } catch { return null; }   // not a git checkout (e.g. a source tarball)
}

/** 7-char commit hash + commit timestamp (UTC, `YYYY-MM-DDTHH:MM:SSZ`). */
export function detectCommit() {
  const sha = process.env.CF_PAGES_COMMIT_SHA || git('rev-parse HEAD');
  const at = git('log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd');
  return { hash: sha ? sha.slice(0, 7) : '', at: at || '' };
}

/**
 * Release channel: `stable` for builds of `main` (and of a release tag checked
 * out detached), `dev` for everything else — the `dev` branch, feature-branch
 * previews, local builds.  `UNIFILE_CHANNEL=stable|dev` overrides.
 */
export function detectChannel() {
  const forced = (process.env.UNIFILE_CHANNEL || '').trim().toLowerCase();
  if (forced === 'stable' || forced === 'dev') return forced;
  let branch = process.env.CF_PAGES_BRANCH || git('rev-parse --abbrev-ref HEAD');
  if (branch === 'HEAD') {
    // Detached: a checkout of an exact release tag counts as stable.
    branch = git('describe --tags --exact-match') ? 'main' : 'detached';
  }
  return branch === 'main' ? 'stable' : 'dev';
}
