import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEvictable, reapable, saysDone } from '../src/slots.js';

test('only an idle, unattached session Friday started is closed for a slot, longest idle first', () => {
  const now = 1_000_000, ms = 300_000;
  const s = (name, origin, attached = false) => ({ name, origin, attached });
  const sessions = [s('user-idle', 'user'), s('fri-fresh', 'proactive'), s('fri-old', 'proactive'), s('fri-older-attached', 'proactive', true), s('fri-busy', 'proactive'), s('fri-oldest', 'proactive')];
  const idle = new Map([['user-idle', 0], ['fri-fresh', now - 1000], ['fri-old', now - ms], ['fri-older-attached', 0], ['fri-oldest', now - 2 * ms]]);
  assert.equal(pickEvictable(sessions, idle, now, ms).name, 'fri-oldest');
  assert.equal(pickEvictable(sessions.filter((x) => !x.name.startsWith('fri-old')), idle, now, ms), null);
});

test("Friday's sessions close once done, later if they asked something, later still each time they come back", () => {
  const fri = { origin: 'proactive' }, min = 60_000, hr = 60 * min;
  assert.equal(reapable(fri, 31 * min, true), true);
  assert.equal(reapable(fri, 29 * min, true), false);
  assert.equal(reapable(fri, 11 * hr, false), false);
  assert.equal(reapable(fri, 13 * hr, false), true);
  assert.equal(reapable(fri, 31 * min, true, 1), false); // came back once: an hour
  assert.equal(reapable(fri, 61 * min, true, 1), true);
  assert.equal(reapable({ origin: 'user' }, 99 * hr, true), false);
  assert.equal(reapable({ ...fri, attached: true }, 99 * hr, true), false);
  assert.equal(reapable({ ...fri, kind: 'codex' }, 99 * hr, true), false);
  assert.equal(saysDone('Shipped it.\n`FRIDAY_STATUS: {"status":"done","needs_user":false,"summary":"x","next":["Deploy"]}`'), true);
  assert.equal(saysDone('FRIDAY_STATUS: {"status":"done","needs_user":true}'), false);
  assert.equal(saysDone('FRIDAY_STATUS: {"status":"done"}\nlater\nFRIDAY_STATUS: {"status":"blocked","needs_user":true}'), false);
  assert.equal(saysDone('All done!'), false);
});
