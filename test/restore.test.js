import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.HOME = mkdtempSync(join(tmpdir(), 'polymux-restore-'));
const { cutOff } = await import('../src/restore.js');

test('restore: only a session whose transcript stops mid-turn is told to carry on', () => {
  const dir = '/srv/work';
  const proj = join(process.env.HOME, '.claude', 'projects', '-srv-work');
  mkdirSync(proj, { recursive: true });
  const j = (o) => JSON.stringify(o);
  writeFileSync(join(proj, 'done.jsonl'), [j({ type: 'user' }), j({ type: 'assistant' }), j({ type: 'system', subtype: 'turn_duration' }), ''].join('\n'));
  writeFileSync(join(proj, 'cut.jsonl'), [j({ type: 'user' }), j({ type: 'assistant' }), j({ type: 'user' }), j({ type: 'attachment' }), ''].join('\n'));
  // A local command after the turn (/model) starts no turn; nor does a tail with no turn in it.
  writeFileSync(join(proj, 'model.jsonl'), [j({ type: 'assistant' }), j({ type: 'system', subtype: 'turn_duration' }), j({ type: 'user', isMeta: true, message: { content: '<local-command-caveat>…' } }), j({ type: 'user', message: { content: '<command-name>/model</command-name>' } }), j({ type: 'user', message: { content: '<local-command-stdout>Set model</local-command-stdout>' } }), ''].join('\n'));
  writeFileSync(join(proj, 'quiet.jsonl'), [j({ type: 'artifact-autoreact-ledger' }), j({ type: 'system', subtype: 'away_summary' }), ''].join('\n'));
  // One the user stopped stays stopped.
  writeFileSync(join(proj, 'stopped.jsonl'), [j({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }), j({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }), j({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }), ''].join('\n'));
  assert.equal(cutOff({ dir, resume: 'stopped' }), false);
  assert.equal(cutOff({ dir, resume: 'model' }), false);
  assert.equal(cutOff({ dir, resume: 'quiet' }), false);
  assert.equal(cutOff({ dir, resume: 'done' }), false);
  assert.equal(cutOff({ dir, resume: 'cut' }), true);
  assert.equal(cutOff({ dir, resume: 'cut', kind: 'codex' }), false);
  assert.equal(cutOff({ dir, resume: 'gone' }), false);
  assert.equal(cutOff({ dir }), false);
});
