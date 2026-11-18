import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlobNotFoundError, BlobPreconditionFailedError, get, head, put } from '@vercel/blob';

const path = 'pm-sync/state-v1.json';
const cookieName = '__Host-pm-sync';
const sessionLifetime = 60 * 24 * 60 * 60;
const linkLifetime = 10 * 60;
const sessionPurpose = 'pm-sync-v1';
const linkPurpose = 'pm-sync-link-v1';
const maxSnapshotBytes = 2 * 1024 * 1024;
const chemIds = new Set(['화7', '화8', '화9', '화13', '화14', 'P1B화1']);
const pulseIds = new Set(['전기동 9라인 (펄스)', '전기동 20라인 (펄스)', '전기동 21라인 (펄스)', 'MSF 전기동']);
const flagFields = ['equipWorkFlags', 'elecDummyFlags', 'pulseProcessFlags', 'elecCompletedFlags', 'inlineDesmearFlags'];
const stateFields = ['chemList', 'pulseList', 'manualNotes', ...flagFields];
const blockedKeys = new Set(['__proto__', 'constructor', 'prototype']);

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function result(status, body, headers) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  });
}

function getConfig(env) {
  const { PM_SYNC_ORIGIN: origin, PM_SYNC_CODE_SHA256: codeHash, PM_SYNC_SESSION_SECRET: secret, BLOB_READ_WRITE_TOKEN: token } = env;
  if (!/^https:\/\/[^/]+$/.test(origin ?? '') || !/^[a-f0-9]{64}$/.test(codeHash ?? '') ||
      typeof secret !== 'string' || secret.length < 32 || !token) {
    return null;
  }
  return { origin, codeHash, secret, token };
}

function tokenSignature(purpose, value, { codeHash, secret }) {
  return createHmac('sha256', secret).update(`${purpose}:${codeHash}:${value}`).digest();
}

function sessionCookie(value, maxAge) {
  return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function issueToken(purpose, lifetime, config, now) {
  const expires = Math.floor(now() / 1000) + lifetime;
  const value = `${expires}.${randomBytes(16).toString('base64url')}`;
  const signature = tokenSignature(purpose, value, config).toString('base64url');
  return { token: `${value}.${signature}`, expiresAt: new Date(expires * 1000).toISOString() };
}

function hasSignedToken(value, purpose, config, now) {
  const match = /^(\d{10})\.([\w-]{22})\.([\w-]{43})$/.exec(value);
  if (!match || Number(match[1]) <= Math.floor(now() / 1000)) return false;
  const expected = tokenSignature(purpose, `${match[1]}.${match[2]}`, config);
  const supplied = Buffer.from(match[3], 'base64url');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function issueSession(config, now) {
  const { token } = issueToken(sessionPurpose, sessionLifetime, config, now);
  return sessionCookie(token, sessionLifetime);
}

function hasSession(request, config, now) {
  const pair = request.headers.get('cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${cookieName}=`));
  return hasSignedToken(pair?.slice(cookieName.length + 1) ?? '', sessionPurpose, config, now);
}

function hasLinkToken(value, config, now) {
  return typeof value === 'string' && value.startsWith('p.') &&
    hasSignedToken(value.slice(2), linkPurpose, config, now);
}

function hasAccessCode(value, expectedHash) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(value.trim())) return false;
  const suppliedHash = createHash('sha256').update(value.trim()).digest();
  return timingSafeEqual(suppliedHash, Buffer.from(expectedHash, 'hex'));
}

async function readJson(stream, maxBytes) {
  if (!stream) throw new RequestError(400, 'invalid_json');
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestError(413, 'record_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new RequestError(400, 'invalid_json');
  }
}

async function requestJson(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new RequestError(415, 'json_required');
  }
  if (Number(request.headers.get('content-length')) > limit) {
    throw new RequestError(413, 'record_too_large');
  }
  const body = await readJson(request.body, limit);
  if (!isObject(body)) throw new RequestError(400, 'invalid_json');
  return body;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTree(value, depth = 0) {
  if (depth > 40) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => !blockedKeys.has(key) && validTree(child, depth + 1));
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function validDateTime(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-][01]\d:[0-5]\d)?$/.test(value) ||
      !validDay(value.slice(0, 10))) return false;
  const withZone = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}+09:00`;
  return Number.isFinite(Date.parse(withZone));
}

function coversIds(rows, key, ids) {
  return Array.isArray(rows) && rows.length === ids.size &&
    new Set(rows.map(row => row?.[key])).size === ids.size &&
    rows.every(row => isObject(row) && ids.has(row[key]));
}

function validSnapshot(state) {
  if (!isObject(state) || Object.keys(state).length !== stateFields.length ||
      !stateFields.every(field => Object.hasOwn(state, field)) || !validTree(state)) return false;
  const { chemList, pulseList, manualNotes } = state;
  if (!coversIds(chemList, 'id', chemIds) || !chemList.every(line =>
    ['시작', '완료'].includes(line.status) && validDateTime(line.lastDone) && typeof line.note === 'string' &&
    (line.needsReview === undefined || typeof line.needsReview === 'boolean') &&
    ['plannedDue', 'backlightPmAt', 'previousCompletion'].every(field => line[field] == null || validDateTime(line[field]))
  )) return false;
  if (!coversIds(pulseList, 'line', pulseIds) || !pulseList.every(line => validDay(line.lastDate))) return false;
  if (!Array.isArray(manualNotes) || !manualNotes.every(note => isObject(note) &&
    typeof note.line === 'string' && note.line.trim() && typeof note.text === 'string' && note.text.trim() && validDay(note.date)
  )) return false;
  return flagFields.every(field => isObject(state[field]) && Object.values(state[field]).every(flag => {
    if (field === 'elecCompletedFlags') return typeof flag === 'boolean' || (isObject(flag) && validDateTime(flag.completedAt));
    if (field === 'equipWorkFlags' && typeof flag === 'boolean') return true;
    return isObject(flag);
  }));
}

function validRevision(value) {
  // One strong ETag. Never accept a wildcard or a list of candidate versions.
  return typeof value === 'string' &&
    /^(?:"[A-Za-z0-9._:-]{1,160}"|[A-Za-z0-9._:-]{1,160})$/.test(value);
}

async function readSnapshot(blob, config, ifNoneMatch) {
  const stored = await blob.get(path, {
    access: 'private', token: config.token, useCache: false, ifNoneMatch,
    abortSignal: AbortSignal.timeout(10000)
  });
  if (!stored) return result(200, { revision: null, state: null });
  const revision = stored.blob.etag;
  if (!validRevision(revision)) throw new Error('Missing snapshot revision');
  if (stored.statusCode === 304) {
    return new Response(null, {
      status: 304,
      headers: { 'Cache-Control': 'private, no-store', 'ETag': revision }
    });
  }
  const state = await readJson(stored.stream, maxSnapshotBytes);
  if (!validSnapshot(state)) throw new Error('Invalid saved snapshot');
  return result(200, { revision, state }, { 'ETag': revision });
}

async function writeSnapshot(request, blob, config) {
  const { revision, state } = await requestJson(request, maxSnapshotBytes);
  if (!(revision === null || validRevision(revision)) || !validSnapshot(state)) {
    throw new RequestError(400, 'invalid_record');
  }
  const options = {
    access: 'private', token: config.token, contentType: 'application/json',
    addRandomSuffix: false, cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(10000)
  };
  try {
    const saved = await blob.put(path, JSON.stringify(state), revision === null
      ? { ...options, allowOverwrite: false }
      : { ...options, ifMatch: revision, allowOverwrite: true });
    if (!validRevision(saved.etag)) throw new Error('Missing saved revision');
    return result(200, { revision: saved.etag }, { 'ETag': saved.etag });
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError || (revision !== null && error instanceof BlobNotFoundError)) {
      return result(409, { error: 'revision_conflict' });
    }
    if (revision === null) {
      // SDK 2.9 exposes create collisions as a generic error. Check whether a
      // simultaneous initializer won, without fetching or returning the record.
      try {
        await blob.head(path, { token: config.token, abortSignal: AbortSignal.timeout(10000) });
        return result(409, { error: 'revision_conflict' });
      } catch {
        // Preserve the original error if the store cannot confirm a record.
      }
    }
    throw error;
  }
}

export function makeHandler({ env = process.env, blob = { get, put, head }, now = Date.now } = {}) {
  return async function handleRequest(request) {
    const config = getConfig(env);
    if (!config) return result(503, { error: 'sync_unavailable' });
    const method = request.method;
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
      return result(405, { error: 'method_not_allowed' }, { 'Allow': 'GET, POST, PUT, DELETE' });
    }
    const origin = request.headers.get('origin');
    if (new URL(request.url).origin !== config.origin ||
        ((method !== 'GET' || origin !== null) && origin !== config.origin)) {
      return result(403, { error: 'origin_not_allowed' });
    }
    try {
      if (method === 'POST') {
        const { action, accessCode } = await requestJson(request, 2048);
        if (action === 'create-link') {
          if (!hasSession(request, config, now)) throw new RequestError(401, 'sign_in_required');
          const { token, expiresAt } = issueToken(linkPurpose, linkLifetime, config, now);
          return result(200, { token: `p.${token}`, expiresAt });
        }
        if (action !== 'login') throw new RequestError(400, 'invalid_action');
        if (!hasLinkToken(accessCode, config, now) && !hasAccessCode(accessCode, config.codeHash)) {
          throw new RequestError(401, 'invalid_access_code');
        }
        return result(200, { ok: true }, { 'Set-Cookie': issueSession(config, now) });
      }
      if (method === 'DELETE') {
        return result(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
      }
      if (!hasSession(request, config, now)) return result(401, { error: 'sign_in_required' });
      if (method === 'PUT') return await writeSnapshot(request, blob, config);
      const cached = request.headers.get('if-none-match');
      return await readSnapshot(blob, config, validRevision(cached) ? cached : undefined);
    } catch (error) {
      // Provider error messages can contain operational details. Never return
      // them to the browser or log a request's secret or PM data.
      if (error instanceof RequestError && method !== 'GET') {
        return result(error.status, { error: error.message });
      }
      return result(503, { error: 'storage_unavailable' });
    }
  };
}

export default { fetch: makeHandler() };
