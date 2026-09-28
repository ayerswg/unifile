import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmpSemver, newerBuild, remoteBuild, formatBuild, formatCommitAt, BUILD } from '../src/core/build-info.js';

const stable = { version: '0.4.3', commit: 'aaaaaaa', commitAt: '2026-09-01T10:00:00Z', channel: 'stable' };
const dev    = { ...stable, channel: 'dev' };

test('BUILD falls back sanely outside a build', () => {
  assert.equal(BUILD.version, '0.0.0');
  assert.equal(BUILD.channel, 'stable');
});

test('cmpSemver: SemVer 2.0 precedence', () => {
  assert.equal(cmpSemver('0.4.3', '0.4.3'), 0);
  assert.equal(cmpSemver('v0.4.4', '0.4.3'), 1);
  assert.equal(cmpSemver('0.4.3', '0.5.0'), -1);
  assert.equal(cmpSemver('1.0.0', '1.0.0-rc.2'), 1);      // release outranks its RCs
  assert.equal(cmpSemver('1.0.0-rc.2', '1.0.0-rc.1'), 1);
  assert.equal(cmpSemver('1.0.0-rc.1', '1.0.0-rc.1.1'), -1); // shorter set ranks lower
  assert.equal(cmpSemver('1.0.0-alpha', '1.0.0-1'), 1);   // numeric < alphanumeric
});

test('remoteBuild: normalises version.json (latest wins, old files tolerated)', () => {
  assert.deepEqual(remoteBuild({ version: '0.4.3', stable: '0.4.3', latest: '0.5.0-rc.1', released: 'x' }),
    { version: '0.5.0-rc.1', built: 'x', commit: '', commitAt: '', channel: '' });
  assert.equal(remoteBuild({ version: '0.4.3', commit: 'bbbbbbb', commitAt: '2026-09-02T00:00:00Z', channel: 'dev' }).commit, 'bbbbbbb');
  assert.equal(remoteBuild(null).version, '');
});

test('stable channel: only a version bump is an update', () => {
  assert.equal(newerBuild({ version: '0.4.4' }, stable), 'version');
  assert.equal(newerBuild({ version: '0.4.3', commit: 'bbbbbbb', commitAt: '2026-09-02T00:00:00Z' }, stable), null);
  assert.equal(newerBuild({ version: '0.4.2', commit: 'bbbbbbb', commitAt: '2026-09-02T00:00:00Z' }, stable), null);
  assert.equal(newerBuild(null, stable), null);
});

test('dev channel: a later commit is an update, regardless of the tag', () => {
  const later   = { version: '0.4.3', commit: 'bbbbbbb', commitAt: '2026-09-02T00:00:00Z' };
  const earlier = { version: '0.4.3', commit: 'ccccccc', commitAt: '2026-08-30T00:00:00Z' };
  assert.equal(newerBuild(later, dev), 'commit');
  assert.equal(newerBuild({ ...later, version: '0.4.0' }, dev), 'commit');   // tag ignored on dev
  assert.equal(newerBuild(earlier, dev), null);                              // never bounce backwards
  assert.equal(newerBuild({ ...later, commit: 'aaaaaaa' }, dev), null);      // same commit = current
  assert.equal(newerBuild({ version: '0.4.3' }, dev), null);                 // no commit to compare
  assert.equal(newerBuild({ version: '0.4.4', commit: 'aaaaaaa' }, dev), 'version');
  // Older version.json without commitAt (first deploy of this scheme): a
  // different hash still counts, since there is no time to rank it by.
  assert.equal(newerBuild({ version: '0.4.3', commit: 'bbbbbbb' }, dev), 'commit');
});

test('formatBuild / formatCommitAt', () => {
  assert.equal(formatCommitAt('2026-09-28T10:12:33Z'), '2026-09-28 10:12Z');
  assert.equal(formatCommitAt(''), '');
  assert.equal(formatBuild(stable), 'v0.4.3');
  assert.equal(formatBuild(dev), 'aaaaaaa (2026-09-01 10:00Z)');
  assert.equal(formatBuild(dev, { version: true }), 'aaaaaaa (2026-09-01 10:00Z) · v0.4.3');
  assert.equal(formatBuild(stable, { commit: true }), 'aaaaaaa (2026-09-01 10:00Z)');
  assert.equal(formatBuild({ ...dev, commitAt: '' }), 'aaaaaaa');
  assert.equal(formatBuild({ ...dev, commit: '' }), 'v0.4.3');
});
