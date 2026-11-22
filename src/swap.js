// Auto-continue (task-722). A session whose turn stopped on a spent plan carries on, in the same
// tile, on the connected CLI with the most plan left. When the original plan is back and the
// stand-in is idle, the original conversation resumes with what the stand-in did typed in.
// The session answers to its original conversation id throughout (@ccdeck_resume, and
// list_sessions' session_id), so Friday's links, watches, pip and relay never see the swap.
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { availableProviders, getProvider, runsClaude } from './providers/index.js';
import { getBurn } from './burn.js';
import { relaunch } from './tmux.js';
import { swr } from './swr.js';
import { config } from './config.js';
import { buildHandoffFile, summarize } from './handoff.js';

const exec = promisify(execFile);
const DIR = join(homedir(), '.claude', 'cc-deck');
const PREFS = join(DIR, 'auto-continue.json');
const FULL = 0.95; // a plan window this used counts as spent

// auto: continue on its own when a plan runs out. publik: may use Publik for it (it bills per
// turn, so off until the user turns it on).
let prefsP = null;
export function prefs() {
  prefsP ||= readFile(PREFS, 'utf8').then((t) => ({ auto: true, publik: false, ...JSON.parse(t) }), () => ({ auto: true, publik: false }));
  return prefsP;
}
export async function setPrefs(p) {
  const next = { ...(await prefs()) };
  for (const k of ['auto', 'publik']) if (typeof p?.[k] === 'boolean') next[k] = p[k];
  await mkdir(DIR, { recursive: true });
  await writeFile(PREFS, JSON.stringify(next));
  prefsP = Promise.resolve(next);
  return next;
}

const label = (k) => getProvider(k).label;

// Each CLI's plan as its windows, [{ used: 0-1, resets: ms }], or null when it can't tell.
// A window past its reset reads as unused, so an old reading never keeps a plan spent.
const win = (used, resets) => ({ used: resets > Date.now() ? used : 0, resets });
const isSpent = (ws) => ws?.some((w) => w.used >= FULL);
// Codex writes its account's limits into every rollout: the newest one has the latest.
export const codexWindows = (rl) => [rl?.primary, rl?.secondary].filter((w) => w?.resets_at).map((w) => win((w.used_percent || 0) / 100, w.resets_at * 1000));
// agy's /usage prints one tab-separated row per bucket: family, window, "94%" left, ISO reset.
export const agyWindows = (text) => text.split('\n').map((l) => l.split('\t'))
  .filter((c) => c.length >= 4 && /^\d+%$/.test(c[2].trim()))
  .map((c) => win(1 - parseInt(c[2], 10) / 100, Date.parse(c[3].trim())));
const some = (ws) => (ws?.length ? ws : null);
const PLANS = {
  claude: swr(async () => {
    const b = await getBurn();
    return b?.available ? some([b.limits?.session, b.limits?.weekly, ...(b.scopedWeekly || [])].filter(Boolean).map((w) => win(w.utilization || 0, Date.parse(w.resets_at)))) : null;
  }, 60_000),
  codex: swr(async () => {
    const root = join(homedir(), '.codex', 'sessions');
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.jsonl'));
    const times = await Promise.all(files.map((f) => stat(join(root, f)).then((x) => x.mtimeMs, () => 0)));
    const newest = files[times.indexOf(Math.max(...times))];
    if (!newest) return null;
    const fh = await open(join(root, newest));
    try {
      const { size } = await fh.stat(), len = Math.min(size, 512 * 1024), buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        try { return some(codexWindows(JSON.parse(lines[i]).payload?.rate_limits)); } catch { /* cut-off line */ }
      }
      return null;
    } finally { await fh.close(); }
  }, 60_000),
  // ponytail: any spent bucket counts, so a spent Claude/GPT bucket also holds back a Gemini session.
  agy: swr(async () => {
    const [bin, ...args] = config.agyCommand.split(/\s+/);
    return some(agyWindows((await exec(bin, [...args, '--print', '/usage'], { timeout: 30_000 })).stdout));
  }, 3 * 60_000),
};
const plan = (kind) => (PLANS[kind] ? PLANS[kind]().catch(() => null) : Promise.resolve(null));

// A limit notice counts while its CLI's plan reads spent or can't tell, or while it's fresh (the
// plan readings lag a minute): an old notice with the plan back stays put instead of carrying on
// a request from hours ago.
const isOut = (s, plans) => {
  const ws = plans[s.kind || 'claude'];
  return s.outOfUsage === 'limit' && (!ws || isSpent(ws) || Date.now() - Math.max(s.lastActivity || 0, s.outputAt || 0) < 5 * 60_000);
};

// Kinds that could take over a spent session right now, best first. `plans`: kind -> windows.
export function rankStandIns(providers, sessions, plans, p) {
  const spent = new Set(sessions.filter((x) => isOut(x, plans)).map((x) => x.kind || 'claude'));
  for (const [k, ws] of Object.entries(plans)) if (isSpent(ws)) spent.add(k);
  // By plan left; one that can't tell counts as half; Publik is paid, so last.
  const left = (k) => (plans[k] ? 1 - Math.max(...plans[k].map((w) => w.used)) : k === 'publik' ? 0.1 : 0.5);
  return providers
    .filter((x) => x.gate !== 'setup' && !spent.has(x.kind) && (x.kind !== 'publik' || p.publik))
    .map((x) => x.kind)
    .sort((a, b) => left(b) - left(a));
}

let ready = [], plansNow = {}; // as of the last tick
// name -> until when it stays put: just moved (a resumed transcript still ends on the limit
// notice until the seed lands, up to the summary's 2 min) or a move failed.
const hold = new Map();
const held = (name, ms) => hold.set(name, Date.now() + ms);
const moving = new Set(); // relaunched, its seed not typed in yet
function move(name, opts) {
  moving.add(name);
  return relaunch(name, opts).then(({ booted }) => { booted.finally(() => moving.delete(name)); }, (e) => { moving.delete(name); throw e; });
}
function willContinue(s) {
  return isOut(s, plansNow) && !s.swap && !(hold.get(s.name) > Date.now()) && ready.some((k) => k !== (s.kind || 'claude'));
}
// About to move, or moving and not yet told what to do: it reads as running, so Friday doesn't
// relay the limit notice (or a half-booted CLI) as the session's answer.
export const switching = (s) => moving.has(s.name) || willContinue(s);

// When the original plan is back: the end of its spent windows, or null when its CLI can't
// tell (Publik: the user moves it back).
async function resetAt(from) {
  const ws = await plan(from);
  if (!ws) return null;
  const at = Math.max(0, ...ws.filter((w) => w.used >= FULL).map((w) => w.resets || 0));
  return at || Date.now() + 30 * 60_000; // ponytail: spent but no window reads full: look again in 30 min
}

// Move a spent session onto `kind` in place. The stand-in gets the conversation so far and
// carries on with the request that went unanswered.
// A stand-in that runs out too moves on the same way and keeps the original to go back to.
export async function standIn(s, kind) {
  const cur = s.kind || 'claude', id = s.liveSessionId;
  if (!id) throw Object.assign(new Error('This session has no conversation to continue'), { statusCode: 409 });
  if (kind === s.swap?.from) return mergeBack(s);
  const swap = s.swap || { from: cur, main: id, at: Date.now(), until: await resetAt(cur) };
  held(s.name, 5 * 60_000);
  if (runsClaude(cur) && runsClaude(kind)) { // Claude and Publik share the transcript: same conversation
    await move(s.name, { kind, resume: id, tag: swap.main, swap, seed: 'My plan ran out before you finished the last request. Carry on with it.' });
    return swap;
  }
  const seed = (runsClaude(cur)
    ? buildHandoffFile({ sourceId: id, cwd: s.dir, scope: 'thread', title: s.title }).then((h) => `this handoff of it: ${h.file}`)
    : Promise.resolve(`the end of its transcript: ${s.transcript}`)
  ).then((src) => `I'm taking over a ${label(cur)} session whose plan ran out mid-task. Read ${src} — its last request went unanswered: carry on with it from there.`);
  await move(s.name, { kind, tag: swap.main, swap, seed });
  return swap;
}

// Back to the original CLI and conversation, telling it what the stand-in did.
export async function mergeBack(s) {
  const { from, main, at } = s.swap || {};
  if (!main) throw Object.assign(new Error('This session is on its own plan'), { statusCode: 409 });
  held(s.name, 5 * 60_000);
  // Same transcript family: resume what the stand-in ended on, so its turns come along.
  if (runsClaude(from) && runsClaude(s.kind)) return move(s.name, { kind: from, resume: s.liveSessionId || main, tag: main, swap: null });
  const by = label(s.kind), id = s.liveSessionId, file = join(DIR, 'handoffs', `back-${s.name}-${Date.now().toString(36)}.md`);
  const seed = (async () => {
    let did = '';
    try {
      if (runsClaude(s.kind) && id) did = await readFile((await buildHandoffFile({ sourceId: id, cwd: s.dir, scope: 'summary', title: s.title })).file, 'utf8');
      else if (s.transcript) {
        const text = getProvider(s.kind).messages((await readFile(s.transcript, 'utf8')).split('\n'))
          .map((m) => `${m.role === 'user' ? 'User' : by}: ${m.text}`).join('\n\n').slice(-120_000);
        did = await summarize(text).catch(() => text.slice(-12_000));
      }
    } catch { /* a missing transcript still leaves the git record */ }
    const git = (args) => exec('git', ['-C', s.dir, ...args], { maxBuffer: 1 << 20 }).then((r) => r.stdout.trim(), () => '');
    const commits = await git(['log', `--since=@${Math.floor(at / 1000)}`, '--stat', '--format=%h %s']);
    const open = await git(['status', '--short']);
    await mkdir(join(DIR, 'handoffs'), { recursive: true });
    await writeFile(file, `# While your plan was out\n\n${by} carried on in this session from ${new Date(at).toString()}.\n\n## What it did\n\n${did || '_(no transcript found)_'}\n\n## Commits since\n\n${commits || '_none_'}\n\n## Uncommitted changes\n\n${open || '_none_'}\n`);
    return `I'm back on my plan. While it was out, ${by} carried on in this session: ${file}. Read it, then tell me in one line where things stand.`;
  })();
  return move(s.name, { kind: from, resume: main, tag: main, swap: null, seed });
}

// Each tick: move spent sessions to a stand-in, and originals back once their plan resets.
// ponytail: a stand-in that runs out waits for the user to move it on.
async function tick(sessions) {
  const p = await prefs();
  if (!p.auto) { ready = []; return; }
  const providers = await availableProviders();
  // Plans are read only while a session is out or carried (agy's costs a CLI run); `ready` is
  // kept either way, so a session that just ran out reads as switching straight away.
  const need = sessions.some((s) => s.outOfUsage === 'limit' || s.swap);
  const plans = need ? Object.fromEntries(await Promise.all(providers.map(async (x) => [x.kind, await plan(x.kind)]))) : {};
  plansNow = plans;
  ready = rankStandIns(providers, sessions, plans, p);
  if (!need) return;
  const planBack = (s) => Date.now() >= (s.swap.until || Infinity) && plans[s.swap.from] && !isSpent(plans[s.swap.from]);
  for (const s of sessions) {
    try {
      if (willContinue(s)) await standIn(s, ready.find((k) => k !== (s.kind || 'claude')));
      else if (s.swap && planBack(s) && !moving.has(s.name) && s.claudeStatus === 'idle' && !s.waitingFor && Date.now() - Math.max(s.lastActivity || 0, s.outputAt || 0) > 60_000) await mergeBack(s);
    } catch (e) {
      held(s.name, 10 * 60_000);
      console.warn(`[polymux] auto-continue ${s.name}: ${e.message}`);
    }
  }
}

let running = false;
export function startSwaps(sessions) {
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(await sessions()); } catch { /* next tick */ } finally { running = false; }
  }, 15_000);
}
