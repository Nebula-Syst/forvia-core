// Admin: ADMIN_UIDS, the users list, disabling accounts, invites and the Postgres audit log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, startServer, register, client, newEmail, PASSWORD, waitFor } from './helpers.mjs';

let db, server, admin, adminUser;
before(async () => {
  db = await createDatabase();
  // An admin is named by id, which only exists once the account does: register, then reboot.
  let boot = await startServer({ databaseUrl: db.url });
  const reg = await register(boot.url, { name: 'Admin' });
  await waitFor(async () => (await db.query(`SELECT 1 FROM kv_users WHERE data->>'id' = $1`, [reg.user.id])).rowCount, { what: 'admin persisted' });
  await boot.stop();
  server = await startServer({ databaseUrl: db.url, dataDir: boot.dataDir, env: { ADMIN_UIDS: reg.user.id } });
  admin = client(server.url);
  assert.equal((await admin.post('/api/login', { email: reg.email, password: PASSWORD })).status, 200);
  adminUser = reg.user;
});
after(async () => { await server?.stop(); await db?.drop(); });

test('admin routes: 401 signed out, 403 for a normal user, 200 for an admin', async () => {
  const { c } = await register(server.url);
  assert.equal((await client(server.url).get('/api/admin/users')).status, 401);
  assert.equal((await c.get('/api/admin/users')).status, 403);
  const r = await admin.get('/api/admin/users');
  assert.equal(r.status, 200);
  assert.ok(r.body.users.find(u => u.id === adminUser.id).admin);
});

test('a disabled account is locked out at once, and can be re-enabled', async () => {
  const { c, user, email } = await register(server.url);
  assert.equal((await admin.post('/api/admin/user/disable', { id: user.id, disabled: true })).status, 200);
  assert.equal((await c.get('/api/me')).status, 401, 'existing session survived');
  assert.equal((await client(server.url).post('/api/login', { email, password: PASSWORD })).status, 403);
  assert.equal((await admin.post('/api/admin/user/disable', { id: user.id, disabled: false })).status, 200);
  assert.equal((await client(server.url).post('/api/login', { email, password: PASSWORD })).status, 200);
  assert.equal((await admin.post('/api/admin/user/disable', { id: adminUser.id, disabled: true })).status, 400, 'an admin could disable an admin');
});

test('an invite code lets exactly one account in, and an unused one can be revoked', async () => {
  const inv = await admin.post('/api/admin/invites/new', { note: 'for a friend' });
  assert.equal(inv.status, 200);
  const code = inv.body.invite.code;
  const first = await client(server.url).post('/api/register', { name: 'Invited', email: newEmail(), password: PASSWORD, code });
  assert.equal(first.status, 200);
  const list = await admin.get('/api/admin/invites');
  assert.equal(list.body.invites.find(i => i.code === code).usedBy, first.body.user.id);
  assert.equal((await admin.post('/api/admin/invites/revoke', { code })).status, 400, 'a used invite was revoked');

  const spare = (await admin.post('/api/admin/invites/new')).body.invite.code;
  assert.equal((await admin.post('/api/admin/invites/revoke', { code: spare.toLowerCase() })).status, 200);
  assert.equal((await admin.post('/api/admin/invites/revoke', { code: spare })).status, 404);
});

test('bug reports reach the admin inbox', async () => {
  const { c } = await register(server.url);
  assert.equal((await c.post('/api/bugs', { message: 'the timer froze', page: '/workout' })).status, 200);
  assert.equal((await c.post('/api/bugs', { message: '   ' })).status, 400);
  const inbox = await admin.get('/api/admin/bugs');
  assert.ok(inbox.body.reports.some(r => r.message === 'the timer froze'));
});

test('sign-ins land in the audit log, in Postgres', async () => {
  const { email } = await register(server.url);
  await client(server.url).post('/api/login', { email, password: 'wrong password' });
  const r = await admin.get('/api/admin/audit?cat=fail');
  assert.equal(r.status, 200);
  assert.ok(r.body.events.some(e => e.ev === 'auth.login.fail'));
  await waitFor(async () => (await db.query(`SELECT 1 FROM audit_log WHERE data->>'ev' = 'auth.login.fail'`)).rowCount, { what: 'audit row in Postgres' });
});
