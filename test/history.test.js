import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Transcripts live under ~/.claude/projects: a scratch HOME, so the real ones are never read.
process.env.HOME = mkdtempSync(join(tmpdir(), 'ccdeck-history-'));
process.env.POLYMUX_ROOTS = '/work';
const { listHistory, agyHistory } = await import('../src/history.js');

test('History leaves out `claude -p` runs, even one whose prompt names a session', async () => {
  const dir = join(process.env.HOME, '.claude', 'projects', '-work-cyberdeck');
  mkdirSync(dir, { recursive: true });
  const line = (entrypoint, text) => [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
    JSON.stringify({ type: 'user', entrypoint, cwd: '/work/cyberdeck', message: { role: 'user', content: text } }),
  ].join('\n') + '\n' + 'x'.repeat(200);
  writeFileSync(join(dir, '11111111-1111-1111-1111-111111111111.jsonl'), line('cli', 'Pager firmware: ANCS client'));
  writeFileSync(join(dir, '22222222-2222-2222-2222-222222222222.jsonl'), line('sdk-cli', 'Grade these replies about the CyberDeck session'));
  const h = await listHistory();
  assert.deepEqual(h.sessions.map((s) => s.title), ['Pager firmware: ANCS client']);
  assert.equal(h.total, 1);
});

test('past agy conversations list from its index, only those in a folder a session can open', () => {
  const dir = join(process.env.HOME, '.gemini', 'antigravity-cli');
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(join(dir, 'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries (conversation_id text, title text, workspace_uris text, last_modified_time datetime, nesting_depth integer)');
  const add = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)');
  add.run('aaaaaaaa-0000-4000-8000-000000000001', 'Reel formats', '["file:///work/ideas"]', '2026-11-22 18:21:45.657793569+00:00', 0);
  add.run('aaaaaaaa-0000-4000-8000-000000000002', 'Scratch run', '["file:///tmp/x"]', '2026-11-22 19:00:00+00:00', 0);
  add.run('aaaaaaaa-0000-4000-8000-000000000003', 'Subagent', '["file:///work/ideas"]', '2026-11-22 19:00:00+00:00', 1);
  db.close();
  assert.deepEqual(agyHistory().map((s) => [s.sessionId.slice(-1), s.kind, s.cwd, s.title, s.lastModified]),
    [['1', 'agy', '/work/ideas', 'Reel formats', Date.parse('2026-11-22T18:21:45.657Z')]]);
});
