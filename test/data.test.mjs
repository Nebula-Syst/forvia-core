// Synced state (workouts/routines/bodyweight/nutrition): the JSONB round trip through Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, startServer, register, waitFor } from './helpers.mjs';

let db, server;
before(async () => { db = await createDatabase(); server = await startServer({ databaseUrl: db.url }); });
after(async () => { await server?.stop(); await db?.drop(); });

test('PUT then GET returns the same state, minus the device-local active workout', async () => {
  const { c, user } = await register(server.url);
  const state = {
    workouts: [{ id: 'w1', d: '2026-01-05', entries: [{ id: '1001', sets: [{ w: 60, r: 8, done: true }] }] }],
    routines: [{ id: 'r1', name: 'Pull', ex: ['1001'] }],
    bw: [{ d: '2026-01-05', kg: 80.5 }],
    unicode: 'ñandú — 💪',
    active: { id: 'live' },
    _ts: 1767600000000,
  };
  const put = await c.put('/api/data', { state });
  assert.equal(put.status, 200);
  const got = await c.get('/api/data');
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.state.routines, state.routines);
  assert.deepEqual(got.body.state.bw, state.bw);
  assert.equal(got.body.state.unicode, state.unicode);
  assert.equal(got.body.state.workouts.length, 1);
  assert.equal(got.body.state.active, undefined);

  const row = await waitFor(async () => (await db.query('SELECT data FROM user_state WHERE user_id = $1', [user.id])).rows[0], { what: 'persisted state' });
  assert.equal(row.data.unicode, state.unicode);
});

test('PUT /api/data requires a state object', async () => {
  const { c } = await register(server.url);
  assert.equal((await c.put('/api/data', {})).status, 400);
  assert.equal((await c.put('/api/data', { state: 'nope' })).status, 400);
});

test('malformed JSON is rejected, not a crash that takes the server down', async () => {
  const { c } = await register(server.url);
  const r = await c.request('PUT', '/api/data', '{not json');
  assert.ok(r.status >= 400);
  assert.equal((await c.get('/api/me')).status, 200, 'server stopped answering');
});

test('each account only ever sees its own state', async () => {
  const a = await register(server.url), b = await register(server.url);
  await a.c.put('/api/data', { state: { routines: [{ id: 'mine', name: 'A' }] } });
  const bData = await b.c.get('/api/data');
  assert.ok(!JSON.stringify(bData.body).includes('mine'));
});
