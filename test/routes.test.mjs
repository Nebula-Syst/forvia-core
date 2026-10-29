// Every route in server.js, called the wrong way: signed out, as a normal user and as an admin,
// with an empty body. None of them may answer 5xx — a 500 here is a handler that crashes on input
// it should reject, which is exactly what a dependency update tends to surface. The route list is
// read from server.js, so new routes are covered without touching this file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, startServer, register, client, routeKeys, internalHeaders, PASSWORD, waitFor } from './helpers.mjs';

const keys = routeKeys();
const publicKeys = keys.filter(k => !k.split(' ')[1].startsWith('/internal/'));
const internalKeys = keys.filter(k => k.split(' ')[1].startsWith('/internal/'));

let db, server, adminEmail;
before(async () => {
  db = await createDatabase();
  const boot = await startServer({ databaseUrl: db.url });
  const reg = await register(boot.url, { name: 'Sweep admin' });
  await waitFor(async () => (await db.query(`SELECT 1 FROM kv_users WHERE data->>'id' = $1`, [reg.user.id])).rowCount, { what: 'admin persisted' });
  await boot.stop();
  server = await startServer({ databaseUrl: db.url, dataDir: boot.dataDir, env: { ADMIN_UIDS: reg.user.id } });
  adminEmail = reg.email;
});
after(async () => { await server?.stop(); await db?.drop(); });

const call = (c, key, headers) => {
  const [method, p] = key.split(' ');
  return c.request(method, p, method === 'GET' ? undefined : {}, headers);
};
const expectNo5xx = (r, label) => assert.ok(r.status < 500, `${label} answered ${r.status}: ${r.text}`);

test('found the routes', () => {
  assert.ok(publicKeys.length > 50, `only ${publicKeys.length} public routes found`);
  assert.ok(internalKeys.length >= 9);
});

test('signed out: no route crashes', async () => {
  for (const key of publicKeys) expectNo5xx(await call(client(server.url), key), `${key} (signed out)`);
});

// A fresh account per route: some of them (logout/all, account/delete...) end the session.
test('normal user: no route crashes', async () => {
  for (const key of publicKeys) {
    const { c } = await register(server.url);
    expectNo5xx(await call(c, key), `${key} (user)`);
  }
});

test('admin: no route crashes', async () => {
  for (const key of publicKeys) {
    const c = client(server.url);
    assert.equal((await c.post('/api/login', { email: adminEmail, password: PASSWORD })).status, 200);
    expectNo5xx(await call(c, key), `${key} (admin)`);
  }
});

test('internal routes: no crash with the secret, 403 without', async () => {
  for (const key of internalKeys) {
    expectNo5xx(await call(client(server.url), key, internalHeaders), `${key} (internal)`);
    assert.equal((await call(client(server.url), key)).status, 403, `${key} answered without the secret`);
  }
});

test('the server is still up after the sweep', async () => {
  assert.equal((await client(server.url).get('/api/health')).status, 200);
});
