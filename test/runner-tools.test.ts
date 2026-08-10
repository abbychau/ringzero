/** Runner tool-roster tests: /tools toggle must keep disabled tools listed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { Runner } from '../src/cli/runner.js';

test('listTools keeps disabled tools in the roster after toggling off', () => {
  // Point home + cwd at temp dirs so setToolEnabled's savePrefs never touches
  // the real ~/.ringzero or a repo-local .ringzero config.
  const tmp = mkdtempSync(join(tmpdir(), 'rz-tools-'));
  const oldCwd = process.cwd();
  const oldHome = process.env.RINGZERO_HOME;
  try {
    process.env.RINGZERO_HOME = join(tmp, 'home');
    mkdirSync(join(tmp, 'proj'), { recursive: true });
    process.chdir(join(tmp, 'proj'));
    const config = loadConfig();
    const runner = new Runner(config, { model: 'test-model', ask: async () => 'no' as const });

    const before = runner.listTools();
    assert.ok(before.length > 0, 'expected a non-empty tool roster');
    const target = before[0]!;
    assert.equal(target.enabled, true);

    // Toggle OFF: the tool must stay listed, now marked disabled.
    assert.equal(runner.setToolEnabled(target.name, false), true);
    const disabled = runner.listTools().find((t) => t.name === target.name);
    assert.ok(disabled, `tool "${target.name}" disappeared after toggling off`);
    assert.equal(disabled!.enabled, false);

    // Toggle back ON: listed again as enabled.
    assert.equal(runner.setToolEnabled(target.name, true), true);
    const restored = runner.listTools().find((t) => t.name === target.name);
    assert.ok(restored, `tool "${target.name}" missing after re-enabling`);
    assert.equal(restored!.enabled, true);
  } finally {
    if (oldHome === undefined) delete process.env.RINGZERO_HOME;
    else process.env.RINGZERO_HOME = oldHome;
    process.chdir(oldCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});
