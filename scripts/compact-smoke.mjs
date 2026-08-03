// Live /compact smoke: builds a synthetic large session, then compacts it
// (real model summary) and reports before/after token counts.
import { SessionStore } from '../dist/src/session/store.js';
import { loadConfig } from '../dist/src/config/config.js';
import { Runner } from '../dist/src/cli/runner.js';

const config = loadConfig();
const store = new SessionStore(config.sessionsDir);
const id = store.create('compact-smoke');
for (let i = 0; i < 45; i++) {
  store.append(id, {
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    content:
      '壓縮測試內容，包含重要資訊與檔案路徑 c:/Repos/ringzero/package.json 以及若干決策記錄，供壓縮器參考。'.repeat(
        8,
      ),
    ts: i,
  });
}
const runner = new Runner(config, { sessionId: id });
await runner.init();
const before = runner.estimateContext();
const res = await runner.compact();
const after = runner.estimateContext();
console.log(`before=${before} tokens`);
console.log('result:', res);
console.log(`after=${after} tokens`);
process.exit(0);
