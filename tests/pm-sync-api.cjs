const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const origin = 'https://pm-example.test';
const accessCode = 'test-code-1234567890-abcdefg';
const env = {
  PM_SYNC_ORIGIN: origin,
  PM_SYNC_CODE_SHA256: createHash('sha256').update(accessCode).digest('hex'),
  PM_SYNC_SESSION_SECRET: 'testing-signature-key-not-a-live-credential',
  BLOB_READ_WRITE_TOKEN: 'mock-blob-token'
};

function state() {
  return {
    chemList: ['화7', '화8', '화9', '화13', '화14', 'P1B화1'].map(id => ({
      id, status: '완료', lastDone: '2026-11-20T18:30', note: '', needsReview: false
    })),
    pulseList: ['전기동 9라인 (펄스)', '전기동 20라인 (펄스)', '전기동 21라인 (펄스)', 'MSF 전기동']
      .map(line => ({ line, lastDate: '2026-11-18' })),
    manualNotes: [{ line: '전9', date: '2026-11-21', text: '필터 교체' }],
    equipWorkFlags: { '전기동-9': true }, elecDummyFlags: {}, pulseProcessFlags: {}, elecCompletedFlags: {},
    inlineDesmearFlags: {}
  };
}

async function fixture(overrides = {}) {
  const { makeHandler } = await import('../api/pm-sync.mjs');
  const { BlobNotFoundError, BlobPreconditionFailedError } = await import('@vercel/blob');
  let saved = null;
  let version = 0;
  let now = initialTime;
  const blob = {
    async get(path, options) {
      assert.equal(path, 'pm-sync/state-v1.json');
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      if (!saved) return null;
      if (options.ifNoneMatch === saved.etag) return { statusCode: 304, blob: saved };
      return { statusCode: 200, blob: saved, stream: new Response(saved.text).body };
    },
    async put(path, text, options) {
      assert.equal(path, 'pm-sync/state-v1.json');
      assert.equal(options.access, 'private');
      assert.equal(options.addRandomSuffix, false);
      if (options.allowOverwrite) {
        assert.ok(options.ifMatch);
        if (options.ifMatch !== saved?.etag) throw new BlobPreconditionFailedError();
      } else {
        assert.equal(options.ifMatch, undefined);
        if (saved) throw new Error('The blob already exists');
      }
      saved = { text, etag: `"${++version}"` };
      return saved;
    },
    async head() {
      if (!saved) throw new BlobNotFoundError();
      return saved;
    }
  };
  const handle = makeHandler({ env: { ...env }, now: () => now, blob, ...overrides });
  function request(method = 'GET', { cookie, body, headers = {}, site = origin } = {}) {
    return handle(new Request(`${site}/api/pm-sync`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method === 'GET' ? {} : { Origin: site }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    }));
  }
  async function signIn() {
    const response = await request('POST', { body: { action: 'login', accessCode } });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  return { request, signIn, blob, setTime: value => { now = value; } };
}

const initialTime = 1795107600000;

test('only an authenticated session on the production origin can read or update the snapshot', async () => {
  const a = await fixture();
  const empty = { revision: null, state: state() };
  assert.equal((await a.request()).status, 401);
  assert.equal((await a.request('PUT', { body: empty })).status, 401);
  assert.equal((await a.request('POST', { body: { action: 'login', accessCode: 'incorrect-code-1234567890' } })).status, 401);
  const signed = await a.request('POST', { body: { action: 'login', accessCode } });
  assert.equal(signed.status, 200);
  const cookieHeader = signed.headers.get('set-cookie');
  assert.match(cookieHeader, /^__Host-pm-sync=.*; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  const cookie = cookieHeader.split(';')[0];
  assert.equal(signed.headers.get('cache-control'), 'private, no-store');
  const tampered = cookie.replace(/(\d{10})\./, '1999999999.');
  assert.equal((await a.request('GET', { cookie: tampered })).status, 401);
  assert.equal((await a.request('GET', { cookie, site: 'https://pm-preview.test' })).status, 403);
  assert.equal((await a.request('PUT', { cookie, body: empty, headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await a.request('PUT', { cookie, body: empty, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const logout = await a.request('DELETE', { cookie });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  a.setTime(2000000000000);
  assert.equal((await a.request('GET', { cookie })).status, 401);
  const disabled = await fixture({ env: {} });
  assert.equal((await disabled.request()).status, 503);
});

test('a connected device can grant a short-lived link to a second device', async () => {
  const a = await fixture();
  const create = { action: 'create-link' };
  const login = accessCode => a.request('POST', { body: { action: 'login', accessCode } });
  assert.equal((await a.request('POST', { body: create })).status, 401);

  const first = await a.signIn();
  assert.equal((await a.request('POST', { cookie: first, body: create, headers: { Origin: 'https://other.test' } })).status, 403);
  const issued = await a.request('POST', { cookie: first, body: create });
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get('cache-control'), 'private, no-store');
  const { token, expiresAt } = await issued.json();
  assert.match(token, /^p\.\d{10}\.[\w-]{22}\.[\w-]{43}$/);
  assert.equal(Date.parse(expiresAt), initialTime + 600_000);

  const session = first.split('=')[1];
  assert.equal((await login(`p.${session}`)).status, 401);
  assert.equal((await a.request('GET', { cookie: `__Host-pm-sync=${token.slice(2)}` })).status, 401);
  const tampered = token.replace(/^(.+\.)([A-Za-z0-9_-])/, (_, prefix, firstChar) =>
    `${prefix}${firstChar === 'A' ? 'B' : 'A'}`);
  assert.equal((await login(tampered)).status, 401);

  const joined = await login(token);
  assert.equal(joined.status, 200);
  const second = joined.headers.get('set-cookie').split(';')[0];
  assert.notEqual(first, second);
  const snapshot = state();
  assert.equal((await a.request('PUT', { cookie: first, body: { revision: null, state: snapshot } })).status, 200);
  assert.deepEqual((await (await a.request('GET', { cookie: second })).json()).state, snapshot);

  a.setTime(Date.parse(expiresAt));
  const expired = await login(token);
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.has('set-cookie'), false);
  assert.equal((await a.request('GET', { cookie: second })).status, 200);
});

test('two devices share one state, and simultaneous saves and initialization cannot overwrite it', async () => {
  const a = await fixture();
  const phone = await a.signIn();
  const laptop = await a.signIn();
  assert.notEqual(phone, laptop);
  assert.deepEqual(await (await a.request('GET', { cookie: laptop })).json(), { revision: null, state: null });

  const initial = state();
  const other = state();
  other.manualNotes[0].text = '점검';
  const competingInitializations = await Promise.all([
    a.request('PUT', { cookie: phone, body: { revision: null, state: initial } }),
    a.request('PUT', { cookie: laptop, body: { revision: null, state: other } })
  ]);
  assert.deepEqual(competingInitializations.map(response => response.status).sort(), [200, 409]);
  const { revision, state: current } = await (await a.request('GET', { cookie: laptop })).json();
  assert.deepEqual(current, competingInitializations[0].ok ? initial : other);
  const unchanged = await a.request('GET', { cookie: laptop, headers: { 'If-None-Match': revision } });
  assert.equal(unchanged.status, 304);

  const completed = structuredClone(current);
  completed.chemList[0].lastDone = '2026-11-21T02:12:00.000Z';
  completed.inlineDesmearFlags['completion:화13:2026-11-21T02:12:00.000Z'] = { version: 2, lineId: '화13' };
  const later = structuredClone(current);
  later.manualNotes[0].text = '두번째 기기 변경';
  const changes = await Promise.all([
    a.request('PUT', { cookie: phone, body: { revision, state: completed } }),
    a.request('PUT', { cookie: laptop, body: { revision, state: later } })
  ]);
  assert.deepEqual(changes.map(response => response.status).sort(), [200, 409]);
  const latest = await (await a.request('GET', { cookie: laptop })).json();
  assert.notEqual(latest.revision, revision);
  assert.deepEqual(latest.state, changes[0].ok ? completed : later);
});

test('malformed backups and unsafe revision syntax do not produce a partial write', async () => {
  const a = await fixture();
  const cookie = await a.signIn();
  const valid = state();
  const broken = state();
  broken.chemList[2].lastDone = '2026-11-31T09:00';
  const polluted = state();
  polluted.equipWorkFlags = JSON.parse('{"n":{"__proto__":{"x":1}}}');
  for (const payload of [
    { revision: '*', state: valid },
    { revision: '"a", "b"', state: valid },
    { revision: null, state: broken },
    { revision: null, state: polluted },
    { revision: null, state: { ...valid, pulseList: [] } }
  ]) {
    const response = await a.request('PUT', { cookie, body: payload });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_record');
  }
  const tooLarge = { ...valid, manualNotes: [{ ...valid.manualNotes[0], text: 'x'.repeat(2 * 1024 * 1024) }] };
  assert.equal((await a.request('PUT', { cookie, body: { revision: null, state: tooLarge } })).status, 413);
  assert.deepEqual(await (await a.request('GET', { cookie })).json(), { revision: null, state: null });
});
