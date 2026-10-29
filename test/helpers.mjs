// Test harness: every test file boots the real server.js as a child process, against its own
// throwaway Postgres database and its own DATA_DIR, and talks to it over HTTP — nothing is
// imported from server.js or mocked inside it. That is the point: these tests exist so a
// dependency update (pg, web-push, Node itself) can be merged on a green run, and only the
// real process exercises the real dependency.
//
// Needs a Postgres the tests may create databases in: TEST_DATABASE_URL, defaulting to the dev
// stack's (docker/dev, published on 127.0.0.1:5432). CI provides one as a service container.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ADMIN_DB_URL = process.env.TEST_DATABASE_URL || 'postgres://forvia:forvia@127.0.0.1:5432/forvia';
export const INTERNAL_SECRET = 'test-internal-secret';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor(check, { timeout = 10000, interval = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}` + (last instanceof Error ? `: ${last.message}` : ''));
}

// A fresh database per test file, dropped afterwards — tests never see each other's rows.
export async function createDatabase() {
  const name = 'forvia_test_' + crypto.randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const url = new URL(ADMIN_DB_URL);
  url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  return {
    url: url.toString(),
    query: (text, params) => pool.query(text, params),
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: ADMIN_DB_URL });
      await c.connect();
      try { await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await c.end(); }
    },
  };
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// Boots server.js. The defaults point every sibling it might call (Nebula's api) at a closed
// port, so those calls fail fast the way they would with the sibling down.
export async function startServer({ databaseUrl, dataDir, env = {} } = {}) {
  const port = await freePort();
  dataDir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'forvia-core-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DATA_DIR: dataDir,
      DATABASE_URL: databaseUrl,
      ORIGIN: 'http://localhost',
      INTERNAL_SECRET,
      NEBULA_URL: 'http://127.0.0.1:9',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  let exited = null;
  const exitPromise = new Promise(resolve => child.on('exit', code => { exited = code ?? 'signal'; resolve(); }));

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      if (exited !== null) throw new Error(`server exited (${exited})`);
      const r = await fetch(url + '/api/health');
      return r.ok;
    }, { timeout: 20000, what: 'server health' });
  } catch (e) {
    child.kill('SIGKILL');
    throw new Error(`${e.message}\n--- server output ---\n${output}`);
  }
  return {
    url, port, dataDir,
    output: () => output,
    async stop() {
      if (exited === null) { child.kill('SIGTERM'); await exitPromise; }
    },
  };
}

// fetch with a one-cookie jar (the session cookie), JSON in and out.
export function client(baseUrl) {
  let cookie = '';
  async function request(method, urlPath, body, headers = {}) {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      if (/Max-Age=0/i.test(sc)) cookie = '';
      else if (pair.startsWith('gymsid=')) cookie = pair;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  }
  return {
    request,
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b = {}, h) => request('POST', p, b, h),
    put: (p, b = {}, h) => request('PUT', p, b, h),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}

let seq = 0;
export function newEmail(tag = 'user') {
  return `${tag}-${process.pid}-${Date.now()}-${++seq}@example.com`;
}
export const PASSWORD = 'correct horse battery';

export async function register(baseUrl, { name = 'Test User', email = newEmail(), password = PASSWORD } = {}) {
  const c = client(baseUrl);
  const r = await c.post('/api/register', { name, email, password });
  if (r.status !== 200) throw new Error(`register failed: ${r.status} ${r.text}`);
  return { c, user: r.body.user, email, password };
}

export const internalHeaders = { 'X-Internal-Secret': INTERNAL_SECRET };

// Every route key in a server source file, read straight from its route tables — a route added
// later is swept automatically.
export function routeKeys(file = path.join(ROOT, 'server.js')) {
  const src = fs.readFileSync(file, 'utf8');
  return [...new Set([...src.matchAll(/^\s*'(GET|POST|PUT|PATCH|DELETE) (\/[^']*)':/gm)].map(m => `${m[1]} ${m[2]}`))];
}

/* ---------- web push receiver ---------- */
// web-push only ever speaks HTTPS, so the receiver needs a certificate: a throwaway self-signed
// one is minted per run with openssl and handed to the server via NODE_EXTRA_CA_CERTS (TLS
// verification stays on). Returns null where openssl isn't installed, so callers can skip.
export function makeTlsCert() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forvia-tls-'));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', key, '-out', cert], { stdio: 'ignore' });
  return { key, cert };
}

export async function startPushReceiver(tls) {
  const received = [];
  const server = https.createServer({ key: fs.readFileSync(tls.key), cert: fs.readFileSync(tls.cert) }, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201); res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `https://127.0.0.1:${server.address().port}`, received, close: () => new Promise(r => server.close(r)) };
}

// A browser-side push subscription: the P-256 key pair and auth secret a real browser holds.
export function makeSubscription(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    ecdh, auth,
  };
}

// RFC 8291 (aes128gcm) decryption, as the browser does it — proves the payload web-push sent
// is actually readable by the subscription it was addressed to.
export function decryptPush(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const senderPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = ecdh.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return padded.subarray(0, padded.lastIndexOf(2)).toString('utf8');
}
