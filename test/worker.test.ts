import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { type Env } from '../src/worker.ts';

function makeEnv(allow = true) {
  const store = new Map<string, string>();
  const env: Env = {
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    WAITLIST: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } },
    WAITLIST_LIMITER: { limit: async () => ({ success: allow }) },
  };
  return { env, store };
}
const post = (body: string, type: string) =>
  new Request('https://tradetill.com/api/waitlist', { method: 'POST', headers: { 'content-type': type, 'cf-connecting-ip': '203.0.113.9' }, body });
const json = (o: unknown) => post(JSON.stringify(o), 'application/json');

test('JSON signup is stored and answers {ok:true}', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(json({ email: ' Pat@Example.com ', fsm: 'Jobber', source: 'tradetill.com', page: '/', company: '' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const saved = JSON.parse(store.get('email:pat@example.com')!);
  assert.equal(saved.fsm, 'Jobber');
  assert.equal(saved.page, '/');
});

test('repeat signup keeps the first record', async () => {
  const { env, store } = makeEnv();
  await worker.fetch(json({ email: 'a@b.co', fsm: 'Jobber' }), env);
  await worker.fetch(json({ email: 'a@b.co', fsm: 'Other' }), env);
  assert.equal(JSON.parse(store.get('email:a@b.co')!).fsm, 'Jobber');
});

test('bad email answers invalid_email, the error the client handles', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(json({ email: 'nope' }), env);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: 'invalid_email' });
  assert.equal(store.size, 0);
});

test('filled honeypot looks like success but stores nothing', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(json({ email: 'bot@spam.io', company: 'Acme' }), env);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(store.size, 0);
});

test('rate-limited request is refused before storing', async () => {
  const { env, store } = makeEnv(false);
  const res = await worker.fetch(json({ email: 'a@b.co' }), env);
  assert.equal(res.status, 429);
  assert.equal(store.size, 0);
});

test('no-JS form post is stored and gets an HTML confirmation', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(post('email=c%40d.io&fsm=ServiceTitan&company=', 'application/x-www-form-urlencoded'), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/html/);
  assert.match(await res.text(), /on the list/);
  assert.ok(store.has('email:c@d.io'));
});

test('malformed JSON and unknown content types are bad_request', async () => {
  const { env } = makeEnv();
  assert.equal((await worker.fetch(post('{', 'application/json'), env)).status, 400);
  assert.equal((await worker.fetch(post('x', 'text/plain'), env)).status, 400);
});

test('GET /api/waitlist is 405; other /api paths 404; pages fall through to assets', async () => {
  const { env } = makeEnv();
  assert.equal((await worker.fetch(new Request('https://tradetill.com/api/waitlist'), env)).status, 405);
  assert.equal((await worker.fetch(new Request('https://tradetill.com/api/other', { method: 'POST' }), env)).status, 404);
  assert.equal(await (await worker.fetch(new Request('https://tradetill.com/'), env)).text(), 'asset');
});
