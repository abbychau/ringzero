import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, walkFiles, isBinaryBuf } from '../src/tools/fsutil.js';

test('glob matches windows-style relative paths', () => {
  const re = globToRegExp('**/*.ts');
  assert.ok(re.test('src\\kernel\\types.ts'));
  assert.ok(re.test('test\\foo.test.ts'));
  assert.ok(re.test('src/kernel/types.ts'));
  assert.ok(!re.test('README.md'));
});

test('glob **/* matches any file under a separator', () => {
  const re = globToRegExp('**/*');
  assert.ok(re.test('src\\kernel\\types.ts'));
  assert.ok(re.test('package.json')); // `.*` can be empty, `[^/\\]*` matches name
});

test('glob * does not cross directories', () => {
  const re = globToRegExp('*.ts');
  assert.ok(re.test('a.ts'));
  assert.ok(!re.test('src\\a.ts'));
});

test('walkFiles lists files and skips ignored dirs', () => {
  const files = walkFiles(process.cwd());
  assert.ok(files.length > 0);
  assert.ok(files.some((f) => f.endsWith('package.json')));
  assert.ok(!files.some((f) => f.includes('node_modules')));
});

test('isBinaryBuf detects null bytes', () => {
  assert.equal(isBinaryBuf(Buffer.from('hello')), false);
  assert.equal(isBinaryBuf(Buffer.from([1, 2, 0, 3])), true);
});
