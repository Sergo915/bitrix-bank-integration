import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { env } from '../config/env.js';
import { assertAllowedBitrixDomain } from './bitrixDomain.js';
import { runWithBitrixSession } from './bitrixContext.js';

const sessions = new Map();
const installationStorePath = resolve(env.BITRIX_INSTALLATION_STORE_PATH ?? 'data/bitrix-installations.json');
const sessionStorePath = resolve(env.BITRIX_SESSION_STORE_PATH ?? 'data/bitrix-sessions.json');
let installationTokensPromise;
let sessionWriteQueue = Promise.resolve();
let sessionWritePending = false;

// Sessions used to live only in this process, so every deploy or crash silently signed
// everyone out and the next click came back 401. They are small and short-lived, so the whole
// map is rewritten at once; the file holds OAuth tokens and is written owner-only.
export async function loadPersistedSessions() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(sessionStorePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Ignoring unreadable Bitrix session store at ${sessionStorePath}:`, error.message);
    }
    return 0;
  }

  const now = Date.now();
  let restored = 0;

  for (const session of Array.isArray(parsed) ? parsed : []) {
    if (!session?.id || !session.auth || !(session.expiresAt > now)) continue;
    sessions.set(session.id, {
      ...session,
      cookieIssuedAt: session.cookieIssuedAt ?? session.lastSeenAt ?? now
    });
    restored += 1;
  }

  return restored;
}

function persistSessions() {
  // Several requests can touch sessions in the same tick; one write covers them all.
  if (sessionWritePending) return sessionWriteQueue;
  sessionWritePending = true;

  sessionWriteQueue = sessionWriteQueue.then(async () => {
    sessionWritePending = false;
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id);
    }

    const snapshot = JSON.stringify([...sessions.values()]);
    try {
      await mkdir(dirname(sessionStorePath), { recursive: true });
      const temporaryPath = `${sessionStorePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, sessionStorePath);
    } catch (error) {
      console.error('Could not persist Bitrix sessions:', error.message);
    }
  });

  return sessionWriteQueue;
}

export function normalizeBitrixAuth(body = {}, query = {}) {
  const bodySource = body.auth && typeof body.auth === 'object' ? body.auth : body;
  const sources = [bodySource, query];
  const read = (...keys) => {
    for (const source of sources) {
      const value = keys.map((key) => source?.[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const domain = String(read('domain', 'DOMAIN') ?? '').trim().toLowerCase();
  const accessToken = String(read('access_token', 'AUTH_ID') ?? '').trim();
  const refreshToken = String(read('refresh_token', 'REFRESH_ID') ?? '').trim();
  const expiresIn = Number(read('expires_in', 'AUTH_EXPIRES') ?? 3600);

  if (!domain || !accessToken) return null;

  return {
    accessToken,
    refreshToken,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    domain: assertAllowedBitrixDomain(domain),
    clientEndpoint: String(read('client_endpoint', 'CLIENT_ENDPOINT') ?? `https://${domain}/rest/`),
    serverEndpoint: String(read('server_endpoint', 'SERVER_ENDPOINT') ?? 'https://oauth.bitrix.info/rest/'),
    applicationToken: String(read('application_token', 'APPLICATION_TOKEN') ?? '').trim(),
    memberId: String(read('member_id', 'MEMBER_ID') ?? '').trim(),
    userId: String(read('user_id', 'USER_ID') ?? '').trim(),
    scope: String(read('scope', 'APPLICATION_SCOPE') ?? '').trim()
  };
}

// An event request carries no access token -- an outgoing webhook sends only the domain, the
// member id and the application token from its own form -- so it cannot go through
// normalizeBitrixAuth(), which requires one.
export function readBitrixEventAuth(body = {}, query = {}) {
  const read = (...keys) => {
    for (const source of [body?.auth, body, query]) {
      for (const key of keys) {
        const value = source?.[key];
        if (value !== undefined && value !== null && value !== '') return String(value).trim();
      }
    }
    return '';
  };

  return {
    domain: read('domain', 'DOMAIN').toLowerCase(),
    memberId: read('member_id', 'MEMBER_ID'),
    applicationToken: read('application_token', 'APPLICATION_TOKEN')
  };
}

export async function assertBitrixEventRequest(auth) {
  if (!auth?.applicationToken) {
    throw httpError(403, 'Bitrix event authorization is required');
  }

  if (auth.domain) assertAllowedBitrixDomain(auth.domain);

  // The token shown in the outgoing webhook form is the shared secret for its events.
  if (env.BITRIX_EVENT_TOKEN && safeEqual(hashSecret(env.BITRIX_EVENT_TOKEN), hashSecret(auth.applicationToken))) {
    return;
  }

  // An event bound by the local application is verified exactly like its handler requests.
  await assertBitrixApplicationRequest(auth);
}

export async function rememberInstallation(auth) {
  if (!auth?.memberId || !auth.applicationToken) {
    throw new Error('Bitrix installation auth is incomplete');
  }

  const installations = await readInstallations();
  installations[auth.memberId] = {
    domain: auth.domain,
    applicationTokenHash: hashSecret(auth.applicationToken),
    updatedAt: new Date().toISOString()
  };
  await writeInstallations(installations);
}

export async function assertBitrixApplicationRequest(auth) {
  if (!auth?.memberId || !auth.applicationToken) {
    throw httpError(403, 'Bitrix application authorization is required');
  }

  const expectedTokenHash = env.BITRIX_APPLICATION_TOKEN
    ? hashSecret(env.BITRIX_APPLICATION_TOKEN)
    : (await readInstallations())[auth.memberId]?.applicationTokenHash;

  if (!expectedTokenHash || !safeEqual(expectedTokenHash, hashSecret(auth.applicationToken))) {
    throw httpError(403, 'Bitrix application source could not be verified');
  }
}

// auth.expiresIn is the lifetime of the Bitrix *access token* (an hour), not of this
// application's session: callBitrixMethodResponse() renews the token on its own through
// refreshBitrixAuth(). Capping the session by it signed managers out after an hour while the
// cookie still claimed eight, so every request after that answered 401 -- which the UI showed
// as a button that did nothing. The session now lives exactly as long as its cookie says.
function sessionLifetime() {
  return env.BITRIX_SESSION_TTL_MS;
}

export function createBitrixSession(auth) {
  const sessionId = randomBytes(32).toString('base64url');
  const session = {
    id: sessionId,
    auth,
    expiresAt: Date.now() + sessionLifetime(),
    lastSeenAt: Date.now(),
    cookieIssuedAt: Date.now()
  };
  sessions.set(sessionId, session);
  persistSessions();
  return { session, cookie: serializeCookie(sessionId) };
}

export function getBitrixSession(req) {
  const cookieHeader = String(req.get('cookie') ?? '');
  const sessionId = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${env.BITRIX_SESSION_COOKIE_NAME}=`))
    ?.slice(env.BITRIX_SESSION_COOKIE_NAME.length + 1);

  if (!sessionId || !verifySessionId(sessionId)) return null;

  const session = sessions.get(sessionId.split('.')[0]);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId.split('.')[0]);
    return null;
  }

  // Sliding expiry: someone working through the day is never interrupted, and an idle
  // session still falls away after the full TTL.
  session.expiresAt = Date.now() + sessionLifetime();
  session.lastSeenAt = Date.now();
  return session;
}

export function updateBitrixSession(session, auth) {
  session.auth = auth;
  session.expiresAt = Date.now() + sessionLifetime();
  session.lastSeenAt = Date.now();
  persistSessions();
}

export function requireBitrixSession(req, res, next) {
  const session = getBitrixSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Bitrix application session is required' });
  }

  // The cookie carries a fixed Max-Age from the moment it was issued, so a sliding session
  // would still die with it. Re-issuing it once past the halfway mark keeps the two in step.
  if (Date.now() - (session.cookieIssuedAt ?? 0) > sessionLifetime() / 2) {
    session.cookieIssuedAt = Date.now();
    res.setHeader('Set-Cookie', serializeCookie(session.id));
    // Writing on every request would be wasteful; the halfway mark is often enough that a
    // restart finds an expiry no more than half a TTL behind.
    persistSessions();
  }

  return runWithBitrixSession(session, next);
}

export function getClientIndexPath() {
  return resolve(process.cwd(), env.CLIENT_DIST_PATH, 'index.html');
}

function serializeCookie(sessionId) {
  const value = `${sessionId}.${signSessionId(sessionId)}`;
  return [
    `${env.BITRIX_SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    `Max-Age=${Math.floor(env.BITRIX_SESSION_TTL_MS / 1000)}`
  ].join('; ');
}

function verifySessionId(value) {
  const [sessionId, signature] = String(value).split('.');
  if (!sessionId || !signature) return false;
  return safeEqual(signature, signSessionId(sessionId));
}

function signSessionId(sessionId) {
  return createHmac('sha256', getSessionSecret()).update(sessionId).digest('base64url');
}

function getSessionSecret() {
  if (!env.BITRIX_SESSION_SECRET && env.NODE_ENV === 'production') {
    throw new Error('BITRIX_SESSION_SECRET is required in production');
  }
  return env.BITRIX_SESSION_SECRET ?? 'development-only-bitrix-session-secret';
}

function hashSecret(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readInstallations() {
  installationTokensPromise ??= readFile(installationStorePath, 'utf8')
    .then((content) => JSON.parse(content || '{}'))
    .catch((error) => {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
      throw error;
    });
  return installationTokensPromise;
}

async function writeInstallations(installations) {
  await mkdir(dirname(installationStorePath), { recursive: true });
  const temporaryPath = `${installationStorePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(installations, null, 2), 'utf8');
  await rename(temporaryPath, installationStorePath);
  installationTokensPromise = Promise.resolve(installations);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
