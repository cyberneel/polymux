// Push Polymux session-state transitions to Friday's Reach Manager (POST /api/reach) the
// INSTANT they happen — so Friday reacts immediately instead of polling Polymux every 60s.
// The same transitions drive the iOS app's push (src/apns.js).
// Opt-in: only runs when POLYMUX_FRIDAY_REACH_URL or POLYMUX_APNS_* is set; standalone Polymux is unaffected.
// Best-effort: if Friday is unreachable we drop the event (Friday's poll is the backstop).

import { config } from './config.js';
import { listSessions, capturePane, promptText } from './tmux.js';
import { getAgents, matchAgents, deckStatus } from './agents.js';
import { apnsEnabled, pushAll } from './apns.js';

const last = new Map(); // session name -> last status
let primed = false; // first pass only records the baseline (no startup burst)
let lastWaiting = 0; // how many sessions needed you last tick (the iOS app's badge)

// What a transition (from -> to) should tell Friday, or null to stay quiet.
// Push ONLY "needs your input" — the time-sensitive case where instant beats Friday's 60s
// poll. Session finished/idle stays with Friday's poll: it adds detail a generic push
// can't (names the output file of a delegated build), and 60s latency is fine there. The
// key matches Friday's scan_sessions scheme (`ccdeck:<name>:waiting`) so the push and the
// poll coalesce in the Reach Manager instead of double-notifying.
function eventFor(s, from, to) {
  if (to === 'waiting_input' && from !== 'waiting_input') {
    const t = s.title || s.name;
    return {
      key: `ccdeck:${s.name}:waiting`,
      urgency: 'high',
      title: 'Polymux',
      body: `“${t}” needs your input.`,
      // Make it answerable in Friday: the session to relay the user's reply to + the prompt.
      sessionId: s.liveSessionId || s.resumedFrom || undefined,
      detail: s.waitingFor || undefined,
    };
  }
  // Session FINISHED — Claude exited ('done'), or went from working back to its prompt
  // ('running' -> 'idle', i.e. done with the current task). Fire a requireMatch reach carrying
  // the title so an armed "call me when <session> finishes" Agenda condition rings INSTANTLY.
  // requireMatch makes Friday drop it silently when nothing is armed, so this never adds a push
  // for every session that finishes — Friday's own 60s poll still sends the proactive "want to
  // see it?" nudge (a different key, so the two don't coalesce-clobber each other).
  // ponytail: emits on every running->idle (once per turn) — fine, requireMatch drops the noise.
  if (to === 'done' || (from === 'running' && to === 'idle')) {
    const t = s.title || s.name;
    return {
      key: `ccdeck:${s.name}:finish-cb`,
      urgency: 'high',
      title: 'Polymux',
      body: `“${t}” finished.`,
      requireMatch: true,
    };
  }
  return null;
}

async function post(ev) {
  try {
    await fetch(config.fridayReach.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Password': config.fridayReach.password },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* Friday down/unreachable → drop; the 60s poll is the backstop */ }
}

async function tick() {
  let sessions;
  try {
    sessions = await listSessions();
    try { matchAgents(sessions, await getAgents()); } catch { /* status degrades, still usable */ }
  } catch {
    return; // couldn't read sessions this round; try again next tick
  }
  const seen = new Set();
  const asking = []; // sessions that just started needing you
  let waiting = 0;
  for (const s of sessions) {
    seen.add(s.name);
    const to = deckStatus(s);
    const from = last.get(s.name);
    last.set(s.name, to);
    if (to === 'waiting_input') waiting++;
    // Skip the first observation of a session (from===undefined) and no-change ticks;
    // only push real transitions once primed.
    if (!primed || from === undefined || from === to) continue;
    if (to === 'waiting_input') asking.push(s);
    const ev = config.fridayReach.url && eventFor(s, from, to);
    // The dialog itself (command, question, options), so it's answerable from Friday unseen.
    if (ev && to === 'waiting_input') ev.detail = promptText(await capturePane(s.name, 0).catch(() => '')) || ev.detail;
    if (ev) post(ev);
  }
  // Forget sessions that vanished so a reused name re-primes cleanly.
  for (const name of [...last.keys()]) if (!seen.has(name)) last.delete(name);
  if (primed && apnsEnabled()) pushToPhone(asking, waiting);
  lastWaiting = waiting;
  primed = true;
}

// The iOS app: a notification per session that started needing you (tapping it opens that
// session), else a quiet badge update when the count changed (you answered one elsewhere).
// Only the short waitingFor goes through Apple, never the screen (it can hold secrets).
// content-available wakes the app to refresh its widgets.
function pushToPhone(asking, waiting) {
  for (const s of asking) {
    pushAll(
      { alert: { title: `“${s.title || s.name}” needs you`, body: (s.waitingFor || 'Waiting for your input.').slice(0, 200) },
        badge: waiting, sound: 'default', 'content-available': 1 },
      { session: s.name },
      { 'apns-collapse-id': s.name.slice(0, 64) },
    );
  }
  if (!asking.length && waiting !== lastWaiting) pushAll({ badge: waiting, 'content-available': 1 }, {}, { 'apns-priority': '5' });
}

// Start the transition monitor (no-op unless Friday reach or iOS push is configured).
export function startReachMonitor() {
  if (!config.fridayReach.url && !apnsEnabled()) return;
  if (config.fridayReach.url) console.log('[polymux] Friday reach: pushing session transitions to', config.fridayReach.url);
  if (apnsEnabled()) console.log('[polymux] iOS push: on (APNs key', config.apns.keyId + ')');
  setInterval(() => { tick().catch(() => {}); }, 7000);
}
