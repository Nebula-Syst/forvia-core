/* forvia-core — PostgreSQL persistence.
   Same shape/reasoning as Forvia's own db.js (this is a split of that file): one JSONB row per
   item, everything mirrored into memory at request time. This service owns a strict SUBSET of
   the original collections — the ones that are genuinely openGym-derived (auth, invites, bug
   reports, the exercise catalog) plus user_state (workout/routine/bodyweight/nutrition sync,
   unchanged). Forvia's own gamification/social/coach-box tables live in the SAME Postgres
   instance (safe: disjoint table names) but are owned and migrated by that other service, not
   this one — this file only ever touches its own COLLECTIONS list. */
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://forvia:forvia@db:5432/forvia';
export const pool = new pg.Pool({ connectionString: DATABASE_URL });

const COLLECTIONS = ['users', 'subs', 'invites', 'bugReports', 'exerciseOverrides', 'muscleGroups', 'alphaRequests'];
const tableFor = name => 'kv_' + name.replace(/[A-Z]/g, c => '_' + c.toLowerCase());

export async function ensureSchema() {
  const client = await pool.connect();
  try {
    for (const name of COLLECTIONS) {
      await client.query(`CREATE TABLE IF NOT EXISTS ${tableFor(name)} (row_id SERIAL PRIMARY KEY, data JSONB NOT NULL)`);
    }
    await client.query('CREATE TABLE IF NOT EXISTS user_state (user_id TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())');
    await client.query('CREATE TABLE IF NOT EXISTS audit_log (id BIGINT PRIMARY KEY, data JSONB NOT NULL)');
  } finally { client.release(); }
}

export async function loadAll() {
  const out = {};
  for (const name of COLLECTIONS) {
    const { rows } = await pool.query(`SELECT data FROM ${tableFor(name)} ORDER BY row_id`);
    out[name] = rows.map(r => r.data);
  }
  return out;
}

export async function saveAll(db) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of COLLECTIONS) {
      const table = tableFor(name);
      await client.query(`DELETE FROM ${table}`);
      const items = db[name] || [];
      if (items.length) {
        const values = [], params = [];
        items.forEach((item, i) => { values.push(`($${i + 1})`); params.push(JSON.stringify(item)); });
        await client.query(`INSERT INTO ${table} (data) VALUES ${values.join(',')}`, params);
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

export async function loadAllStates() {
  const { rows } = await pool.query('SELECT user_id, data FROM user_state');
  const map = new Map();
  for (const r of rows) map.set(r.user_id, r.data);
  return map;
}
export async function saveState(uid, state) {
  await pool.query(
    'INSERT INTO user_state (user_id, data, updated) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET data = $2, updated = now()',
    [uid, JSON.stringify(state)]
  );
}
export async function deleteState(uid) {
  await pool.query('DELETE FROM user_state WHERE user_id = $1', [uid]);
}

export async function appendAudit(rec) {
  await pool.query('INSERT INTO audit_log (id, data) VALUES ($1, $2)', [rec.id, JSON.stringify(rec)]);
}
export async function auditAll() {
  const { rows } = await pool.query('SELECT data FROM audit_log ORDER BY id');
  return rows.map(r => r.data);
}
export async function auditDeleteIds(ids) {
  if (!ids.length) return;
  await pool.query('DELETE FROM audit_log WHERE id = ANY($1::bigint[])', [ids]);
}
export async function auditClearAll() {
  await pool.query('DELETE FROM audit_log');
}
