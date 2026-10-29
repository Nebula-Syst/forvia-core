// The internal API Forvia's api depends on (/internal/*): the contract between the two services.
// Forvia's own test suite fakes this side; these tests pin down what the real one answers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, startServer, register, client, internalHeaders } from './helpers.mjs';

let db, server, internal;
before(async () => {
  db = await createDatabase();
  server = await startServer({ databaseUrl: db.url });
  internal = client(server.url);
});
after(async () => { await server?.stop(); await db?.drop(); });

const get = (p) => internal.get(p, internalHeaders);
const post = (p, b) => internal.post(p, b, internalHeaders);

test('every internal route refuses a missing or wrong secret', async () => {
  for (const [method, p] of [['POST', '/internal/session'], ['GET', '/internal/user?uid=x'], ['GET', '/internal/users'],
    ['GET', '/internal/users/search?q=ab'], ['POST', '/internal/user'], ['GET', '/internal/state?uid=x'],
    ['PUT', '/internal/state'], ['GET', '/internal/states'], ['POST', '/internal/push']]) {
    assert.equal((await internal.request(method, p, method === 'GET' ? undefined : {})).status, 403, `${method} ${p} without secret`);
    assert.equal((await internal.request(method, p, method === 'GET' ? undefined : {}, { 'X-Internal-Secret': 'wrong' })).status, 403, `${method} ${p} wrong secret`);
  }
});

test('session: resolves a real cookie to its user, anything else to null', async () => {
  const { c, user } = await register(server.url);
  const ok = await post('/internal/session', { cookie: c.cookie });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.id, user.id);
  assert.equal((await post('/internal/session', { cookie: 'gymsid=forged' })).body.user, null);
  assert.equal((await post('/internal/session', {})).body.user, null);
});

test('user: fetch by id without secrets, patch, and list', async () => {
  const { user } = await register(server.url, { name: 'Contract' });
  const got = await get('/internal/user?uid=' + user.id);
  assert.equal(got.status, 200);
  assert.equal(got.body.user.name, 'Contract');
  assert.ok(!('pwd' in got.body.user) && !('sessions' in got.body.user), 'internal user leaks credentials');
  assert.equal((await get('/internal/user?uid=missing')).status, 404);

  assert.equal((await post('/internal/user', { uid: user.id, patch: { xp: 1234 } })).status, 200);
  assert.equal((await get('/internal/user?uid=' + user.id)).body.user.xp, 1234);
  assert.equal((await post('/internal/user', { uid: 'missing', patch: {} })).status, 404);

  const all = await get('/internal/users');
  assert.ok(all.body.users.some(u => u.id === user.id));
  assert.ok(all.body.users.every(u => !('pwd' in u)));
});

test('users/search: matches usernames, needs at least two characters', async () => {
  const { c, user } = await register(server.url);
  const uname = 'contract' + Date.now().toString(36);
  assert.equal((await c.post('/api/account/username', { username: uname })).status, 200);
  const hit = await get('/internal/users/search?q=@' + uname.slice(0, 6));
  assert.ok(hit.body.users.some(u => u.id === user.id));
  assert.deepEqual((await get('/internal/users/search?q=c')).body.users, []);
});

test('state: put, get, and the bulk listing', async () => {
  const { user } = await register(server.url);
  assert.equal((await internal.request('PUT', '/internal/state', { uid: user.id, state: { xp: 5 } }, internalHeaders)).status, 200);
  assert.deepEqual((await get('/internal/state?uid=' + user.id)).body.state, { xp: 5 });
  assert.equal((await get('/internal/state?uid=missing')).body.state, null);
  assert.equal((await internal.request('PUT', '/internal/state', { uid: user.id }, internalHeaders)).status, 400);
  assert.deepEqual((await get('/internal/states')).body.states[user.id], { xp: 5 });
});

test('push: accepted and a no-op for a user without subscriptions', async () => {
  const { user } = await register(server.url);
  assert.equal((await post('/internal/push', { uid: user.id, payload: { title: 't' } })).status, 200);
});
