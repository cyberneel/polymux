// Publik (publikhq.com): pay-as-you-go models behind an Anthropic-compatible API. A Publik session
// is the normal `claude` CLI pointed at this deck's /publik/<session>/ route, which holds the key
// and forwards to Publik. The CLI only ever sees a per-session token, never the key.
//
// Zero-setup: "Use Publik models" runs Publik's sign-in gate (publik-sdk.js) here in the server and
// shows its screens in the browser; it provisions this install's own key, so nothing is pasted.
// Off unless someone opts in: the build's app token (publik-app-token.txt) only makes the choice
// appear. Nothing contacts Publik until that click, then at each start for whoever opted in.
import { readFile } from 'node:fs/promises';
import { setImmediate as tick } from 'node:timers/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { swr } from './swr.js';
import { DEFAULT_BASE_URL, appToken, ensureSignedIn, readCredential, resolveProvider, setChoice } from './publik-sdk.js';

export const keyPath = () => join(process.env.HOME || homedir(), '.publik', 'key');
// { apiKey, baseURL } or null. Key order: PUBLIK_API_KEY, then this install's key once "Connect
// your plan" was picked, then ~/.publik/key (Friday's Connect Publik, or by hand).
const readKey = async () => {
  const p = resolveProvider();
  if (p.kind === 'publik') return p;
  const c = gate?.prior === 'publik' && readCredential(); // mid-Change: live sessions keep working
  if (c) return { apiKey: c.key, baseURL: c.base_url || DEFAULT_BASE_URL };
  const k = await readFile(keyPath(), 'utf8').then((x) => x.trim(), () => '');
  return k ? { apiKey: k, baseURL: DEFAULT_BASE_URL } : null;
};
export const connected = async () => !!(await readKey());
// This build can offer "Use Publik models" (it carries an app token).
export const offered = () => appToken().startsWith('pat_');

// The gate, driven from the browser: show() parks the screen until /api/publik/action presses a
// button. One gate at a time; a cancelled gate's later screens never resolve, so it just stops.
let gate = null; // { screen, press, openUrl, prior, done }
export function runGate() {
  if (gate) return gate.done;
  const g = gate = { screen: null, press: null, openUrl: null, prior: null };
  const ui = {
    show: (s, signal) => new Promise((resolve) => {
      if (g !== gate) return;
      g.screen = s; g.press = resolve;
      signal.addEventListener('abort', () => { if (g.press === resolve) g.screen = g.press = null; });
      // Unreachable at boot with nobody watching: check again on its own.
      if (s.id === 'unreachable') setTimeout(() => { if (g.press === resolve) resolve('retry'); }, 60_000).unref();
    }),
    openUrl: (u) => { g.openUrl = u; },
  };
  g.done = ensureSignedIn(ui).catch((e) => console.error(`publik: ${e.message}`)).finally(() => { if (gate === g) gate = null; });
  return g.done;
}
export async function publikState() {
  if (gate) return { state: 'gate', screen: gate.screen };
  return { state: (await readKey()) ? 'connected' : offered() ? 'offer' : 'off' };
}

// The session's bearer: derived from the app secret + session name, so it survives a Polymux
// restart (KillMode=process keeps the CLI, and the token in its env, alive).
export const sessionToken = (name) => createHmac('sha256', config.secret).update(`publik:${name}`).digest('hex').slice(0, 48);
function tokenOk(req) {
  const given = String(req.headers.authorization || '').replace(/^Bearer /, '') || String(req.headers['x-api-key'] || '');
  const a = Buffer.from(given), b = Buffer.from(sessionToken(req.params.name));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Claude Code sends its environment block as a mid-conversation `role:"system"` message, which
// Publik rejects ("unsupported role: system"): append that text to the top-level system prompt.
// Claude model names map to Publik's tiers: haiku → fast, opus → smart, the rest → balanced.
export function fold(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
  const extra = [];
  if (Array.isArray(b.messages)) {
    b.messages = b.messages.filter((m) => {
      if (m?.role !== 'system') return true;
      if (typeof m.content === 'string') extra.push({ type: 'text', text: m.content });
      else if (Array.isArray(m.content)) extra.push(...m.content.filter((x) => x?.type === 'text'));
      return false;
    });
  }
  if (extra.length) {
    const sys = typeof b.system === 'string' ? [{ type: 'text', text: b.system }] : Array.isArray(b.system) ? b.system : [];
    b.system = [...sys, ...extra];
  }
  if (typeof b.model === 'string' && !b.model.startsWith('publik-')) {
    b.model = b.model.includes('haiku') ? 'publik-fast' : b.model.includes('opus') ? 'publik-smart' : 'publik-balanced';
  }
  return b;
}

// ponytail: no per-session spend. Publik puts x-publik-charge-micros only on non-streamed replies
// (a stream gets x-publik-reserved-micros, a hold), and Claude Code always streams. Sum that header
// per session once Publik sends the charge for streams too; until then the wallet is the truth.
export function registerPublikRoute(app) {
  const err = (reply, code, type, message) => reply.code(code).send({ type: 'error', error: { type, message } });
  // The "Use Publik models" dialog (under /api, so behind Polymux's login).
  app.get('/api/publik', publikState);
  app.post('/api/publik/start', async (req, reply) => {
    if (!offered()) return reply.code(400).send({ error: "This build of Polymux can't set up Publik." });
    if (!gate) {
      const prior = readCredential()?.choice ?? null;
      setChoice(null); // ask again: Connect your plan, or Use my own key
      runGate();
      gate.prior = prior;
    }
    return publikState();
  });
  app.post('/api/publik/action', async (req, reply) => {
    const a = req.body?.action;
    if (!gate?.press || !gate.screen.buttons.some((b) => b.action === a)) return reply.code(409).send({ error: 'That screen is gone. Try again.' });
    gate.openUrl = null;
    gate.press(a);
    const g = gate;
    await tick(); // the gate opens its link right after the press
    return { ...(await publikState()), open_url: g.openUrl };
  });
  app.post('/api/publik/cancel', async () => {
    if (gate?.prior) setChoice(gate.prior);
    gate = null;
    return publikState();
  });

  app.post('/publik/:name/*', {
    bodyLimit: 64 << 20, // a long conversation with screenshots is several MB
    onRequest: async (req, reply) => { if (!tokenOk(req)) return err(reply, 401, 'authentication_error', 'bad token'); },
  }, async (req, reply) => {
    const rest = req.params['*'];
    if (!/^v1\/[\w/-]+$/.test(rest)) return err(reply, 404, 'not_found_error', 'unknown path');
    const p = await readKey();
    if (!p) return err(reply, 401, 'authentication_error', "Publik isn't set up: pick Use Publik models in Polymux, or put a key in ~/.publik/key.");
    const q = req.raw.url.indexOf('?');
    const headers = { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' };
    for (const h of ['anthropic-version', 'anthropic-beta']) if (req.headers[h]) headers[h] = req.headers[h];
    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); }); // Esc in the CLI stops the upstream turn too
    let r;
    try {
      r = await fetch(`${p.baseURL}/${rest.slice(3)}${q >= 0 ? req.raw.url.slice(q) : ''}`, { method: 'POST', headers, body: JSON.stringify(fold(req.body)), signal: ac.signal });
    } catch (e) {
      return err(reply, 502, 'api_error', `Publik unreachable: ${e.message}`);
    }
    reply.code(r.status);
    // fetch already decoded the body, so its encoding/length headers no longer apply.
    for (const [k, v] of r.headers) if (!/^(transfer-encoding|connection|keep-alive|content-length|content-encoding)$/i.test(k)) reply.header(k, v);
    return reply.send(r.body ? Readable.fromWeb(r.body) : '');
  });
}

// Wallet for the usage pill: balance, today's and this week's spend, the cap, the top-up link.
// null when Publik isn't connected.
export const getWallet = swr(async () => {
  const p = await readKey();
  if (!p) return null;
  try {
    const r = await fetch(`${p.baseURL}/wallet`, { headers: { authorization: `Bearer ${p.apiKey}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { error: `wallet: HTTP ${r.status}` };
    const w = await r.json();
    const top = typeof w.top_up_url === 'string' && w.top_up_url.startsWith('https://') ? w.top_up_url : null;
    return { balance_micros: w.balance_micros ?? null, spent_today_micros: w.spent_today_micros ?? null, week_used_micros: w.week?.used_micros ?? null, daily_cap_micros: w.daily_cap_micros ?? null, top_up_url: top };
  } catch { return { error: 'wallet unreachable' }; }
}, 30_000, 10 * 60_000);
