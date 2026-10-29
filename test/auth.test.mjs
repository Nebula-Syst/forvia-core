// Registration, password login, sessions and account settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, startServer, register, client, newEmail, PASSWORD } from './helpers.mjs';

let db, server;
before(async () => { db = await createDatabase(); server = await startServer({ databaseUrl: db.url }); });
after(async () => { await server?.stop(); await db?.drop(); });

test('register validates its input', async () => {
  const c = client(server.url);
  assert.equal((await c.post('/api/register', { email: newEmail(), password: PASSWORD })).status, 400);
  assert.equal((await c.post('/api/register', { name: 'A', email: 'not-an-email', password: PASSWORD })).status, 400);
  assert.equal((await c.post('/api/register', { name: 'A', email: newEmail(), password: 'short' })).status, 400);
});

test('register signs you in and never leaks the password hash', async () => {
  const { c, user } = await register(server.url, { name: 'Ana' });
  assert.ok(c.cookie.startsWith('gymsid='));
  assert.equal(user.name, 'Ana');
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, user.id);
  assert.ok(!('pwd' in me.body.user) && !('sessions' in me.body.user));
});

test('the same email cannot register twice, in any case', async () => {
  const email = newEmail();
  await register(server.url, { email });
  assert.equal((await client(server.url).post('/api/register', { name: 'B', email: email.toUpperCase(), password: PASSWORD })).status, 409);
});

test('login rejects a wrong password with the same error as an unknown email', async () => {
  const { email } = await register(server.url);
  const wrong = await client(server.url).post('/api/login', { email, password: 'wrong password' });
  const unknown = await client(server.url).post('/api/login', { email: newEmail(), password: PASSWORD });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('a forged or tampered cookie is not a session', async () => {
  const { c } = await register(server.url);
  const forged = client(server.url);
  forged.cookie = c.cookie.slice(0, -2) + (c.cookie.endsWith('aa') ? 'bb' : 'aa');
  assert.equal((await forged.get('/api/me')).status, 401);
  forged.cookie = 'gymsid=garbage';
  assert.equal((await forged.get('/api/me')).status, 401);
});

test('logout ends only that session; logout/all ends every one', async () => {
  const { email, password } = await register(server.url);
  const a = client(server.url), b = client(server.url);
  await a.post('/api/login', { email, password });
  await b.post('/api/login', { email, password });
  const aCookie = a.cookie;
  assert.equal((await a.post('/api/logout')).status, 200);
  const replay = client(server.url); replay.cookie = aCookie;
  assert.equal((await replay.get('/api/me')).status, 401, 'logged-out cookie still works');
  assert.equal((await b.get('/api/me')).status, 200, 'logout ended another session');

  const c = client(server.url);
  await c.post('/api/login', { email, password });
  assert.equal((await b.post('/api/logout/all')).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('sessions can be listed and revoked one by one', async () => {
  const { c, email, password } = await register(server.url);
  const other = client(server.url);
  await other.post('/api/login', { email, password }, { 'User-Agent': 'other-device' });
  const list = await c.get('/api/account/sessions');
  assert.equal(list.status, 200);
  assert.equal(list.body.sessions.length, 2);
  assert.equal(list.body.sessions.filter(s => s.current).length, 1);
  const target = list.body.sessions.find(s => !s.current);
  assert.equal((await c.post('/api/account/sessions/revoke', { id: target.id })).status, 200);
  assert.equal((await other.get('/api/me')).status, 401);
  assert.equal((await c.post('/api/account/sessions/revoke', { id: 'nope' })).status, 404);
});

test('changing the password needs the current one', async () => {
  const { c, email } = await register(server.url);
  assert.equal((await c.post('/api/account/password', { currentPassword: 'wrong', password: 'a new password' })).status, 401);
  assert.equal((await c.post('/api/account/password', { currentPassword: PASSWORD, password: 'a new password' })).status, 200);
  assert.equal((await client(server.url).post('/api/login', { email, password: PASSWORD })).status, 401);
  assert.equal((await client(server.url).post('/api/login', { email, password: 'a new password' })).status, 200);
});

test('forgot-password answers the same whether or not the email exists', async () => {
  const { email } = await register(server.url);
  const known = await client(server.url).post('/api/account/forgot-password', { email });
  const unknown = await client(server.url).post('/api/account/forgot-password', { email: newEmail() });
  assert.equal(known.status, unknown.status);
  assert.ok(known.status < 500);
});

test('signed-out requests to private routes are refused', async () => {
  const c = client(server.url);
  for (const p of ['/api/me', '/api/data', '/api/account/sessions']) assert.equal((await c.get(p)).status, 401, p);
});
