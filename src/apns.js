// Native push (APNs) for the Polymux iOS app: a Deep Session that needs you shows a notification
// on the phone, and the app's badge follows the needs-you count. OPT-IN: inert unless
// POLYMUX_APNS_KEY_ID, POLYMUX_APNS_KEY (path to the .p8 auth key) and POLYMUX_APNS_TEAM_ID are set.
// The app registers its device token with POST /api/push/apns; tokens live in apns.json.
import { connect } from 'node:http2';
import { sign, createPrivateKey } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { config } from './config.js';

const FILE = process.env.POLYMUX_APNS_FILE || join(homedir(), '.claude', 'cc-deck', 'apns.json');
const HOSTS = { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' };
const GONE = ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'];

export const apnsEnabled = () => !!(config.apns.keyId && config.apns.key && config.apns.teamId);

let devices = null; // [{ token, bundleId, environment, at }]
const load = async () => (devices ??= await readFile(FILE, 'utf8').then(JSON.parse).catch(() => []));
async function save() {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(devices, null, 2), { mode: 0o600 });
}

const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });

// bundleId is the installed app's (the APNs topic); environment is how the build was signed.
export async function registerDevice({ token, bundleId, environment } = {}) {
  if (!/^[0-9a-f]{32,200}$/i.test(token || '')) throw bad('token must be the device token in hex');
  if (!/^[A-Za-z0-9.-]{1,155}$/.test(bundleId || '')) throw bad('bundleId is required');
  if (!HOSTS[environment]) throw bad('environment must be sandbox or production');
  const list = (await load()).filter((d) => d.token !== token);
  // ponytail: the 20 most recent devices; a person has a phone and an iPad, not twenty
  devices = [...list, { token, bundleId, environment, at: Date.now() }].slice(-20);
  await save();
}

// The provider token: an ES256 JWT, good for an hour; Apple wants it reused, not minted per push.
let jwt = null;
export async function bearer(now = Date.now()) {
  if (jwt && now - jwt.at < 50 * 60e3) return jwt.token;
  const key = createPrivateKey(await readFile(config.apns.key, 'utf8'));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b64({ alg: 'ES256', kid: config.apns.keyId })}.${b64({ iss: config.apns.teamId, iat: Math.floor(now / 1000) })}`;
  const sig = sign('sha256', Buffer.from(head), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwt = { token: `${head}.${sig}`, at: now };
  return jwt.token;
}

// ponytail: one HTTP/2 connection per push; pushes are rare (a session starts waiting), so no pool
function post(d, body, headers) {
  return new Promise((done) => {
    const c = connect(HOSTS[d.environment]);
    const finish = (r) => { c.close(); done(r); };
    c.on('error', () => finish({ status: 0 }));
    const req = c.request({ ':method': 'POST', ':path': `/3/device/${d.token}`, 'apns-topic': d.bundleId, ...headers });
    let status = 0, data = '';
    req.setEncoding('utf8');
    req.setTimeout(10_000, () => req.close());
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (x) => { data += x; });
    req.on('end', () => { let reason = ''; try { reason = JSON.parse(data).reason; } catch { /* 200 has no body */ } finish({ status, reason }); });
    req.on('error', () => finish({ status: 0 }));
    req.end(JSON.stringify(body));
  });
}

// Send to every registered device, dropping the ones Apple says are gone. Best-effort: a failed
// push is logged, never thrown (the dashboard and the badge on next open are the backstop).
export async function pushAll(aps, extra = {}, headers = {}) {
  if (!apnsEnabled() || !(await load()).length) return;
  let auth;
  try { auth = await bearer(); } catch (e) { console.warn('[polymux] APNs: cannot read the key:', e.message); return; }
  const gone = [];
  await Promise.all(devices.map(async (d) => {
    const r = await post(d, { aps, ...extra }, { authorization: `bearer ${auth}`, 'apns-push-type': 'alert', ...headers });
    if (r.status === 410 || GONE.includes(r.reason)) gone.push(d.token);
    else if (r.status !== 200) {
      if (r.status === 403) jwt = null; // an expired or refused provider token: mint a fresh one next time
      console.warn('[polymux] APNs push failed:', r.status || 'no connection', r.reason || '');
    }
  }));
  if (gone.length) { devices = devices.filter((d) => !gone.includes(d.token)); await save(); }
}
