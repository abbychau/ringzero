import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetFor, compareVersions, detectInstall } from '../src/cli/update.js';

test('compareVersions', () => {
  assert.equal(compareVersions('0.4.1', '0.4.1'), 0);
  assert.equal(compareVersions('v0.4.1', '0.4.1'), 0);
  assert.equal(compareVersions('0.4.0', '0.4.1'), -1);
  assert.equal(compareVersions('0.5.0', '0.4.9'), 1);
  assert.equal(compareVersions('0.4.1', '0.4'), 1); // ragged lengths
  assert.equal(compareVersions('0.4', '0.4.1'), -1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1); // numeric, not lexicographic
});

test('assetFor picks the built assets per platform/arch', () => {
  assert.deepEqual(assetFor('win32', 'x64'), { name: 'ringzero-win-x64.exe', kind: 'exe' });
  assert.equal(assetFor('win32', 'arm64'), null);
  assert.deepEqual(assetFor('darwin', 'arm64'), {
    name: 'ringzero-darwin-arm64.zip',
    kind: 'zip',
  });
  assert.equal(assetFor('darwin', 'x64'), null);
  assert.deepEqual(assetFor('linux', 'x64'), { name: 'ringzero-linux-x64.zip', kind: 'zip' });
  assert.equal(assetFor('linux', 'arm64'), null);
  assert.equal(assetFor('freebsd', 'x64'), null);
});

test('detectInstall returns unknown when not running from a portable install', () => {
  // The test runner runs from a system Node with no sibling app dir → unknown.
  assert.equal(detectInstall().kind, 'unknown');
});
