// Publik (publikhq.com): pay-as-you-go models behind an Anthropic-compatible API. A Publik session
// is the normal `claude` CLI pointed at this deck's /publik/<session>/ route, which holds the key
// (~/.publik/key) and forwards to Publik. The CLI only ever sees a per-session token, never the key.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { swr } from './swr.js';

const API = 'https://publikhq.com/api/';
export const keyPath = () => join(process.env.HOME || homedir(), '.publik', 'key');
const readKey = () => readFile(keyPath(), 'utf8').then((k) => k.trim(), () => '');
export const connected = async () => !!(await readKey());

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
  app.post('/publik/:name/*', {
    bodyLimit: 64 << 20, // a long conversation with screenshots is several MB
    onRequest: async (req, reply) => { if (!tokenOk(req)) return err(reply, 401, 'authentication_error', 'bad token'); },
  }, async (req, reply) => {
    const rest = req.params['*'];
    if (!/^v1\/[\w/-]+$/.test(rest)) return err(reply, 404, 'not_found_error', 'unknown path');
    const key = await readKey();
    if (!key) return err(reply, 401, 'authentication_error', "Publik isn't connected: put your key in ~/.publik/key.");
    const q = req.raw.url.indexOf('?');
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    for (const h of ['anthropic-version', 'anthropic-beta']) if (req.headers[h]) headers[h] = req.headers[h];
    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); }); // Esc in the CLI stops the upstream turn too
    let r;
    try {
      r = await fetch(API + rest + (q >= 0 ? req.raw.url.slice(q) : ''), { method: 'POST', headers, body: JSON.stringify(fold(req.body)), signal: ac.signal });
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
  const key = await readKey();
  if (!key) return null;
  try {
    const r = await fetch(`${API}v1/wallet`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { error: `wallet: HTTP ${r.status}` };
    const w = await r.json();
    const top = typeof w.top_up_url === 'string' && w.top_up_url.startsWith('https://') ? w.top_up_url : null;
    return { balance_micros: w.balance_micros ?? null, spent_today_micros: w.spent_today_micros ?? null, week_used_micros: w.week?.used_micros ?? null, daily_cap_micros: w.daily_cap_micros ?? null, top_up_url: top };
  } catch { return { error: 'wallet unreachable' }; }
}, 30_000, 10 * 60_000);
