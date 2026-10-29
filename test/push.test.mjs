// Web push through the real web-push library: VAPID key, subscription, and a notification that
// actually arrives encrypted for the subscriber and decrypts to what the server meant to send.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, startServer, register, client, makeTlsCert, startPushReceiver, makeSubscription, decryptPush, waitFor } from './helpers.mjs';

const tls = makeTlsCert();
let db, server, receiver;
before(async () => {
  db = await createDatabase();
  if (tls) receiver = await startPushReceiver(tls);
  server = await startServer({ databaseUrl: db.url, env: tls ? { NODE_EXTRA_CA_CERTS: tls.cert } : {} });
});
after(async () => { await server?.stop(); await receiver?.close(); await db?.drop(); });

test('publishes a P-256 VAPID public key', async () => {
  const r = await client(server.url).get('/api/push/public-key');
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.body.key, 'base64url').length, 65);
});

test('rejects an incomplete subscription', async () => {
  const { c } = await register(server.url);
  assert.equal((await c.post('/api/push/subscribe', { subscription: { endpoint: 'https://x' } })).status, 400);
});

test('a test notification is delivered, signed and decryptable', { skip: !tls && 'openssl not installed' }, async () => {
  const { c } = await register(server.url);
  const sub = makeSubscription(receiver.url + '/push/device-1');
  assert.equal((await c.post('/api/push/subscribe', sub)).status, 200);
  assert.equal((await c.post('/api/push/test')).status, 200);

  const msg = await waitFor(() => receiver.received.find(r => r.path === '/push/device-1'), { what: 'push delivery' });
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  const publicKey = (await client(server.url).get('/api/push/public-key')).body.key;
  assert.match(msg.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${publicKey}$`));
  const payload = JSON.parse(decryptPush(msg.body, sub));
  assert.equal(payload.tag, 'test');
});

test('unsubscribing stops delivery', { skip: !tls && 'openssl not installed' }, async () => {
  const { c } = await register(server.url);
  const sub = makeSubscription(receiver.url + '/push/device-2');
  await c.post('/api/push/subscribe', sub);
  assert.equal((await c.post('/api/push/unsubscribe', { endpoint: sub.subscription.endpoint })).status, 200);
  await c.post('/api/push/test');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!receiver.received.some(r => r.path === '/push/device-2'));
});
