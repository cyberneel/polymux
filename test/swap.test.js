import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A private tmux server, a scratch HOME and fake CLIs: nothing touches the real Polymux.
const dir = mkdtempSync(join(tmpdir(), 'ccdeck-swap-'));
process.env.HOME = dir;
process.env.POLYMUX_ROOTS = dir;
process.env.POLYMUX_TMUX_SOCKET = `ccdeck-swap-${process.pid}`;
process.env.POLYMUX_TURN_TELEMETRY = 'off';
// Stands in for a CLI: logs its argv and each line typed into it, behind a prompt Polymux knows.
writeFileSync(join(dir, 'cli.cjs'), `
const fs = require('fs'); const log = (l) => fs.appendFileSync(${JSON.stringify(dir)} + '/cli.log', l + '\\n');
log('argv:' + process.argv.slice(2).join(' '));
process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\\u276f ');
let buf = ''; process.stdin.on('data', (d) => { buf += d; if (buf.includes('\\r')) { log('line:' + buf.replace(/\\r/g, '')); buf = ''; } });`);
process.env.POLYMUX_LAUNCH = `node ${join(dir, 'cli.cjs')} claude`;
process.env.POLYMUX_CODEX_LAUNCH = `node ${join(dir, 'cli.cjs')} codex`;

const { rankStandIns, standIn, mergeBack } = await import('../src/swap.js');
const { listSessions } = await import('../src/tmux.js');
const tmux = (...a) => execFileSync('tmux', ['-L', process.env.POLYMUX_TMUX_SOCKET, ...a], { stdio: 'pipe' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => (existsSync(join(dir, 'cli.log')) ? readFileSync(join(dir, 'cli.log'), 'utf8') : '');
async function until(re) {
  for (let i = 0; i < 40 && !re.test(log()); i++) await sleep(250);
  assert.match(log(), re);
}

test('stand-ins: Publik only when opted in and last; a spent CLI never', () => {
  const all = ['claude', 'codex', 'agy', 'publik'].map((kind) => ({ kind }));
  const burn = (u) => ({ available: true, limits: { session: { utilization: u }, weekly: { utilization: 0.2 } } });
  assert.deepEqual(rankStandIns(all, [], burn(0.1), { publik: false }), ['claude', 'codex', 'agy']);
  assert.deepEqual(rankStandIns(all, [], burn(0.97), { publik: true }), ['codex', 'agy', 'publik']);
  assert.deepEqual(rankStandIns(all, [{ kind: 'codex', outOfUsage: 'limit' }], burn(0.97), { publik: false }), ['agy']);
  assert.deepEqual(rankStandIns([{ kind: 'codex', gate: 'setup' }, { kind: 'agy' }], [], null, { publik: false }), ['agy']);
});

test('stand-in and back keep the tile and the original conversation id', async (t) => {
  const name = 'ccdeck-swap1', main = '11111111-2222-4333-8444-555555555555';
  tmux('new-session', '-d', '-s', name, '-x', '140', '-y', '30', '-c', dir);
  tmux('set-option', '-t', name, '@ccdeck_dir', dir);
  tmux('set-option', '-t', name, '@ccdeck_kind', 'codex');
  tmux('set-option', '-t', name, '@ccdeck_title', 'Fix the parser');
  t.after(() => { try { tmux('kill-server'); } catch {} });

  // Codex ran out: Claude carries on in the same tile, told where the transcript is.
  await standIn({ name, kind: 'codex', liveSessionId: main, transcript: '/x/rollout.jsonl', dir, title: 'Fix the parser' }, 'claude');
  await until(/line:.*rollout\.jsonl/);
  assert.match(log(), /^argv:claude /m);
  assert.doesNotMatch(log(), /argv:claude.*--resume/); // a fresh conversation: Codex's can't be resumed by Claude
  let [s] = await listSessions();
  assert.equal(s.name, name);
  assert.equal(s.title, 'Fix the parser');
  assert.equal(s.kind, 'claude');
  assert.equal(s.resumedFrom, main); // Friday's links find it by this id
  assert.deepEqual({ from: s.swap.from, main: s.swap.main, until: s.swap.until }, { from: 'codex', main, until: null });

  // Back: Codex resumes its own conversation and is told what happened meanwhile.
  await mergeBack(s);
  await until(/argv:codex resume 11111111/);
  await until(/line:I'm back on my plan.*back-ccdeck-swap1-/);
  [s] = await listSessions();
  assert.equal(s.kind, 'codex');
  assert.equal(s.resumedFrom, main);
  assert.equal(s.swap, null);
});
