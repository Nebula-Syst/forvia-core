// Boot, schema and persistence: the pg driver end to end, plus the files kept in DATA_DIR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabase, startServer, register, client, waitFor } from './helpers.mjs';

let db, server;
before(async () => { db = await createDatabase(); server = await startServer({ databaseUrl: db.url }); });
after(async () => { await server?.stop(); await db?.drop(); });

test('creates its schema on an empty database', async () => {
  const { rows } = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  const tables = rows.map(r => r.table_name);
  for (const t of ['kv_users', 'kv_subs', 'kv_invites', 'kv_bug_reports', 'kv_exercise_overrides',
    'kv_muscle_groups', 'kv_alpha_requests', 'user_state', 'audit_log']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('health and public config answer without a session', async () => {
  const c = client(server.url);
  assert.equal((await c.get('/api/health')).status, 200);
  const cfg = await c.get('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(typeof cfg.body.allow_register, 'boolean');
});

test('generates the session secret and VAPID keys once, private to the owner', () => {
  for (const f of ['secret', 'vapid.json']) {
    const st = fs.statSync(path.join(server.dataDir, f));
    assert.equal(st.mode & 0o077, 0, `${f} is readable by group/others`);
  }
  const vapid = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'vapid.json'), 'utf8'));
  assert.ok(vapid.publicKey && vapid.privateKey);
});

test('accounts, sessions and synced state survive a restart', async () => {
  const { c, user, email, password } = await register(server.url);
  const state = { workouts: [], routines: [{ id: 'r1', name: 'Push day' }], _ts: Date.now() };
  assert.equal((await c.put('/api/data', { state })).status, 200);
  await waitFor(async () => (await db.query('SELECT 1 FROM user_state WHERE user_id = $1', [user.id])).rowCount === 1, { what: 'user_state row' });
  await waitFor(async () => (await db.query(`SELECT 1 FROM kv_users WHERE data->>'id' = $1`, [user.id])).rowCount === 1, { what: 'kv_users row' });

  const secret = fs.readFileSync(path.join(server.dataDir, 'secret'), 'utf8');
  await server.stop();
  server = await startServer({ databaseUrl: db.url, dataDir: server.dataDir });
  assert.equal(fs.readFileSync(path.join(server.dataDir, 'secret'), 'utf8'), secret, 'secret was regenerated');

  // The old cookie still works (same secret, session persisted) ...
  const sameCookie = client(server.url); sameCookie.cookie = c.cookie;
  const me = await sameCookie.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, user.id);
  // ... and so do the password and the synced state.
  const fresh = client(server.url);
  assert.equal((await fresh.post('/api/login', { email, password })).status, 200);
  const data = await fresh.get('/api/data');
  assert.deepEqual(data.body.state.routines, state.routines);
});
