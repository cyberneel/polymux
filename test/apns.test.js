import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'apns-'));
process.env.POLYMUX_APNS_FILE = join(dir, 'apns.json');
const { config } = await import('../src/config.js');
const { registerDevice, bearer } = await import('../src/apns.js');

test('the provider token is an ES256 JWT Apple can verify, reused within the hour', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(join(dir, 'key.p8'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  Object.assign(config.apns, { keyId: 'KEY123', key: join(dir, 'key.p8'), teamId: 'TEAM456' });
  const t = await bearer(1_000_000);
  const [h, p, s] = t.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY123' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: 'TEAM456', iat: 1000 });
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(await bearer(1_000_000 + 49 * 60e3), t);
  assert.notEqual(await bearer(1_000_000 + 51 * 60e3), t);
});

test('a device registers once per token; junk is refused', async () => {
  const d = { token: 'ab'.repeat(32), bundleId: 'XTL-AC0E5627.com.cyberneel.polymux', environment: 'sandbox' };
  await registerDevice(d);
  await registerDevice({ ...d, environment: 'production' });
  const saved = JSON.parse(readFileSync(process.env.POLYMUX_APNS_FILE, 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].environment, 'production');
  for (const junk of [{ ...d, token: 'zz' }, { ...d, bundleId: '' }, { ...d, bundleId: 'a/b' }, { ...d, environment: 'dev' }]) {
    await assert.rejects(registerDevice(junk), { statusCode: 400 });
  }
});
