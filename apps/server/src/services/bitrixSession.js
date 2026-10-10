import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { env } from '../config/env.js';
import { assertAllowedBitrixDomain } from './bitrixDomain.js';
import { runWithBitrixSession } from './bitrixContext.js';

const sessions = new Map();
const installationStorePath = resolve(env.BITRIX_INSTALLATION_STORE_PATH ?? 'data/bitrix-installations.json');
let installationTokensPromise;

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

export function createBitrixSession(auth) {
  const sessionId = randomBytes(32).toString('base64url');
  const session = {
    id: sessionId,
    auth,
    expiresAt: Date.now() + Math.min(auth.expiresIn * 1000, env.BITRIX_SESSION_TTL_MS),
    lastSeenAt: Date.now()
  };
  sessions.set(sessionId, session);
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

  session.lastSeenAt = Date.now();
  return session;
}

export function updateBitrixSession(session, auth) {
  session.auth = auth;
  session.expiresAt = Date.now() + Math.min(auth.expiresIn * 1000, env.BITRIX_SESSION_TTL_MS);
  session.lastSeenAt = Date.now();
}

export function requireBitrixSession(req, res, next) {
  const session = getBitrixSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Bitrix application session is required' });
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
