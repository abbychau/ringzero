import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, checkUrlAllowed } from '../src/tools/web.js';

test('isPrivateIp: IPv4 private/loopback/reserved ranges', () => {
  const priv = [
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254', // cloud metadata endpoint
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1', // CGNAT
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1', // multicast
    '240.0.0.1', // reserved
    '255.255.255.255',
  ];
  for (const ip of priv) assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  const pub = [
    '8.8.8.8',
    '1.1.1.1',
    '9.9.9.9',
    '172.32.0.1',
    '192.0.3.1',
    '198.17.0.1',
    '203.0.114.1',
  ];
  for (const ip of pub) assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
});

test('isPrivateIp: IPv6 loopback/ULA/link-local/multicast/documentation', () => {
  const priv = [
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1', // multicast
    '2001:db8::1', // documentation
    '::ffff:127.0.0.1', // v4-mapped loopback
    '::ffff:10.0.0.5', // v4-mapped private
    '64:ff9b::127.0.0.1', // NAT64 embedded loopback
    '[::1]', // bracketed form
  ];
  for (const ip of priv) assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  const pub = ['2001:4860:4860::8888', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8'];
  for (const ip of pub) assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
});

test('checkUrlAllowed blocks literal private addresses and invalid URLs', async () => {
  assert.match((await checkUrlAllowed('http://127.0.0.1/'))!, /private network/);
  assert.match((await checkUrlAllowed('http://10.0.0.5:8080/x'))!, /private network/);
  assert.match((await checkUrlAllowed('http://[::1]/'))!, /private network/);
  assert.match((await checkUrlAllowed('not a url'))!, /invalid URL/);
  assert.match((await checkUrlAllowed('ftp://example.com/'))!, /only http\(s\)/);
  assert.equal(
    await checkUrlAllowed('https://example.com/'),
    null,
    'public URL without DNS should pass',
  );
});

test('checkUrlAllowed blocks localhost (resolves to loopback)', async () => {
  const res = await checkUrlAllowed('http://localhost/');
  assert.ok(res !== null, 'localhost should be blocked');
  assert.match(res, /private (network|address)/);
});

test('checkUrlAllowed honors RINGZERO_ALLOW_PRIVATE_NET override', async () => {
  process.env.RINGZERO_ALLOW_PRIVATE_NET = '1';
  try {
    assert.equal(await checkUrlAllowed('http://127.0.0.1/'), null);
    assert.equal(await checkUrlAllowed('http://10.0.0.5/'), null);
  } finally {
    delete process.env.RINGZERO_ALLOW_PRIVATE_NET;
  }
});
