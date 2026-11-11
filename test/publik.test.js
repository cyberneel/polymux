import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'publik-test-'));
Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), POLYMUX_SECRET: 's', PUBLIK_ORIGIN: 'https://publik.test', PUBLIK_APP_TOKEN: 'pat_test' });
for (const k of ['PUBLIK_API_KEY', 'DO_NOT_TRACK', 'PUBLIK_TELEMETRY']) delete process.env[k];
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
  assert.match((await call(sessionToken('pm-a'))).body, /isn't set up/); // no key yet

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
  assert.equal(sent[0].url, 'https://publik.test/api/v1/messages?beta=true'); // PUBLIK_ORIGIN (tests); publikhq.com otherwise
  assert.equal(sent[0].o.headers.authorization, 'Bearer pk_test_x');
  assert.equal(sent[0].o.headers['anthropic-version'], '2023-06-01');
  const fwd = JSON.parse(sent[0].o.body);
  assert.equal(fwd.model, 'publik-fast');
  assert.deepEqual(fwd.system, [{ type: 'text', text: 'env' }]);
});

test('Use Publik models: the gate from the browser, then the install key wins; Change can be cancelled', async () => {
  const app = Fastify();
  registerPublikRoute(app);
  const get = async () => (await app.inject({ url: '/api/publik' })).json();
  const post = async (path, body) => (await app.inject({ method: 'POST', url: `/api/publik/${path}`, payload: body || {} })).json();
  const waitFor = async (pred) => {
    for (const end = Date.now() + 8000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) { const st = await get(); if (pred(st)) return st; }
    assert.fail(`timed out; last state ${JSON.stringify(await get())}`);
  };
  let claimed = false;
  const events = [], upstream = [];
  mock.method(globalThis, 'fetch', async (url, o = {}) => {
    const u = String(url);
    if (u === 'https://publik.test/api/v1/installs') return Response.json({ key: 'pk_live_t', install_id: 'i1', claim_url: 'https://publik.test/claim/x', base_url: 'https://publik.test/api/v1' }, { status: 201 });
    if (u === 'https://publik.test/api/v1/wallet') return Response.json(claimed
      ? { claim_state: 'claimed', plan: { kind: 'plan', label: 'Pro' }, balance_micros: 50000, top_up_url: 'https://publik.test/top-up' }
      : { claim_state: 'anonymous', claim_url: 'https://publik.test/claim/x' });
    if (u === 'https://publik.test/api/v1/telemetry') { events.push(JSON.parse(o.body).event); return new Response(null, { status: 204 }); }
    upstream.push({ url: u, auth: o.headers?.authorization });
    return Response.json({ ok: 1 });
  });
  try {
    assert.equal((await get()).state, 'connected'); // ~/.publik/key from the test above
    let st = await post('start');
    assert.equal(st.state, 'gate');
    st = await waitFor((x) => x.screen?.id === 'sign_in');
    assert.equal((await post('action', { action: 'nope' })).error, 'That screen is gone. Try again.');
    st = await post('action', { action: 'sign_in' });
    assert.equal(st.open_url, 'https://publik.test/claim/x');
    claimed = true; // the person signs in in the browser; the gate's 3 s poll sees it
    st = await waitFor((x) => x.screen?.title === 'Connect your plan');
    st = await post('action', { action: 'connect' });
    st = await waitFor((x) => x.state === 'connected');

    const cred = join(home, '.config', 'publik', 'apps', 'polymux.json');
    assert.equal(statSync(cred).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(cred, 'utf8')).choice, 'publik');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(events, ['app_opened']);

    const session = () => app.inject({ method: 'POST', url: '/publik/pm-a/v1/messages', headers: { authorization: `Bearer ${sessionToken('pm-a')}` }, payload: { model: 'sonnet', messages: [] } });
    await session();
    assert.deepEqual(upstream.at(-1), { url: 'https://publik.test/api/v1/messages', auth: 'Bearer pk_live_t' }); // the install key beats ~/.publik/key

    // Change: the choice is asked again; live sessions stay on Publik meanwhile; Cancel restores it.
    await post('start');
    await waitFor((x) => x.screen?.title === 'Connect your plan');
    await session();
    assert.equal(upstream.at(-1).auth, 'Bearer pk_live_t');
    assert.equal((await post('cancel')).state, 'connected');
    assert.equal(JSON.parse(readFileSync(cred, 'utf8')).choice, 'publik');
  } finally { mock.restoreAll(); }
});
