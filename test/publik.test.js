import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'publik-test-'));
Object.assign(process.env, { HOME: home, POLYMUX_SECRET: 's' });
const { fold, sessionToken, registerPublikRoute } = await import('../src/publik.js');
const { default: Fastify } = await import('fastify');

test('fold moves system messages into the system prompt and maps models', () => {
  const b = fold({ model: 'claude-opus-4-8', system: 'base', messages: [
    { role: 'user', content: 'hi' },
    { role: 'system', content: [{ type: 'text', text: 'env' }] },
    { role: 'system', content: 'more' },
  ] });
  assert.equal(b.model, 'publik-smart');
  assert.equal(b.messages.length, 1);
  assert.deepEqual(b.system.map((x) => x.text), ['base', 'env', 'more']);
  for (const [m, want] of [['haiku', 'publik-fast'], ['sonnet', 'publik-balanced'], ['publik-fast', 'publik-fast']]) {
    const o = fold({ model: m, messages: [] });
    assert.equal(o.model, want);
    assert.equal(o.system, undefined);
  }
});

test('route: per-session token, key from ~/.publik/key, folded body', async () => {
  const app = Fastify();
  registerPublikRoute(app);
  const body = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'env' }] };
  const call = (tok, name = 'pm-a') => app.inject({ method: 'POST', url: `/publik/${name}/v1/messages?beta=true`, headers: { authorization: `Bearer ${tok}`, 'anthropic-version': '2023-06-01' }, payload: body });

  assert.equal((await call('nope')).statusCode, 401);
  assert.equal((await call(sessionToken('pm-b'))).statusCode, 401); // another session's token
  assert.match((await call(sessionToken('pm-a'))).body, /isn't connected/); // no key yet

  mkdirSync(join(home, '.publik'));
  writeFileSync(join(home, '.publik', 'key'), 'pk_test_x\n');
  const sent = [];
  mock.method(globalThis, 'fetch', async (url, o) => {
    sent.push({ url, o });
    return new Response('{"ok":1}', { status: 200, headers: { 'x-publik-charge-micros': '1500', 'content-type': 'application/json' } });
  });
  const r = await call(sessionToken('pm-a'));
  mock.restoreAll();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, '{"ok":1}');
  assert.equal(sent[0].url, 'https://publikhq.com/api/v1/messages?beta=true');
  assert.equal(sent[0].o.headers.authorization, 'Bearer pk_test_x');
  assert.equal(sent[0].o.headers['anthropic-version'], '2023-06-01');
  const fwd = JSON.parse(sent[0].o.body);
  assert.equal(fwd.model, 'publik-fast');
  assert.deepEqual(fwd.system, [{ type: 'text', text: 'env' }]);
});
