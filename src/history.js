import { createReadStream, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readdir, stat, open } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { config } from './config.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Claude encodes a session's cwd into its project-dir name by replacing every
// `/` with `-`. Precompute the encoded form of each excluded dir so we can skip
// whole project directories (the dir itself or any subdirectory) without reading
// a single transcript — and before the result cap, so excluded churn can't push
// real sessions out of the list.
const EXCLUDED_ENCODED = config.excludeDirs.map((d) => d.replace(/\//g, '-'));
export function isExcludedProjectDir(name) {
  return EXCLUDED_ENCODED.some((enc) => name === enc || name.startsWith(enc + '-'));
}
const SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/;
const MAX_RESULTS = 80;

export function isSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

// Claude records its session name as `custom-title` (set via /rename) and an
// auto-generated `ai-title` (a short description) in the transcript. The latest
// of these is the right display name. They live near the end of the file, so we
// read just the tail rather than the whole (possibly huge) transcript.
async function readTailTitles(file, size, bytes = 49152) {
  let text = '';
  try {
    const fh = await open(file, 'r');
    try {
      const start = Math.max(0, size - bytes);
      const len = size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return {};
  }
  let customTitle = null;
  let aiTitle = null;
  let permissionMode = null;
  let cwd = null;
  const enc = basename(dirname(file)); // project-dir name = the cwd Claude resumes from, encoded
  for (const line of text.split('\n')) {
    // Latest cwd that still encodes to this project dir: a repo moved from a/b-c to
    // a/b/c keeps the same dir name, so the head's (old) cwd no longer exists.
    for (const m of line.matchAll(/"cwd":"([^"]+)"/g)) if (m[1].replace(/\//g, '-') === enc) cwd = m[1];
    if (line.includes('"customTitle"')) {
      try { const v = JSON.parse(line).customTitle; if (v) customTitle = v; } catch { /* partial line */ }
    } else if (line.includes('"aiTitle"')) {
      try { const v = JSON.parse(line).aiTitle; if (v) aiTitle = v; } catch { /* */ }
    }
    // permissionMode appears on many line types; cheap regex grabs the latest.
    const pm = line.match(/"permissionMode":"([a-zA-Z]+)"/);
    if (pm) permissionMode = pm[1];
  }
  return { customTitle, aiTitle, permissionMode, cwd };
}

// Read cwd, git branch, first user prompt, and any title lines from the head.
function readHead(file) {
  return new Promise((resolve) => {
    let cwd = '', gitBranch = '', firstPrompt = '', customTitle = null, aiTitle = null, permissionMode = null, lines = 0;
    const r = () => resolve({ cwd, gitBranch, firstPrompt, customTitle, aiTitle, permissionMode });
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    const finish = () => { rl.close(); r(); };
    rl.on('line', (line) => {
      if (!line) return;
      if (++lines > 400) return finish(); // head only, but scan all 400 (titles appear early)
      let o; try { o = JSON.parse(line); } catch { return; }
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
      if (o.permissionMode) permissionMode = o.permissionMode;
      if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle;
      else if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
      if (!firstPrompt && o.type === 'user' && o.isSidechain !== true && o.message) {
        const text = contentToText(o.message.content);
        if (text && !isNoise(text)) firstPrompt = text.replace(/\s+/g, ' ').trim().slice(0, 140);
      }
    });
    rl.on('close', r);
    rl.on('error', r);
  });
}

// `claude -p` runs (eval judges, scripts, Friday's harnesses) save transcripts too. They're
// one-shot, not sessions anyone resumes, and they outnumber real ones ~6:1 — so they're
// skipped before the result cap (else they push real sessions out, and a search can
// "resume" a judge run whose prompt happens to name the session you meant).
const headlessCache = new Map(); // file -> { key, headless }
export function isHeadless(file, s) {
  const key = `${s.mtimeMs}:${s.size}`;
  const c = headlessCache.get(file);
  if (c && c.key === key) return c.headless;
  return new Promise((resolve) => {
    let lines = 0, done = false;
    const input = createReadStream(file, { encoding: 'utf8' });
    const rl = createInterface({ input, crlfDelay: Infinity });
    const finish = (v) => {
      if (done) return;
      done = true; headlessCache.set(file, { key, headless: v }); rl.close(); input.destroy(); resolve(v);
    };
    rl.on('line', (line) => {
      const m = line.match(/"entrypoint":"([^"]+)"/); // sdk-cli / sdk-ts / sdk-py; interactive = cli
      if (m) finish(m[1].startsWith('sdk-'));
      else if (++lines > 60) finish(false);
    });
    rl.on('close', () => finish(false));
    rl.on('error', () => finish(false));
  });
}

const metaCache = new Map(); // file -> { key, meta }

// Cheap cached meta (cwd, branch, title, mode) for one transcript: head + tail only,
// keyed by mtime:size — so callers needing just a cwd don't full-parse a 300MB file.
export async function transcriptMeta(file, s) {
  s = s || await stat(file);
  const key = `${s.mtimeMs}:${s.size}`;
  let meta = metaCache.get(file);
  if (!meta || meta.key !== key) {
    meta = { key, ...(await extractMeta(file, s.size)) };
    metaCache.set(file, meta);
  }
  return meta;
}

async function extractMeta(file, size) {
  const [head, tail] = await Promise.all([readHead(file), readTailTitles(file, size)]);
  // Prefer the latest title (tail) over an early one (head); custom over ai.
  const name =
    tail.customTitle || head.customTitle || tail.aiTitle || head.aiTitle || head.firstPrompt || '';
  return { cwd: tail.cwd || head.cwd, gitBranch: head.gitBranch, title: name, mode: tail.permissionMode || head.permissionMode || null };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ');
  }
  return '';
}

function isNoise(text) {
  return (
    /^\s*<(command-name|command-message|local-command|user-memory)/.test(text) ||
    /^\s*Caveat: The messages below/.test(text) ||
    /^\s*\[Request interrupted/.test(text) ||
    text.trim().length === 0
  );
}

// Live name + permission mode for an active session, from the latest lines of its
// transcript (path derived from cwd + id). Cached by mtime so polling is cheap.
const liveMetaCache = new Map();
export async function claudeLiveMeta(cwd, sessionId) {
  if (!cwd || !isSessionId(sessionId)) return {};
  const file = join(PROJECTS_DIR, cwd.replace(/\//g, '-'), `${sessionId}.jsonl`);
  let s;
  try { s = await stat(file); } catch { return {}; }
  const key = `${s.mtimeMs}:${s.size}`;
  const cached = liveMetaCache.get(file);
  if (cached && cached.key === key) return cached.meta;
  const { customTitle, aiTitle, permissionMode } = await readTailTitles(file, s.size);
  const meta = { title: customTitle || aiTitle || null, mode: permissionMode || null };
  liveMetaCache.set(file, { key, meta });
  return meta;
}

export async function listHistory() {
  let projectDirs;
  try {
    projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { sessions: [], truncated: false };
  }

  const files = [];
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    if (isExcludedProjectDir(d.name)) continue;
    const dir = join(PROJECTS_DIR, d.name);
    let entries;
    try { entries = await readdir(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -6);
      if (!isSessionId(id)) continue;
      const full = join(dir, name);
      let s;
      try { s = await stat(full); } catch { continue; }
      if (s.size < 200 || await isHeadless(full, s)) continue;
      files.push({ id, file: full, mtime: s.mtimeMs, size: s.size });
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const truncated = files.length > MAX_RESULTS;
  const top = files.slice(0, MAX_RESULTS);

  const sessions = await Promise.all(
    top.map(async (f) => {
      const meta = await transcriptMeta(f.file, { mtimeMs: f.mtime, size: f.size });
      return {
        sessionId: f.id,
        cwd: meta.cwd || '',
        gitBranch: meta.gitBranch || '',
        title: meta.title || '(untitled session)',
        mode: meta.mode || null,
        lastModified: f.mtime,
        sizeKb: Math.round(f.size / 1024),
      };
    }),
  );

  return { sessions, truncated, total: files.length };
}

// Rows of a CLI's own sqlite index, opened read-only; none if it isn't there.
function indexRows(file, sql) {
  let db;
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare(sql).all();
  } catch { return []; } finally { db?.close(); }
}

// Codex and agy can't be renamed from outside (no /rename), so the name a tile carries is kept here
// by conversation id, and Resume shows it over the CLI's own title.
const TITLES = join(homedir(), '.claude', 'cc-deck', 'cli-titles.json');
let titles;
const cliTitles = () => (titles ??= (() => { try { return JSON.parse(readFileSync(TITLES, 'utf8')); } catch { return {}; } })());
export function keepCliTitles(sessions) {
  const t = cliTitles();
  const named = sessions.filter((s) => (s.kind === 'codex' || s.kind === 'agy') && s.liveSessionId
    && s.title && s.title !== s.name.slice(config.prefix.length) && t[s.liveSessionId] !== s.title);
  if (!named.length) return;
  for (const s of named) t[s.liveSessionId] = s.title;
  try { mkdirSync(dirname(TITLES), { recursive: true }); writeFileSync(TITLES, JSON.stringify(t)); } catch { /* next poll retries */ }
}

// Past Codex and agy conversations, from each CLI's own index (title, folder, last change), so a
// closed tile resumes like a Claude one. Interactive ones only (no `codex exec` or agy subagent
// runs), in folders a session can open.
export async function cliHistory() {
  const past = (kind, id, cwd, title, at, gitBranch = '') =>
    ({ sessionId: id, kind, cwd: cwd || '', gitBranch: gitBranch || '', title: cliTitles()[id] || title || '(untitled session)', mode: null, lastModified: at || 0, sizeKb: 0 });
  const agy = indexRows(join(homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
    `SELECT conversation_id id, title, workspace_uris ws, last_modified_time t FROM conversation_summaries
     WHERE nesting_depth = 0 ORDER BY last_modified_time DESC LIMIT ${MAX_RESULTS}`)
    .map((r) => {
      let cwd = '';
      try { cwd = fileURLToPath(JSON.parse(r.ws)[0]); } catch { /* no folder */ }
      return past('agy', r.id, cwd, r.title, Date.parse(r.t));
    });
  // Codex numbers its state db by schema (state_5.sqlite): the highest is the live one.
  const dir = join(homedir(), '.codex');
  const state = (await readdir(dir).catch(() => [])).filter((f) => /^state_\d+\.sqlite$/.test(f))
    .sort((a, b) => parseInt(b.slice(6)) - parseInt(a.slice(6)))[0];
  const codex = state ? indexRows(join(dir, state),
    `SELECT id, coalesce(nullif(name, ''), title) title, cwd, git_branch b, coalesce(updated_at_ms, updated_at * 1000) t FROM threads
     WHERE source = 'cli' AND archived = 0 ORDER BY t DESC LIMIT ${MAX_RESULTS}`)
    .map((r) => past('codex', r.id, r.cwd, r.title, r.t, r.b)) : [];
  return [...agy, ...codex].filter((s) => s.cwd && config.roots.some((r) => s.cwd === r || s.cwd.startsWith(r + '/')));
}
