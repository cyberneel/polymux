import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No secret set: one is generated on first run, saved 0600, and the next start reuses it.
// Empty (not deleted) so a .env in the cwd can't fill them in.
Object.assign(process.env, { POLYMUX_SECRET: '', CCDECK_SECRET: '' });
process.env.POLYMUX_SECRET_FILE = join(mkdtempSync(join(tmpdir(), 'polymux-secret-')), 'deck', 'secret');

test('secret: generated once, kept private, reused on restart', async () => {
  const { config } = await import('../src/config.js');
  assert.match(config.secret, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(process.env.POLYMUX_SECRET_FILE, 'utf8').trim(), config.secret);
  assert.equal(statSync(process.env.POLYMUX_SECRET_FILE).mode & 0o777, 0o600);
  const again = await import('../src/config.js?restart');
  assert.equal(again.config.secret, config.secret);
});
