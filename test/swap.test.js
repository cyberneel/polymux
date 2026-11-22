import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

const { rankStandIns, standIn, mergeBack, codexWindows, agyWindows } = await import('../src/swap.js');
const { listSessions } = await import('../src/tmux.js');
const tmux = (...a) => execFileSync('tmux', ['-L', process.env.POLYMUX_TMUX_SOCKET, ...a], { stdio: 'pipe' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => (existsSync(join(dir, 'cli.log')) ? readFileSync(join(dir, 'cli.log'), 'utf8') : '');
async function until(re) {
  for (let i = 0; i < 40 && !re.test(log()); i++) await sleep(250);
  assert.match(log(), re);
}

const soon = Date.now() + 3600_000;
test('stand-ins: by plan left, Publik only when opted in and last, a spent CLI never', () => {
  const all = ['claude', 'codex', 'agy', 'publik'].map((kind) => ({ kind }));
  const claude = (u) => ({ claude: [{ used: u, resets: soon }, { used: 0.2, resets: soon }] });
  assert.deepEqual(rankStandIns(all, [], claude(0.1), { publik: false }), ['claude', 'codex', 'agy']);
  assert.deepEqual(rankStandIns(all, [], claude(0.97), { publik: true }), ['codex', 'agy', 'publik']);
  assert.deepEqual(rankStandIns(all, [{ kind: 'codex', outOfUsage: 'limit' }], claude(0.97), { publik: false }), ['agy']);
  assert.deepEqual(rankStandIns([{ kind: 'codex', gate: 'setup' }, { kind: 'agy' }], [], {}, { publik: false }), ['agy']);
  const plans = { ...claude(0.5), codex: [{ used: 0.1, resets: soon }], agy: [{ used: 0.99, resets: soon }] };
  assert.deepEqual(rankStandIns(all, [], plans, { publik: false }), ['codex', 'claude']);
  // A Claude limit notice from hours ago, with the plan back, no longer counts; a fresh one does.
  assert.deepEqual(rankStandIns(all, [{ kind: 'claude', outOfUsage: 'limit', lastActivity: 1 }], claude(0.1), { publik: false }), ['claude', 'codex', 'agy']);
  assert.deepEqual(rankStandIns(all, [{ kind: 'claude', outOfUsage: 'limit', lastActivity: Date.now() }], claude(0.1), { publik: false }), ['codex', 'agy']);
});

test('plans: Codex rollout limits and agy /usage rows; a window past its reset is unused', () => {
  const at = Math.floor(soon / 1000);
  assert.deepEqual(codexWindows({ primary: { used_percent: 100, resets_at: at }, secondary: { used_percent: 40, resets_at: 1 } }),
    [{ used: 1, resets: at * 1000 }, { used: 0, resets: 1000 }]);
  const iso = new Date(soon).toISOString();
  const rows = agyWindows(`banner\nGemini Models\tFive Hour Limit Remaining\t0%\t${iso}\nClaude and GPT models\tWeekly Limit Remaining\t94%\t${iso}\n`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].used, 1);
  assert.ok(Math.abs(rows[1].used - 0.06) < 1e-9);
  assert.equal(rows[0].resets, Date.parse(iso));
});

test('stand-in and back keep the tile and the original conversation id', async (t) => {
  const name = 'ccdeck-swap1', main = '11111111-2222-4333-8444-555555555555';
  tmux('new-session', '-d', '-s', name, '-x', '140', '-y', '30', '-c', dir);
  tmux('set-option', '-t', name, '@ccdeck_dir', dir);
  tmux('set-option', '-t', name, '@ccdeck_kind', 'codex');
  tmux('set-option', '-t', name, '@ccdeck_title', 'Fix the parser');
  t.after(() => { try { tmux('kill-server'); } catch {} });

  // Codex ran out (its rollout says when its 5-hour window resets): Claude carries on in the same
  // tile, told where the transcript is.
  const resets = Math.floor(soon / 1000) * 1000;
  mkdirSync(join(dir, '.codex/sessions/2026/11/22'), { recursive: true });
  writeFileSync(join(dir, '.codex/sessions/2026/11/22/rollout-x.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
    rate_limits: { primary: { used_percent: 100, resets_at: resets / 1000 }, secondary: { used_percent: 30, resets_at: resets / 1000 + 9e5 } } } }) + '\n');
  await standIn({ name, kind: 'codex', liveSessionId: main, transcript: '/x/rollout.jsonl', dir, title: 'Fix the parser' }, 'claude');
  await until(/line:.*rollout\.jsonl/);
  assert.match(log(), /^argv:claude /m);
  assert.doesNotMatch(log(), /argv:claude.*--resume/); // a fresh conversation: Codex's can't be resumed by Claude
  let [s] = await listSessions();
  assert.equal(s.name, name);
  assert.equal(s.title, 'Fix the parser');
  assert.equal(s.kind, 'claude');
  assert.equal(s.resumedFrom, main); // Friday's links find it by this id
  assert.deepEqual({ from: s.swap.from, main: s.swap.main, until: s.swap.until }, { from: 'codex', main, until: resets });

  // Back: Codex resumes its own conversation and is told what happened meanwhile.
  await mergeBack(s);
  await until(/argv:codex resume 11111111/);
  await until(/line:I'm back on my plan.*back-ccdeck-swap1-/);
  [s] = await listSessions();
  assert.equal(s.kind, 'codex');
  assert.equal(s.resumedFrom, main);
  assert.equal(s.swap, null);
});
