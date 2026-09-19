/* forvia-core — email/password auth + per-user state storage for Forvia.
   This is the openGym-derived half of what used to be one server.js: auth, sessions, account
   management, workout/routine/bodyweight/nutrition sync (the whole user_state blob — nutrition
   fields ride along unchanged, see NOTICE.md/the split's own writeup for why that data doesn't
   need to move), the base admin panel, the exercise-name-override catalog, invites, bug reports,
   and push notifications. Everything gamification/social/coach-box (level, XP, prestige,
   streaks, nutrition's own external-facing routes, the social feed, and the whole coach/box
   system) lives in the sibling "Nebula" service instead — that one calls the small `/internal/*`
   API below (shared-secret protected, never exposed publicly) to resolve a session to a user and
   to read/patch the handful of user fields it owns (coach/pro/prestige/streak/badges/etc — still
   physically stored on this service's `users` row for now, a deliberate simplification; see the
   split's own notes for why a full profile-table split wasn't part of this first pass).
   No framework, JSON-file storage, signed session cookies. */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import webpush from 'web-push';
import { ensureSchema, loadAll, saveAll, loadAllStates, saveState, deleteState, appendAudit, auditAll, auditDeleteIds, auditClearAll } from './db.js';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
// Admin dashboard (issue): admins are matched by uid; INVITE_ONLY gates new signups behind a
// code the admin generates. Both default off so a fresh self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// Guest mode ("Continue without account") keeps everything in the browser and never touches this
// server — but on an instance meant for a known set of people, an entrance nobody can walk back
// out of is still the wrong front door (#42). Default ON, so existing instances are unchanged;
// the polarity is inverted from INVITE_ONLY because the safe default here is the permissive one.
const ALLOW_GUEST = !/^(0|false|no|off)$/i.test(process.env.ALLOW_GUEST || '');
// Same polarity/default as ALLOW_GUEST — off only when the operator explicitly says so, since a
// closed instance means every account after the first one is created by an admin instead (see
// POST /api/admin/user/create), not self-service registration.
const ALLOW_REGISTER = !/^(0|false|no|off)$/i.test(process.env.ALLOW_REGISTER || '');
// Mirrors the same-named constant on the Nebula side — GET /api/config hands this to the login/
// onboarding screen before anyone is signed in, so it has to be answerable without a session,
// which is why it's duplicated here rather than composed from the other service.
const BOX_LOCATION_MODE = /^(off|precise)$/i.test(process.env.BOX_LOCATION_MODE || '') ? process.env.BOX_LOCATION_MODE.toLowerCase() : 'search';
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
// Base64 inflates ~33%, so the ~6MB compressed-photo cap enforced on an avatar upload already
// needs ~8MB of headroom on its own before the surrounding {"dataUrl":"data:...","}
// JSON wrapper adds its own few dozen bytes on top — cutting MAX_BODY exactly at 8MB let that
// wrapper push a maximum-size photo's body just past the limit, which read as the generic
// "body too large" 500 instead of this route's proper 413. Comfortable headroom fixes both.
const MAX_BODY = 9 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';
// The only cross-origin request this API answers: the "apply for the alpha" form on the
// landing page, a *different* origin from the app itself (forvia.fit vs app.forvia.fit) with
// no session to prove it's really that page — CORS is the whole guard, so it's an explicit
// allowlist, never a wildcard, and only the one route below sets these headers at all.
const LANDING_ORIGINS = (process.env.LANDING_ORIGINS || 'https://forvia.fit,https://www.forvia.fit').split(',').map(s => s.trim()).filter(Boolean);
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !LANDING_ORIGINS.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
}

fs.mkdirSync(DATA, { recursive: true });

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

// Loaded from Postgres once boot()/main() runs, at the bottom of this file. Deliberately a
// SUBSET of the original db.json shape — see db.js's own comment for exactly which collections
// this service owns.
let db = { users: [], subs: [], invites: [], alphaRequests: [], bugReports: [], exerciseOverrides: [], muscleGroups: [] };
// A user can hold several employee types at once (e.g. both founder and admin), not one
// flat role — employeeTypes is an array, filtered to the known set on every read so a
// stale/tampered value in db.json can never grant something that isn't in EMPLOYEE_TYPES.
const EMPLOYEE_TYPES = ['founder', 'admin'];
const employeeTypesOf = user => Array.isArray(user?.employeeTypes) ? user.employeeTypes.filter(t => EMPLOYEE_TYPES.includes(t)) : [];
const isAdmin = user => !!user && (employeeTypesOf(user).length > 0 || ADMIN_UIDS.includes(user.id));

// Same URL shape GET /api/uploads already serves workout photos through — an avatar is just
// another file in that user's uploads dir, so it inherits that route's visibility rule for
// free (owner, or a currently-public account) without a new endpoint.
const avatarUrlOf = user => user.avatarFile ? `/api/uploads?uid=${encodeURIComponent(user.id)}&file=${encodeURIComponent(user.avatarFile)}` : null;
// The shape sent to the client for "who am I" — never the password hash/salt, just the identity/
// account fields this service actually owns. Rank/perks/badges/pro/coach-marketplace fields used
// to live here too; they're Nebula's now (see /api/me below, which merges its own call in on the
// frontend side — this object never changes shape, callers just get less than they used to, and
// the frontend already fetches the rest from the other service).
const publicUser = user => ({
  id: user.id, name: user.name, admin: isAdmin(user), employeeTypes: employeeTypesOf(user),
  // A real geocoded place ({label, lat, lon} — Nebula's GET /api/geo/search or /reverse), never
  // free text. Stored here (not Nebula) since it rides on the same `users` row as everything
  // else about "this account", even though only the coach marketplace (Nebula) reads it.
  coachLocation: user.coachLocation || null,
  // firstName/lastName are the real source of truth once set (see POST /api/account/name) —
  // `name` is still what the rest of the app reads to display someone, kept in sync from
  // the two parts server-side so nothing else has to change. null on accounts that have
  // never saved a split, so the client knows to offer its one-time best-guess split rather
  // than silently re-splitting `name` on every load (that re-guess was the actual bug: a
  // compound given name like "Jose Maria" doesn't have a real first/last boundary a splitter
  // can find, so re-deriving it every time undid any correction the person had made).
  firstName: user.firstName ?? null, lastName: user.lastName ?? null,
  username: user.username || null,
  public: !!user.public, bio: user.bio || '', avatarUrl: avatarUrlOf(user),
  pinnedWorkoutIds: user.pinnedWorkoutIds || [], pinnedPR: user.pinnedPR || null,
  email: user.email || null, emailVerified: !!user.emailVerified, phone: user.phone || null,
  created: user.created || null,
});
// Fire-and-forget, same as the old atomicWrite(dbFile,...) call it replaces: every one of the
// call sites below just does `saveDb();` with no await and no return value, so this stays
// safe to call bare — a failed write is logged, never thrown, never blocks the response.
//
// saveAll does DELETE FROM <table>; INSERT ... per collection, which is only safe run one at a
// time. saveChain below is the fix: every saveDb() call is appended to one standing promise, so
// saveAll never runs concurrently with itself (see Forvia's own db.js comment on why: two
// overlapping calls used to duplicate every row in production).
let saveChain = Promise.resolve();
function saveDb() {
  saveChain = saveChain.then(() => saveAll(db)).catch(e => console.error('saveDb failed:', e.message));
}

// Per-user training state (routines, workouts, bodyweight, nutrition diary...) — same
// in-memory-mirror pattern as `db` above, backed by the user_state table instead of
// state-<uid>.json.
const stateCache = new Map();
function readState(uid) { return stateCache.get(uid) || null; }
function writeState(uid, state) {
  stateCache.set(uid, state);
  saveState(uid, state).catch(e => console.error('saveState failed:', uid, e.message));
}
function removeState(uid) {
  stateCache.delete(uid);
  deleteState(uid).catch(e => console.error('deleteState failed:', uid, e.message));
}

// PUT /api/data otherwise replaces a user's whole state with whatever the pushing device has
// locally — fine for settings and anything only ever edited in one place at a time, but
// catastrophic for `workouts` specifically: a second device or tab that hasn't caught up on a
// workout logged elsewhere yet, syncing for any unrelated reason (even just being opened),
// would silently overwrite the server's copy and erase that workout for good — no version
// history, nothing to restore from (issue: a real workout vanished this way in production).
// Workouts merge instead: union by id with whatever the server already has, so a workout
// present on EITHER side survives a stale push. An *intentional* delete (sheets.jsx's "Delete
// workout") has to travel as a small tombstone list (deletedWorkoutIds) rather than by simply
// omitting the id from the push — omission is exactly what a stale device's push already looks
// like, so it's the one signal that can't tell the two apart. Tombstones merge the same way
// (union, newest `at` wins) and age out after TOMBSTONE_MAX_AGE_MS — long enough that no
// realistic offline gap outruns it, short enough the list never grows unbounded.
const TOMBSTONE_MAX_AGE_MS = 180 * 86400000;
// Shared by mergeWorkoutsInto and mergeFoodDiaryInto below: union two {id, at} tombstone lists,
// newest `at` wins per id, and anything older than TOMBSTONE_MAX_AGE_MS is dropped so the list
// never grows unbounded.
function mergeTombstones(a, b) {
  const cutoff = Date.now() - TOMBSTONE_MAX_AGE_MS;
  const byId = new Map();
  for (const t of [...(a || []), ...(b || [])]) {
    if (!t?.id || !((t.at || 0) >= cutoff)) continue;
    const cur = byId.get(t.id);
    if (!cur || (t.at || 0) > (cur.at || 0)) byId.set(t.id, t);
  }
  return byId;
}
// Returns whether this merge actually introduced a new imported workout (id prefix 'iw', same
// convention Nebula's anti-cheat overlap exemption uses) — notifyNebula('data-synced', ...)
// passes this through so the other service knows an import just landed, as opposed to a normal
// device sync of native workouts (it decides whether to apply the fixed-XP-budget import cap).
function mergeWorkoutsInto(uid, incoming) {
  const prev = readState(uid);
  const prevIds = new Set((prev?.workouts || []).map(w => w?.id).filter(Boolean));
  const tombById = mergeTombstones(prev?.deletedWorkoutIds, incoming.deletedWorkoutIds);
  const workoutById = new Map();
  for (const w of (prev?.workouts || [])) if (w?.id) workoutById.set(w.id, w);
  for (const w of (incoming.workouts || [])) if (w?.id) workoutById.set(w.id, w);
  for (const id of tombById.keys()) workoutById.delete(id);
  incoming.workouts = [...workoutById.values()];
  incoming.deletedWorkoutIds = [...tombById.values()];
  return incoming.workouts.some(w => !prevIds.has(w.id) && typeof w.id === 'string' && w.id.startsWith('iw'));
}

// Same fix, same reasoning, for the nutrition diary (issue: a full week of logged food vanished
// this way in production — foodDiary had never gotten the merge-by-id treatment workouts got).
// foodDiary is date-keyed rather than one flat array, so the union-by-id merge runs once per day
// (the union of every day either side knows about) instead of once overall.
function mergeFoodDiaryInto(uid, incoming) {
  const prev = readState(uid);
  const tombById = mergeTombstones(prev?.deletedFoodEntryIds, incoming.deletedFoodEntryIds);
  const days = new Set([...Object.keys(prev?.foodDiary || {}), ...Object.keys(incoming.foodDiary || {})]);
  const merged = {};
  for (const day of days) {
    const byId = new Map();
    for (const it of (prev?.foodDiary?.[day] || [])) if (it?.id) byId.set(it.id, it);
    for (const it of (incoming.foodDiary?.[day] || [])) if (it?.id) byId.set(it.id, it);
    for (const id of tombById.keys()) byId.delete(id);
    merged[day] = [...byId.values()];
  }
  incoming.foodDiary = merged;
  incoming.deletedFoodEntryIds = [...tombById.values()];
}

/* ---------- workout photos / avatars ---------- */
// Stored on disk under DATA/uploads/<uid>/, served back through GET /api/uploads?uid&file —
// through the API rather than a static nginx mount, so the one visibility rule (owner or a
// currently-public account) applies without touching the web container at all. This directory
// is a Docker volume SHARED with the Nebula service (same mount path in both containers) — social
// photos, box images and coach-application documents are Nebula's own routes but land in the
// same per-uid folder, so this one serving route (and this one on-disk layout) covers all of it
// without an internal file-transfer API.
const UPLOAD_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const uploadsDir = uid => path.join(DATA, 'uploads', uid.replace(/[^a-zA-Z0-9_-]/g, ''));
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

async function sendPush(userId, payload) {
  const subs = db.subs.filter(s => s.userId === userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  let dirty = false;
  await Promise.all(subs.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
      }
    }
  }));
  if (dirty) saveDb();
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
// Used to be gated on effectiveRoutineId (S.week/S.dayPlan) and skipped rest days; there's
// no weekly schedule left to consult (routines are picked freely each session), so this now
// just checks whether *anything* was logged today rather than whether something was "planned".
function reminderTick() {
  for (const user of db.users) {
    if (!db.subs.some(s => s.userId === user.id)) continue;
    const S = readState(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    console.log('reminder firing', user.id);
    user.lastReminder = now.date;
    saveDb();
    sendPush(user.id, {
      title: 'Workout reminder',
      body: "You haven't logged a workout today — let's go 💪",
      tag: 'day-reminder'
    });
  }
}
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
// Registered from main() below, once boot has loaded db/stateCache from Postgres.

/* ---------- sessions (signed cookie) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
// Session payload is `<uid>:<expiry>:<sid>`, where `sid` is the id of one entry in that user's
// `sessions` array (see makeSession below) — the per-device session record that array entry
// represents is the sole source of truth for whether a cookie is still valid. Revoking one
// device (POST /api/account/sessions/revoke) removes just that entry; "sign out everywhere"
// (POST /api/logout/all) empties the whole array.
function parseSessionCookie(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, sid] = payload.split(':');
  if (!uid || !sid || +exp < Date.now()) return null;
  return { uid, exp: +exp, sid };
}
function makeSession(user, req) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const sess = {
    id: crypto.randomBytes(9).toString('base64url'),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    ua: (req?.headers['user-agent'] || '').slice(0, 200),
  };
  if (!Array.isArray(user.sessions)) user.sessions = [];
  user.sessions.push(sess);
  saveDb();
  return sign(user.id + ':' + exp + ':' + sess.id);
}
function readSession(req) {
  const parsed = parseSessionCookie(req);
  if (!parsed) return null;
  const user = db.users.find(u => u.id === parsed.uid) || null;
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  if (!(user.sessions || []).find(s => s.id === parsed.sid)) return null;
  return user;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  // Only the 403 is recorded: a 401 is any unauthenticated bot poking /api/admin/*, and
  // logging those would bury the events an operator actually wants to see.
  if (!isAdmin(user)) { audit(req, 'admin.denied', { ok: false, user }); json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function sessionCookie(user, req) {
  return `gymsid=${makeSession(user, req)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

/* ---------- password login ---------- */
// scrypt, not bcrypt: Node ships it, so password login doesn't add a third dependency to a
// project that advertises having only two. 64-byte derived key, per-user random salt.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const got = crypto.scryptSync(password, salt, 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const findByEmail = email => {
  const norm = String(email || '').trim().toLowerCase();
  return norm ? db.users.find(u => (u.email || '').toLowerCase() === norm) : null;
};

/* ---------- outbound email (account email verification only) ---------- */
// Hand-rolled SMTP client, not a dependency — same call as scrypt over bcrypt above: this
// project ships with exactly one dependency (web-push), and a plain SMTP conversation
// (EHLO/[STARTTLS]/AUTH LOGIN/MAIL FROM/RCPT TO/DATA) is a small, well-documented protocol
// that doesn't earn adding nodemailer just to send one kind of message. Best-effort: every
// caller treats a false return as "couldn't send" and tells the user, never as a hard error.
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = +(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_SECURE = /^(1|true|yes|on)$/i.test(process.env.SMTP_SECURE || '') || SMTP_PORT === 465;
const ORIGIN_HOST = (() => { try { return new URL(ORIGIN).hostname; } catch { return 'localhost'; } })();
const SMTP_FROM = process.env.SMTP_FROM || `Forvia <no-reply@${ORIGIN_HOST}>`;
const SMTP_CONFIGURED = !!SMTP_HOST;

function smtpRead(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = d => {
      buf += d.toString('utf8');
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) { cleanup(); resolve(buf); }
    };
    const onErr = e => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('connection closed')); };
    function cleanup() { socket.removeListener('data', onData); socket.removeListener('error', onErr); socket.removeListener('close', onClose); }
    socket.on('data', onData);
    socket.once('error', onErr);
    socket.once('close', onClose);
  });
}
async function smtpCmd(socket, line) {
  if (line != null) socket.write(line + '\r\n');
  const r = await smtpRead(socket);
  if (!/^2/.test(r) && !/^3/.test(r)) throw new Error('SMTP ' + r.trim().split('\r\n').pop());
  return r;
}
async function connectPlain() {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: SMTP_HOST, port: SMTP_PORT });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}
async function upgradeTls(socket, servername) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, host: SMTP_HOST, servername }, () => resolve(s));
    s.once('error', reject);
  });
}
async function sendMail({ to, subject, text }) {
  if (!SMTP_CONFIGURED) return false;
  let socket = null;
  try {
    socket = SMTP_SECURE ? await upgradeTls(await connectPlain(), SMTP_HOST) : await connectPlain();
    await smtpRead(socket);   // 220 greeting
    let r = await smtpCmd(socket, `EHLO ${ORIGIN_HOST}`);
    if (!SMTP_SECURE && /STARTTLS/i.test(r)) {
      await smtpCmd(socket, 'STARTTLS');
      socket = await upgradeTls(socket, SMTP_HOST);
      await smtpCmd(socket, `EHLO ${ORIGIN_HOST}`);
    }
    if (SMTP_USER) {
      await smtpCmd(socket, 'AUTH LOGIN');
      await smtpCmd(socket, Buffer.from(SMTP_USER).toString('base64'));
      await smtpCmd(socket, Buffer.from(SMTP_PASS).toString('base64'));
    }
    const fromAddr = (SMTP_FROM.match(/<([^>]+)>/) || [, SMTP_FROM])[1];
    await smtpCmd(socket, `MAIL FROM:<${fromAddr}>`);
    await smtpCmd(socket, `RCPT TO:<${to}>`);
    await smtpCmd(socket, 'DATA');
    const body = [`From: ${SMTP_FROM}`, `To: ${to}`, `Subject: ${subject}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', text, '.'].join('\r\n');
    await smtpCmd(socket, body);
    await smtpCmd(socket, 'QUIT').catch(() => {});
    socket.end();
    return true;
  } catch (e) {
    console.error('sendMail failed:', e.message);
    try { socket && socket.destroy(); } catch {}
    return false;
  }
}

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- audit log ---------- */
// Who signed in, who tried and failed, and what an admin changed. One JSON object per line in
// ./data/audit.log, appended and never rewritten in place. It deliberately does not live in
// db.json: that file is rewritten whole on every save, and the login/register handshakes are
// unauthenticated and unthrottled by design, so an audit trail in there would turn one bogus
// request into a full db.json rewrite. A line torn by a crash costs one event and is dropped on
// read.
//
// On by default. It records strictly less than the instance already holds — every account is in
// db.json and every workout is in state-<uid>.json, both readable by any admin — and a security
// feature that ships switched off protects nobody. IP addresses are the exception: off unless you
// ask for them, because they are the one field here that says where somebody physically is.
const AUDIT_ON = !/^(0|false|no|off)$/i.test(process.env.AUDIT_LOG || '');
const AUDIT_MAX = Math.max(0, +(process.env.AUDIT_MAX || 5000) || 0);     // 0 = no count cap
const AUDIT_DAYS = Math.max(0, +(process.env.AUDIT_DAYS || 90) || 0);     // 0 = no age cap
const AUDIT_IP = /^full$/i.test(process.env.AUDIT_IP || '') ? 'full'
  : /^(1|true|yes|on|net)$/i.test(process.env.AUDIT_IP || '') ? 'net' : 'off';
let auditSeq = 0;      // never reset, not even by a clear — a wiped log leaves a visible id gap
let auditCount = 0;
let auditCache = [];   // in-memory mirror of the audit_log table, same pattern as db/stateCache

// Which header holds the caller depends on what is in front of the API. CF-Connecting-IP comes
// first because a Cloudflare tunnel does NOT forward the client in X-Forwarded-For — that header
// then only carries the tunnel's own container, which looks like a valid answer and isn't. After
// that, the first entry of X-Forwarded-For is the client and everything behind it is our own hops.
// All three are only as trustworthy as the proxy in front: it has to overwrite them rather than
// pass a client-supplied one through. In 'net' mode only the network survives — enough to tell
// one source from another, not enough to point at a person.
function clientIp(req) {
  if (AUDIT_IP === 'off') return null;
  const raw = String(req.headers['cf-connecting-ip'] || '').trim()
    || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || String(req.headers['x-real-ip'] || '').trim();
  const ip = raw.replace(/^\[|\]$/g, '').slice(0, 45);
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return null;    // never store a header verbatim
  if (AUDIT_IP === 'full') return ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d{1,3}$/, '.0/24');
  const g = ip.split(':').filter(Boolean).slice(0, 3).join(':');
  return g ? g + '::/48' : null;
}

// Retention is a cap, not an archive: age first, then the newest AUDIT_MAX of what's left.
function auditKeep(rows) {
  let out = rows;
  if (AUDIT_DAYS) { const cut = Date.now() - AUDIT_DAYS * 86400000; out = out.filter(r => r.ts >= cut); }
  if (AUDIT_MAX && out.length > AUDIT_MAX) out = out.slice(out.length - AUDIT_MAX);
  return out;
}
// Called from main() at boot (seeds auditCache/auditSeq/auditCount from Postgres) and hourly
// after that, same cadence the old file-compaction pass ran on.
function pruneAudit() {
  const keep = auditKeep(auditCache);
  auditCount = keep.length;
  if (keep.length === auditCache.length) return;
  const keepIds = new Set(keep.map(r => r.id));
  const dropIds = auditCache.filter(r => !keepIds.has(r.id)).map(r => r.id);
  auditCache = keep;
  auditDeleteIds(dropIds).catch(e => console.error('audit prune failed:', e.message));
}

// Never throws: a log that can't be written must not break signing in. The Postgres write is
// fire-and-forget (see saveDb above) — auditCache itself is updated synchronously first, so a
// GET /api/admin/audit right after this always sees the new row regardless of write timing.
function audit(req, ev, f = {}) {
  if (!AUDIT_ON) return;
  const rec = { id: ++auditSeq, ts: Date.now(), ev, ok: f.ok !== false };
  if (f.user) { rec.uid = f.user.id; rec.name = String(f.user.name || '').slice(0, 40); }
  else {
    if (f.uid) rec.uid = f.uid;
    if (f.name) rec.name = String(f.name).slice(0, 40);
  }
  if (f.target) { rec.tgt = f.target.id; rec.tname = String(f.target.name || '').slice(0, 40); }
  if (f.msg) rec.msg = String(f.msg).slice(0, 120);
  const ip = clientIp(req);
  if (ip) rec.ip = ip;
  auditCache.push(rec);
  auditCount++;
  appendAudit(rec).catch(e => console.error('audit write failed:', e.message));
  // Amortized: a 5000-event cap prunes once per ~1250 events.
  if (AUDIT_MAX && auditCount > AUDIT_MAX * 1.25) pruneAudit();
}

/* ---------- talking to the Nebula service ---------- */
// Nebula owns everything this service used to compute inline (rank/XP, anti-cheat, task
// grading, coach/box, social) — these are the two directions that crossing needs. Both are
// plain fetch() calls, not a client library: this project ships with as few dependencies as
// possible, and the surface here is tiny.
const NEBULA_URL = process.env.NEBULA_URL || 'http://api:3000';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
if (!INTERNAL_SECRET) console.error('WARNING: INTERNAL_SECRET is not set — /internal/* is unprotected');

// Fire-and-forget notifications TO Nebula (new workouts synced, an account was deleted) — never
// awaited by the route that triggers them, and a failure here is logged, never surfaced to the
// user: whatever Nebula would have done (an anti-cheat scan, an import-level cap, deleting its
// own rows for a closed account) is allowed to lag or even miss once rather than hold up this
// service's own, unrelated response.
function notifyNebula(event, payload) {
  fetch(`${NEBULA_URL}/internal/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
    body: JSON.stringify({ event, ...payload }),
  }).catch(e => console.error('notifyNebula failed:', event, e.message));
}
// Requests FROM Nebula land on the `/internal/*` routes at the bottom of this file — this checks
// the same shared secret on the way in.
function requireInternal(req, res) {
  if (!INTERNAL_SECRET || req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
    json(res, 403, { error: 'forbidden' });
    return false;
  }
  return true;
}
// The raw record minus the two genuine secrets (password hash/salt, session ids) — Nebula is a
// trusted caller, but it never needs either of those, so they're left out even here rather than
// relying on Nebula's own code to never log/forward a response it didn't ask for.
function internalUser(u) {
  const { pwd, sessions, ...rest } = u;
  return rest;
}

const routes = {
  // Identity only now — rank/perks/badges/pro used to ride along here too. The frontend calls
  // Nebula's own GET /api/me alongside this one and merges both into the same `user` shape
  // useStore already expects, so no other frontend code had to change for the split.
  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: publicUser(user) });
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    const importedNewWorkouts = mergeWorkoutsInto(user.id, body.state);
    mergeFoodDiaryInto(user.id, body.state);
    writeState(user.id, body.state);
    // Anti-cheat, the fixed-XP-budget import cap, and daily-task grading all used to run
    // inline, right here, against this same freshly-merged state — they're Nebula's now (they
    // all key off xpFor/rankFor). Best-effort and fire-and-forget on purpose: a device syncing
    // its workouts must never wait on (or fail because of) the other service being slow or down.
    notifyNebula('data-synced', { uid: user.id, importedNewWorkouts });
    // workouts/deletedWorkoutIds and foodDiary/deletedFoodEntryIds go back in the response too —
    // the merges above can add something this exact push didn't know about (logged from another
    // device meanwhile), and without handing that back, this device wouldn't see it until its
    // next full reload.
    json(res, 200, {
      ok: true, ts: body.state._ts || null,
      workouts: body.state.workouts, deletedWorkoutIds: body.state.deletedWorkoutIds,
      foodDiary: body.state.foodDiary, deletedFoodEntryIds: body.state.deletedFoodEntryIds,
    });
  },

  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length }),

  // Public config the login screen needs before anyone is signed in.


  'GET /api/config': async (req, res) => json(res, 200, { invite_only: INVITE_ONLY, allow_guest: ALLOW_GUEST, allow_register: ALLOW_REGISTER, box_location_mode: BOX_LOCATION_MODE }),

  // Public, no auth: admin-authored exercise renames (see the "exercise name overrides"
  // section below for how they're written). The catalogue itself lives only in the frontend
  // bundle — this is the only exercise-related state the backend holds — so every client,
  // signed in or guest, needs this to overlay renames onto the names it already has.


  'GET /api/exercises/overrides': async (req, res) => json(res, 200, { overrides: db.exerciseOverrides }),

  // Public, no auth: admin-configured streak-badge thresholds (day count -> tier name),
  // sorted ascending — every client needs these to know which badge a given streak earns
  // (see frontend lib/streak.js tierForDays). No perks are attached to these tiers yet
  // (see the "no upgrade yet" note on the admin write routes below) — cosmetic only for now.


  'POST /api/alpha/apply': async (req, res) => {
    const headers = corsHeaders(req);
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 60);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    const message = String(body.message || '').trim().slice(0, 500);
    if (!name) return json(res, 400, { error: 'name required' }, headers);
    if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'enter a valid email address' }, headers);
    const existing = db.alphaRequests.find(r => r.email === email && r.status !== 'dismissed');
    if (existing) { existing.name = name; existing.message = message; existing.updated = new Date().toISOString(); }
    else db.alphaRequests.push({ id: crypto.randomBytes(8).toString('base64url'), name, email, message, status: 'pending', created: new Date().toISOString() });
    saveDb();
    audit(req, 'alpha.apply', { name, msg: email });
    json(res, 200, { ok: true }, headers);
  },



  'POST /api/bugs': async (req, res) => {
    const user = readSession(req);
    const body = await readBody(req);
    const message = String(body.message || '').trim().slice(0, 1000);
    if (!message) return json(res, 400, { error: 'describe what went wrong' });
    const page = String(body.page || '').trim().slice(0, 200);
    db.bugReports.push({
      id: crypto.randomBytes(8).toString('base64url'),
      userId: user ? user.id : null,
      name: user ? user.name : null,
      email: user ? user.email : null,
      message,
      page,
      status: 'open',
      created: new Date().toISOString(),
    });
    saveDb();
    audit(req, 'bug.report', user ? { user, msg: message.slice(0, 80) } : { name: 'Anonymous', msg: message.slice(0, 80) });
    json(res, 200, { ok: true });
  },


  'POST /api/register': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(body.password || '');
    if (!name) return json(res, 400, { error: 'name required' });
    if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'enter a valid email address' });
    if (password.length < 8) return json(res, 400, { error: 'password must be at least 8 characters' });
    if (findByEmail(email)) return json(res, 409, { error: 'an account already exists for that email' });
    // A valid, unused invite code is a door of its own — it lets someone in even while
    // ALLOW_REGISTER is off, same as it always has under INVITE_ONLY. One code, one account:
    // usedBy is set the moment it's spent, so a second attempt with the same code fails here.
    const code = String(body.code || '').trim().toUpperCase();
    const invite = code ? db.invites.find(i => i.code === code && !i.usedBy && !i.revoked) : null;
    if (!ALLOW_REGISTER && !invite) return json(res, 403, { error: 'registration is closed on this instance — a valid invite code is required' });
    if (INVITE_ONLY && !invite) {
      audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      return json(res, 403, { error: 'a valid invite code is required' });
    }
    const user = { id: crypto.randomBytes(12).toString('base64url'), name, email, created: new Date().toISOString() };
    user.pwd = hashPassword(password);
    if (invite) { user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created; }
    db.users.push(user);
    saveDb();
    audit(req, 'auth.register.ok', { user, msg: invite ? invite.code : null });
    // Best-effort, same as changing your email later from Settings — a fresh account isn't
    // blocked on this, it just starts out unverified if no SMTP is configured.
    if (SMTP_CONFIGURED) {
      user.emailVerifyToken = { token: crypto.randomBytes(24).toString('base64url'), expires: Date.now() + 86400000 };
      saveDb();
      await sendMail({
        to: email, subject: 'Verify your email — Forvia',
        text: `Confirm this is your email address for your Forvia account (${name}):\n\n${ORIGIN}/api/account/verify-email?token=${user.emailVerifyToken.token}\n\nIf you didn't request this, you can ignore this message — nothing changes until the link above is opened.`,
      });
    }
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user, req) });
  },


  'POST /api/login': async (req, res) => {
    const body = await readBody(req);
    const user = findByEmail(body.email);
    // Same generic error either way — knowing an email is registered would let an attacker
    // enumerate accounts.
    const fail = msg => { audit(req, 'auth.login.fail', { ok: false, uid: user?.id, msg }); return json(res, 401, { error: 'incorrect email or password' }) }
    if (!user || !verifyPassword(String(body.password || ''), user.pwd.salt, user.pwd.hash)) return fail(user ? 'bad-password' : 'unknown-email');
    if (user.disabled) { audit(req, 'auth.login.fail', { ok: false, user, msg: 'account-disabled' }); return json(res, 403, { error: 'this account has been disabled' }) }
    audit(req, 'auth.login.ok', { user });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user, req) });
  },

  // Account info — one route per field (same convention as the /api/social/* setters):
  // each call touches exactly one thing on the signed-in account and returns the fresh
  // publicUser() so the frontend never has to guess what changed.


  'POST /api/account/name': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    // firstName/lastName (both optional strings) is the real path now — they're stored as
    // their own fields and `name` is just their join, so a compound given name never gets
    // re-split by guesswork on a later load. `name` alone is kept working for any caller
    // that still only sends that (there are none left in this app today, but it costs
    // nothing to keep accepting it and it's a cheap way to not paint a future caller into
    // this same corner).
    let name;
    if (body.firstName != null || body.lastName != null) {
      const firstName = String(body.firstName || '').trim().slice(0, 40);
      const lastName = String(body.lastName || '').trim().slice(0, 40);
      name = `${firstName} ${lastName}`.trim().slice(0, 60);
      if (!name) return json(res, 400, { error: 'name required' });
      user.firstName = firstName;
      user.lastName = lastName;
    } else {
      name = String(body.name || '').trim().slice(0, 60);
      if (!name) return json(res, 400, { error: 'name required' });
    }
    user.name = name;
    saveDb();
    audit(req, 'account.name.set', { user });
    json(res, 200, { user: publicUser(user) });
  },

  // The public handle — shown instead of (or alongside) the real name anywhere someone is
  // identified to other accounts (Social feed, public profile). Unlike name, this has to be
  // unique instance-wide, same shape of check as email above. Lowercase-normalized so
  // "JoseM" and "josem" can't both be claimed and then read as different people.


  'POST /api/account/username': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    if (!username) {
      // Clearing it back out is allowed — the public profile falls back to the real name.
      delete user.username;
      saveDb();
      audit(req, 'account.username.set', { user, msg: '(cleared)' });
      return json(res, 200, { user: publicUser(user) });
    }
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      return json(res, 400, { error: 'usernames are 3-20 characters: letters, numbers, underscore only' });
    }
    if (username !== user.username) {
      const other = db.users.find(u => u.username === username);
      if (other && other.id !== user.id) return json(res, 409, { error: 'that username is already taken' });
    }
    user.username = username;
    saveDb();
    audit(req, 'account.username.set', { user });
    json(res, 200, { user: publicUser(user) });
  },


  'POST /api/account/phone': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const phone = String(body.phone || '').trim().slice(0, 24);
    if (phone && !/^[+\d][\d\s()-]{3,23}$/.test(phone)) return json(res, 400, { error: 'that doesn\'t look like a phone number' });
    user.phone = phone || null;
    saveDb();
    audit(req, 'account.phone.set', { user });
    json(res, 200, { user: publicUser(user) });
  },

  // Up to 3 showcase badges, chosen from whatever's actually earned right now — re-checked
  // here rather than trusted from the client, same as every other perk gate in this file.
  // A milestone you later fall below (there aren't any that can regress today, but a future
  // one might) simply can't be re-selected; already-saved picks aren't retroactively pulled.
  // Only two badge types exist today — your rank tier and your prestige medal, the two
  // things that used to be shown unconditionally above this. They're not "earned or not"
  // like a real achievement would be: rank always qualifies, prestige only once you have
  // any. `picked` is positional (index = slot), nulls are empty slots, not compacted away
  // — otherwise a badge placed in slot 3 alone would silently jump to slot 1 on reload.


  'POST /api/account/avatar': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
    if (!m) return json(res, 400, { error: 'unsupported image' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) return json(res, 413, { error: 'image too large' });
    const ext = UPLOAD_MIME[m[1]];
    const file = crypto.randomBytes(10).toString('base64url') + '.' + ext;
    fs.mkdirSync(uploadsDir(user.id), { recursive: true });
    fs.writeFileSync(path.join(uploadsDir(user.id), file), buf);
    const old = user.avatarFile;
    user.avatarFile = file;
    saveDb();
    if (old) { try { fs.unlinkSync(path.join(uploadsDir(user.id), old)); } catch {} }
    audit(req, 'account.avatar.set', { user });
    json(res, 200, { user: publicUser(user) });
  },


  'POST /api/account/avatar/remove': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    if (user.avatarFile) {
      const old = user.avatarFile;
      user.avatarFile = null;
      saveDb();
      try { fs.unlinkSync(path.join(uploadsDir(user.id), old)); } catch {}
      audit(req, 'account.avatar.remove', { user });
    }
    json(res, 200, { user: publicUser(user) });
  },

  // Password only. No "remove" route: with password as the only way in, deleting it would
  // lock the account out — this only ever replaces it.


  'POST /api/account/password': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const password = String(body.password || '');
    if (password.length < 8) return json(res, 400, { error: 'password must be at least 8 characters' });
    if (!verifyPassword(String(body.currentPassword || ''), user.pwd.salt, user.pwd.hash)) {
      audit(req, 'account.password.fail', { user, msg: 'bad-current-password' });
      return json(res, 401, { error: 'your current password is incorrect' });
    }
    user.pwd = { ...user.pwd, ...hashPassword(password) };
    saveDb();
    audit(req, 'account.password.set', { user });
    json(res, 200, { user: publicUser(user) });
  },

  // Email is the login identifier now, so — unlike the old username route — this can't be
  // cleared to blank, and it has to stay unique. Changing it fires a verification link the
  // same way registration does; best-effort, same reasoning as before: if this instance has
  // no SMTP_HOST configured, the address is still saved (unverified) so it's there once an
  // admin sets one up, and `mailConfigured:false` tells the frontend not to promise a mail
  // that can't be sent.


  'POST /api/account/email': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    if (!email) return json(res, 400, { error: 'email required' });
    if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'enter a valid email address' });
    if (email === user.email) return json(res, 200, { user: publicUser(user), mailSent: false, mailConfigured: SMTP_CONFIGURED });
    const other = findByEmail(email);
    if (other && other.id !== user.id) return json(res, 409, { error: 'that email is already in use' });
    user.email = email;
    user.emailVerified = false;
    delete user.emailVerifyToken;
    user.emailVerifyToken = { token: crypto.randomBytes(24).toString('base64url'), expires: Date.now() + 86400000 };
    saveDb();
    audit(req, 'account.email.set', { user });
    const mailSent = SMTP_CONFIGURED && await sendMail({
      to: email, subject: 'Verify your email — Forvia',
      text: `Confirm this is your email address for your Forvia account (${user.name}):\n\n${ORIGIN}/api/account/verify-email?token=${user.emailVerifyToken.token}\n\nIf you didn't request this, you can ignore this message — nothing changes until the link above is opened.`,
    });
    json(res, 200, { user: publicUser(user), mailSent, mailConfigured: SMTP_CONFIGURED });
  },


  'POST /api/account/email/resend': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    if (!user.email) return json(res, 400, { error: 'no email on file' });
    if (user.emailVerified) return json(res, 400, { error: 'already verified' });
    user.emailVerifyToken = { token: crypto.randomBytes(24).toString('base64url'), expires: Date.now() + 86400000 };
    saveDb();
    const mailSent = SMTP_CONFIGURED && await sendMail({
      to: user.email, subject: 'Verify your email — Forvia',
      text: `Confirm this is your email address for your Forvia account (${user.name}):\n\n${ORIGIN}/api/account/verify-email?token=${user.emailVerifyToken.token}\n\nIf you didn't request this, you can ignore this message — nothing changes until the link above is opened.`,
    });
    json(res, 200, { mailSent, mailConfigured: SMTP_CONFIGURED });
  },

  // Opened from the email link, not the app — no session, matched by token alone. Answers
  // with a tiny standalone HTML page since whatever mail client opened it isn't running the SPA.


  'GET /api/account/verify-email': async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const token = q.get('token') || '';
    const user = db.users.find(u => u.emailVerifyToken?.token === token && u.emailVerifyToken.expires > Date.now());
    // Plain English, not run through the app's frontend i18n: this page is rendered by the
    // API itself for whatever mail client opened the link, outside the SPA entirely.
    const page = ok => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forvia</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b1710;color:#eafff0;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
div{max-width:360px}h1{font-size:20px;margin:0 0 8px}p{color:#9db8a8;line-height:1.5}</style></head>
<body><div><h1>${ok ? '✓ Email verified' : 'Link expired or invalid'}</h1>
<p>${ok ? 'You can close this tab and go back to Forvia.' : 'Ask Forvia to send you a new verification link and try again.'}</p></div></body></html>`;
    if (!user) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page(false)); }
    user.emailVerified = true;
    delete user.emailVerifyToken;
    saveDb();
    audit(req, 'account.email.verified', { user });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(true));
  },

  // Permanent, self-serve, password-gated. Removes the account, its workout history, uploaded
  // photos, and every trace of it in the social graph (follows both directions, reactions,
  // comments, task completions) — nothing left referencing an id that no longer resolves.


  'POST /api/account/delete': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!verifyPassword(String(body.password || ''), user.pwd.salt, user.pwd.hash)) {
      audit(req, 'account.delete.fail', { user, msg: 'bad-password' });
      return json(res, 401, { error: 'incorrect password' });
    }
    audit(req, 'account.delete', { user });
    const id = user.id;
    db.users = db.users.filter(u => u.id !== id);
    db.subs = db.subs.filter(s => s.userId !== id);
    saveDb();
    removeState(id);
    try { fs.rmSync(uploadsDir(id), { recursive: true, force: true }); } catch {}
    // Nebula owns follows/reactions/comments/taskCompletions/boxes/etc — best-effort, doesn't
    // block this response (deleting your own account here must never hang on the other service).
    notifyNebula('account-deleted', { uid: id });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  // Reads the session so the sign-out can be recorded, and now also removes this one device's
  // session record — a stolen cookie from before a normal sign-out no longer keeps working
  // until expiry. A logout with no valid cookie is a no-op and isn't worth an entry.


  'POST /api/logout': async (req, res) => {
    const user = readSession(req);
    if (user) {
      const parsed = parseSessionCookie(req);
      if (parsed) {
        user.sessions = (user.sessions || []).filter(s => s.id !== parsed.sid);
        saveDb();
      }
      audit(req, 'auth.logout', { user });
    }
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  // "Sign out everywhere" — empties this user's session list, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. Passkeys are untouched: signing back in works immediately.


  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sessions = [];
    saveDb();
    audit(req, 'auth.logout.all', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  // Per-device session list for Settings → Account. Touches only the CURRENT request's own
  // session record (lastSeenAt) — not on every authenticated route, to avoid a saveDb() write
  // per API call. Never returns the signed cookie token itself, only record metadata.


  'GET /api/account/sessions': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const parsed = parseSessionCookie(req);
    const sessions = user.sessions || [];
    const mine = parsed ? sessions.find(s => s.id === parsed.sid) : null;
    if (mine) { mine.lastSeenAt = new Date().toISOString(); saveDb(); }
    const list = sessions
      .map(s => ({ id: s.id, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ua: s.ua || '', current: !!parsed && s.id === parsed.sid }))
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
    json(res, 200, { sessions: list });
  },

  // Revoke one device's session. If it's the caller's own current session, also clear their
  // cookie so this device signs out immediately too (same as POST /api/logout).


  'POST /api/account/sessions/revoke': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (!id) return json(res, 400, { error: 'id required' });
    const sessions = user.sessions || [];
    const idx = sessions.findIndex(s => s.id === id);
    if (idx < 0) return json(res, 404, { error: 'session not found' });
    sessions.splice(idx, 1);
    saveDb();
    audit(req, 'account.sessions.revoke', { user });
    const parsed = parseSessionCookie(req);
    if (parsed && parsed.sid === id) return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
    json(res, 200, { ok: true });
  },


  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { state: readState(user.id) });
  },


  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),


  'POST /api/push/subscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },


  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    db.subs = db.subs.filter(s => !(s.userId === user.id && s.endpoint === body.endpoint));
    saveDb();
    json(res, 200, { ok: true });
  },


  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, { title: 'Forvia', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },


  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },


  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.


  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).


  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = db.users.map(u => {
      const S = readState(u.id) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, email: u.email || null, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), employeeTypes: employeeTypesOf(u), invitedBy: u.invitedBy || null,
        pro: !!u.pro,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id)
      };
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  // Everything about one account, for the admin drill-down — publicUser() already carries
  // name/email/phone/bio/avatarUrl/rank/perks/badges, so this only adds the fields that are
  // admin-only (created, disabled, invitedBy, the raw XP adjustment) plus their training data.


  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(u.id) || {};
    json(res, 200, {
      user: {
        ...publicUser(u),
        created: u.created || null, disabled: !!u.disabled, invitedBy: u.invitedBy || null,
        adminXpAdjust: u.adminXpAdjust || 0,
      },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse(),   // newest first for display
      // The three Free-tier counts (5 each — sheets.jsx's customFoodDefSheet/saveMealSheet/
      // createMealSheet/customExSheet) — shown so an admin can see how close someone actually
      // is to the cap they're asking about, not just flip their Pro flag blind.
      customFoodsCount: (S.customFoods || []).length,
      savedMealsCount: (S.savedMeals || []).length,
      customExCount: (S.customEx || []).length,
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    saveDb();
    audit(req, u.disabled ? 'admin.user.disable' : 'admin.user.enable', { user: admin, target: u });
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  // A user can hold several employee types at once (founder, admin) — this replaces the
  // whole set rather than toggling one, so the client always sends the full list it wants.


  'POST /api/admin/user/employee-types': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const types = Array.isArray(body.employeeTypes) ? body.employeeTypes : [];
    const invalid = types.some(t => !EMPLOYEE_TYPES.includes(t));
    if (invalid) return json(res, 400, { error: 'unknown employee type' });
    u.employeeTypes = [...new Set(types)];
    saveDb();
    audit(req, 'admin.user.employee_types', { user: admin, target: u, msg: u.employeeTypes.join(',') || '(none)' });
    json(res, 200, { ok: true, id: u.id, employeeTypes: u.employeeTypes });
  },

  // The one door left once ALLOW_REGISTER is off: same validation as POST /api/register, but
  // admin-gated instead of ALLOW_REGISTER/invite-gated, and it never signs the new account in.


  'POST /api/admin/user/create': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(body.password || '');
    if (!name) return json(res, 400, { error: 'name required' });
    if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'enter a valid email address' });
    if (password.length < 8) return json(res, 400, { error: 'password must be at least 8 characters' });
    if (findByEmail(email)) return json(res, 409, { error: 'an account already exists for that email' });
    const user = { id: crypto.randomBytes(12).toString('base64url'), name, email, created: new Date().toISOString() };
    user.pwd = hashPassword(password);
    db.users.push(user);
    saveDb();
    audit(req, 'admin.user.create', { user: admin, target: user });
    json(res, 200, { user: publicUser(user) });
  },


  'GET /api/admin/invites': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // resolve usedBy uid → name for display
    const invites = db.invites.map(i => ({
      ...i, usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },


  'POST /api/admin/invites/new': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. The app has no rate limiting by design
    // (that's the reverse proxy's job) and /api/register tells a caller whether a code is good, so
    // the code itself has to be the thing that isn't worth guessing. Codes already in db.json keep
    // working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: String(body.note || '').slice(0, 60), createdBy: admin.id, created: new Date().toISOString() };
    db.invites.push(invite);
    saveDb();
    audit(req, 'admin.invite.create', { user: admin, msg: code });
    json(res, 200, { invite });
  },


  'POST /api/admin/invites/revoke': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    saveDb();
    audit(req, 'admin.invite.revoke', { user: admin, msg: inv.code });
    json(res, 200, { ok: true });
  },

  /* ---------- alpha waitlist (admin side) ---------- */


  'GET /api/admin/alpha': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { requests: [...db.alphaRequests].reverse() });
  },
  // Generates a real single-use invite code (same table, same rules as Users → Invite codes)
  // tied to this request, but doesn't send anything itself — there's no SMTP-independent way
  // to know the admin actually wants to reach out today, so this just hands back the code and
  // a mailto: link's worth of information for them to send by hand.


  'POST /api/admin/alpha/invite': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const reqRow = db.alphaRequests.find(r => r.id === body.id);
    if (!reqRow) return json(res, 404, { error: 'no such request' });
    let code;
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: 'alpha: ' + reqRow.email, createdBy: admin.id, created: new Date().toISOString() };
    db.invites.push(invite);
    reqRow.status = 'invited';
    reqRow.invitedAt = new Date().toISOString();
    reqRow.inviteCode = code;
    saveDb();
    audit(req, 'admin.alpha.invite', { user: admin, msg: reqRow.email });
    json(res, 200, { invite, request: reqRow });
  },


  'POST /api/admin/alpha/dismiss': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const reqRow = db.alphaRequests.find(r => r.id === body.id);
    if (!reqRow) return json(res, 404, { error: 'no such request' });
    reqRow.status = 'dismissed';
    saveDb();
    audit(req, 'admin.alpha.dismiss', { user: admin, msg: reqRow.email });
    json(res, 200, { ok: true });
  },

  'GET /api/admin/bugs': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { reports: [...db.bugReports].reverse() });
  },


  'POST /api/admin/bugs/resolve': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const row = db.bugReports.find(r => r.id === body.id);
    if (!row) return json(res, 404, { error: 'no such report' });
    row.status = row.status === 'resolved' ? 'open' : 'resolved';
    saveDb();
    audit(req, 'admin.bug.resolve', { user: admin, msg: row.status + ': ' + row.message.slice(0, 60) });
    json(res, 200, { report: row });
  },


  'POST /api/admin/bugs/delete': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const row = db.bugReports.find(r => r.id === body.id);
    if (!row) return json(res, 404, { error: 'no such report' });
    db.bugReports = db.bugReports.filter(r => r.id !== body.id);
    saveDb();
    audit(req, 'admin.bug.delete', { user: admin, msg: row.message.slice(0, 60) });
    json(res, 200, { ok: true });
  },

  /* ---------- activity log ---------- */
  // Newest first, paged by id. Not by offset: the log grows at the front of this view, so an
  // offset cursor would repeat a row whenever an event lands between two pages; and not by
  // timestamp, because two events can share a millisecond. auditKeep() runs on read as well as
  // on the hourly compaction, so nothing past its retention is ever served.


  'GET /api/admin/audit': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.max(1, Math.min(200, +q.get('limit') || 100));
    const before = +q.get('before') || Infinity;
    const cat = q.get('cat') || '';
    let rows = auditKeep(auditCache).slice().reverse();
    if (cat === 'fail') rows = rows.filter(r => !r.ok);
    else if (cat) rows = rows.filter(r => String(r.ev).startsWith(cat + '.'));
    const page = rows.filter(r => r.id < before).slice(0, limit);
    json(res, 200, {
      events: page,
      total: rows.length,
      nextBefore: page.length === limit ? page[page.length - 1].id : null,
      enabled: AUDIT_ON, ip_mode: AUDIT_IP,
      retention: { max: AUDIT_MAX, days: AUDIT_DAYS },
      now: Date.now()
    });
  },

  // Deleting the log is itself logged, and auditSeq is not reset — so a clear always leaves a
  // visible gap in the ids and can't be used to quietly erase a trace. There is no export route:
  // ./data/audit.log already is the export, in a format jq reads directly.


  'POST /api/admin/audit/clear': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    auditCache = [];
    auditCount = 0;
    // Awaited (unlike every other write in this file) so the clear-event record appended by
    // audit() just below can never race a slower fire-and-forget DELETE and get wiped with it.
    try { await auditClearAll(); } catch (e) { console.error('audit clear failed:', e.message); }
    audit(req, 'admin.audit.clear', { user: admin });
    json(res, 200, { ok: true });
  },

  'POST /api/admin/exercises/override': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    const lang = String(body.lang || 'en').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 80);
    if (!id) return json(res, 400, { error: 'id is required' });
    if (!/^[a-z]{2}$/.test(lang)) return json(res, 400, { error: 'lang must be a 2-letter code' });
    db.exerciseOverrides = db.exerciseOverrides.filter(o => !(o.id === id && o.lang === lang));
    if (name) db.exerciseOverrides.push({ id, lang, name });
    saveDb();
    audit(req, 'admin.exercise.rename', { user: admin, msg: `${id} [${lang}]` + (name ? ' → ' + name : ' (reverted)') });
    json(res, 200, { overrides: db.exerciseOverrides });
  },

  'GET /api/admin/muscle-groups': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { groups: db.muscleGroups });
  },


  'POST /api/admin/muscle-groups': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const lang = String(body.lang || 'en').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return json(res, 400, { error: 'name is required' });
    if (!/^[a-z]{2}$/.test(lang)) return json(res, 400, { error: 'lang must be a 2-letter code' });
    const group = { id: crypto.randomBytes(9).toString('base64url'), name: { [lang]: name }, exerciseIds: [], created: new Date().toISOString() };
    db.muscleGroups.push(group);
    saveDb();
    audit(req, 'admin.muscleGroup.create', { user: admin, msg: `${group.id} [${lang}] ${name}` });
    json(res, 200, { groups: db.muscleGroups });
  },


  'POST /api/admin/muscle-groups/rename': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    const lang = String(body.lang || 'en').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 60);
    if (!/^[a-z]{2}$/.test(lang)) return json(res, 400, { error: 'lang must be a 2-letter code' });
    const group = db.muscleGroups.find(g => g.id === id);
    if (!group) return json(res, 404, { error: 'group not found' });
    if (name) group.name = { ...group.name, [lang]: name };
    else { group.name = { ...group.name }; delete group.name[lang]; }
    saveDb();
    audit(req, 'admin.muscleGroup.rename', { user: admin, msg: `${id} [${lang}] → ${name || '(cleared)'}` });
    json(res, 200, { groups: db.muscleGroups });
  },


  'POST /api/admin/muscle-groups/remove': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const group = db.muscleGroups.find(g => g.id === body.id);
    db.muscleGroups = db.muscleGroups.filter(g => g.id !== body.id);
    saveDb();
    audit(req, 'admin.muscleGroup.remove', { user: admin, msg: group ? (Object.values(group.name)[0] || group.id) : body.id });
    json(res, 200, { groups: db.muscleGroups });
  },


  'POST /api/admin/muscle-groups/add-exercise': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const group = db.muscleGroups.find(g => g.id === body.id);
    if (!group) return json(res, 404, { error: 'group not found' });
    const exId = String(body.exerciseId || '').trim();
    if (!exId) return json(res, 400, { error: 'exerciseId is required' });
    if (!group.exerciseIds.includes(exId)) group.exerciseIds.push(exId);
    saveDb();
    audit(req, 'admin.muscleGroup.addExercise', { user: admin, msg: `${exId} → ${group.id}` });
    json(res, 200, { groups: db.muscleGroups });
  },


  'POST /api/admin/muscle-groups/remove-exercise': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const group = db.muscleGroups.find(g => g.id === body.id);
    if (!group) return json(res, 404, { error: 'group not found' });
    const exId = String(body.exerciseId || '').trim();
    group.exerciseIds = group.exerciseIds.filter(x => x !== exId);
    saveDb();
    audit(req, 'admin.muscleGroup.removeExercise', { user: admin, msg: `${exId} ✕ ${group.id}` });
    json(res, 200, { groups: db.muscleGroups });
  },
  // Bulk replace — same idea as add/remove-exercise but for a whole set at once, so seeding a
  // group from a body part (AdminMuscleGroups.jsx "Seed from body parts") is one request per
  // group instead of one per exercise.


  'POST /api/admin/muscle-groups/set-exercises': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const group = db.muscleGroups.find(g => g.id === body.id);
    if (!group) return json(res, 404, { error: 'group not found' });
    const ids = Array.isArray(body.exerciseIds) ? body.exerciseIds : [];
    group.exerciseIds = [...new Set(ids.map(String))];
    saveDb();
    audit(req, 'admin.muscleGroup.setExercises', { user: admin, msg: `${group.id}: ${group.exerciseIds.length} exercises` });
    json(res, 200, { groups: db.muscleGroups });
  },

  // Today's catalog for the signed-in user, with per-task completion state. Completions
  // are per calendar day (server-local date), so the checklist clears itself overnight
  // with no cron job — "today" is just a different string tomorrow. done is only ever
  // set by scanForTasks (called from PUT /api/data) — this route is read-only.


  'GET /api/uploads': async (req, res) => {
    const me = readSession(req);
    if (!me) return json(res, 401, { error: 'not signed in' });
    const q = new URL(req.url, 'http://x').searchParams;
    const uid = q.get('uid') || '', file = q.get('file') || '';
    if (uid !== me.id && !isPublic(uid)) return json(res, 404, { error: 'not found' });
    if (!/^[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(file)) return json(res, 404, { error: 'not found' });
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const mime = Object.entries(UPLOAD_MIME).find(([, e]) => e === ext)?.[0] || 'application/octet-stream';
    fs.readFile(path.join(uploadsDir(uid), file), (err, buf) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
      res.end(buf);
    });
  },
};

/* ---------- internal API (Nebula only, never exposed publicly — see nginx config) ---------- */
// Everything Nebula needs from this service that isn't already public: resolving a session
// cookie to a user, reading/patching the handful of fields on `users` that Nebula's features
// still read/write (coach/pro/prestige/streak/badges — see publicUser's own comment on why a
// full profile-table split wasn't part of this first pass), listing/searching accounts, and
// reading a user's synced state (workouts, for XP/streak/anti-cheat/the social feed).
const internalRoutes = {
  // Body: { cookie } — the raw Cookie header value from the original browser request (Nebula
  // forwards it as-is, it never tries to parse gymsid itself). Returns the user's public shape
  // (same as GET /api/me) so Nebula never needs a second round trip just to get a name/avatar.
  'POST /internal/session': async (req, res) => {
    if (!requireInternal(req, res)) return;
    const body = await readBody(req);
    const fakeReq = { headers: { cookie: String(body.cookie || '') } };
    const user = readSession(fakeReq);
    if (!user) return json(res, 200, { user: null });
    json(res, 200, { user: publicUser(user) });
  },

  // The raw user record — deliberately NOT publicUser() here, since Nebula needs fields
  // publicUser never exposed to a browser (coach/coachVisible/hourlyRate/pro/prestigeConfirmed/
  // prestigeBaselineXp/adminXpAdjust/streakBonus/badges/employeeTypes/username/name/avatarFile).
  'GET /internal/user': async (req, res) => {
    if (!requireInternal(req, res)) return;
    const uid = new URL(req.url, 'http://x').searchParams.get('uid') || '';
    const u = db.users.find(x => x.id === uid);
    if (!u) return json(res, 404, { error: 'not found' });
    json(res, 200, { user: internalUser(u) });
  },
  // Every account, raw — for a leaderboard, the coach marketplace, or the admin user list to
  // join Nebula's own per-user data against. Small enough at self-hosted scale to just send
  // the whole list, same reasoning as every other "self-hosted instance" bulk-fetch in this
  // codebase.
  'GET /internal/users': async (req, res) => {
    if (!requireInternal(req, res)) return;
    json(res, 200, { users: db.users.map(internalUser) });
  },
  // Backs Nebula's own @username search (add staff, add athlete by handle) — same matching
  // rule the old single-service GET /api/users/search used.
  'GET /internal/users/search': async (req, res) => {
    if (!requireInternal(req, res)) return;
    const raw = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim().replace(/^@/, '').toLowerCase();
    if (raw.length < 2) return json(res, 200, { users: [] });
    const users = db.users.filter(u => !u.disabled && u.username && u.username.toLowerCase().includes(raw)).slice(0, 8);
    json(res, 200, { users: users.map(internalUser) });
  },
  // Merges `patch` onto the user's raw record and saves — Nebula's only write access to this
  // service's data. No field whitelist enforced here: Nebula is a trusted internal caller (the
  // shared secret is the boundary), same trust level this whole app already gives any of its
  // own route handlers direct `db` access.
  'POST /internal/user': async (req, res) => {
    if (!requireInternal(req, res)) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.uid);
    if (!u) return json(res, 404, { error: 'not found' });
    Object.assign(u, body.patch || {});
    saveDb();
    json(res, 200, { ok: true });
  },
  // A user's synced state — Nebula reads this for XP/streak calc, anti-cheat, the import-level
  // cap, task grading, and the social feed's workout cards. Read-only: Nebula never writes here,
  // this service is the only owner of user_state.
  'GET /internal/state': async (req, res) => {
    if (!requireInternal(req, res)) return;
    const uid = new URL(req.url, 'http://x').searchParams.get('uid') || '';
    json(res, 200, { state: readState(uid) || null });
  },
  // Bulk version of the above — Nebula's own stateCache mirror uses this once at boot (same
  // shape/reasoning as this service's own loadAllStates(), just fetched over HTTP instead of
  // straight from Postgres) and keeps it fresh from there on via the data-synced event this
  // service fires from PUT /api/data, not by polling this route again.
  'GET /internal/states': async (req, res) => {
    if (!requireInternal(req, res)) return;
    const states = {};
    for (const [uid, state] of stateCache) states[uid] = state;
    json(res, 200, { states });
  },
};

/* ---------- boot ---------- */
// Nothing above this point talks to Postgres — db/stateCache/auditCache are just declared, and
// the HTTP server doesn't start listening until they're actually populated, so no request can
// ever observe an empty in-memory mirror.
async function main() {
  await ensureSchema();
  db = await loadAll();
  for (const [uid, state] of await loadAllStates()) stateCache.set(uid, state);
  if (AUDIT_ON) {
    auditCache = await auditAll();
    auditSeq = auditCache.length ? auditCache[auditCache.length - 1].id : 0;
    auditCount = auditCache.length;
    pruneAudit();                                // prune on boot, mirrors the old file-compaction pass
    setInterval(pruneAudit, 3600000).unref();    // honour AUDIT_DAYS on an idle instance too
  }
  setInterval(reminderTick, 10000).unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = req.method + ' ' + url.pathname;
    const handler = url.pathname.startsWith('/internal/') ? internalRoutes[key] : routes[key];
    if (!handler) return json(res, 404, { error: 'not found' });
    try { await handler(req, res); }
    catch (e) {
      console.error(key, e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });

  server.listen(PORT, () => console.log(`forvia-core on :${PORT} (origin=${ORIGIN})`));
}

main().catch(e => { console.error('boot failed:', e); process.exit(1); });
