// Live RPC smoke: spawns `ringzero --rpc`, sends initialize/ping/sessions/prompt.
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['dist/src/cli/index.js', '--rpc'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d.toString()));
child.stderr.on('data', (d) => (out += d.toString()));
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
await sleep(300);
send({ jsonrpc: '2.0', id: 2, method: 'ping' });
await sleep(300);
send({ jsonrpc: '2.0', id: 3, method: 'sessions/list' });
await sleep(300);
send({
  jsonrpc: '2.0',
  id: 4,
  method: 'prompt',
  params: { text: '只用一句話回答 2+2=?，不要使用任何工具。' },
});
await sleep(25000);
child.kill();
console.log('=== RPC OUTPUT ===');
console.log(out);
process.exit(0);
