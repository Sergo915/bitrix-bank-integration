import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { assertAllowedBitrixDomain, createBitrixClient } from './bitrixClient.js';
import { getDatabasePool } from './mysql.js';

const SESSION_HEADER = 'x-app-session';

function sessionHash(token) {
  return createHash('sha256').update(token).digest();
}

function normalizeProfile(profile, domain) {
  const bitrixUserId = Number(profile?.ID ?? profile?.id);
  if (!Number.isSafeInteger(bitrixUserId) || bitrixUserId <= 0) {
    const error = new Error('Bitrix user profile is invalid');
    error.status = 401;
    throw error;
  }

  const firstName = String(profile.NAME ?? profile.name ?? '').trim() || null;
  const lastName = String(profile.LAST_NAME ?? profile.lastName ?? '').trim() || null;
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || `Bitrix #${bitrixUserId}`;
  return {
    bitrixUserId,
    portalDomain: domain,
    displayName,
    firstName,
    lastName,
    email: String(profile.EMAIL ?? profile.email ?? '').trim() || null
  };
}

async function getBitrixProfile({ domain, accessToken }) {
  const portalDomain = assertAllowedBitrixDomain(domain);
  if (!accessToken || String(accessToken).length < 12) {
    const error = new Error('Bitrix launch token is required');
    error.status = 401;
    throw error;
  }

  try {
    const client = createBitrixClient(portalDomain, accessToken);
    const { data } = await client.get('user.current.json');
    if (data?.error || !data?.result) {
      const error = new Error(data?.error_description ?? data?.error ?? 'Bitrix user verification failed');
      error.status = 401;
      throw error;
    }
    return normalizeProfile(data.result, portalDomain);
  } catch (error) {
    if (error.status) throw error;
    error.status = 401;
    error.message = 'Bitrix user verification failed';
    throw error;
  }
}

async function upsertUser(profile) {
  const pool = getDatabasePool();
  await pool.query(
    'INSERT INTO users (portal_domain, bitrix_user_id, display_name, first_name, last_name, email) ' +
      'VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), ' +
      'first_name = VALUES(first_name), last_name = VALUES(last_name), email = VALUES(email), ' +
      'is_active = TRUE',
    [profile.portalDomain, profile.bitrixUserId, profile.displayName, profile.firstName, profile.lastName, profile.email]
  );
  const [rows] = await pool.query(
    'SELECT id, portal_domain AS portalDomain, bitrix_user_id AS bitrixUserId, display_name AS displayName, ' +
      'first_name AS firstName, last_name AS lastName, email, app_role AS appRole, is_active AS isActive ' +
      'FROM users WHERE portal_domain = ? AND bitrix_user_id = ? LIMIT 1',
    [profile.portalDomain, profile.bitrixUserId]
  );
  return rows[0];
}

export async function createBitrixSession({ domain, accessToken, expectedUserId }) {
  const profile = await getBitrixProfile({ domain, accessToken });
  if (expectedUserId && String(expectedUserId) !== String(profile.bitrixUserId)) {
    const error = new Error('Bitrix user identity mismatch');
    error.status = 401;
    throw error;
  }

  const user = await upsertUser(profile);
  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.BITRIX_SESSION_TTL_SECONDS * 1000);
  const pool = getDatabasePool();
  const [result] = await pool.query(
    'INSERT INTO user_sessions (user_id, session_token_hash, expires_at) VALUES (?, ?, ?)',
    [user.id, sessionHash(rawToken), expiresAt]
  );
  const session = {
    id: result.insertId,
    token: rawToken,
    user,
    expiresAt: expiresAt.toISOString()
  };
  await recordAuditEvent({ session, action: 'login', status: 'success' });
  return session;
}

export async function getSessionFromToken(token, { touch = true } = {}) {
  if (!token) return null;
  const pool = getDatabasePool();
  const [rows] = await pool.query(
    'SELECT s.id AS sessionId, s.expires_at AS expiresAt, u.id AS userId, ' +
      'u.portal_domain AS portalDomain, u.bitrix_user_id AS bitrixUserId, u.display_name AS displayName, ' +
      'u.first_name AS firstName, u.last_name AS lastName, u.email, u.app_role AS appRole, u.is_active AS isActive ' +
      'FROM user_sessions s JOIN users u ON u.id = s.user_id ' +
      'WHERE s.session_token_hash = ? AND s.ended_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3) AND u.is_active = TRUE LIMIT 1',
    [sessionHash(token)]
  );
  const row = rows[0];
  if (!row) return null;
  if (touch) {
    await pool.query('UPDATE user_sessions SET last_seen_at = UTC_TIMESTAMP(3) WHERE id = ?', [row.sessionId]);
  }
  const { sessionId, expiresAt, userId, ...userFields } = row;
  return { sessionId, token, expiresAt, user: { ...userFields, id: userId } };
}

export async function getSessionFromRequest(req, options) {
  return getSessionFromToken(req.get(SESSION_HEADER), options);
}

export async function endBitrixSession(session, reason = 'logout') {
  if (!session?.sessionId) return;
  const pool = getDatabasePool();
  await pool.query(
    'UPDATE user_sessions SET ended_at = COALESCE(ended_at, UTC_TIMESTAMP(3)), end_reason = COALESCE(end_reason, ?) WHERE id = ?',
    [reason, session.sessionId]
  );
  await recordAuditEvent({ session, action: 'logout', status: 'success' });
}

export async function recordAuditEvent({ session, action, status = 'success', errorMessage = null }) {
  if (!session?.user?.id || !session?.sessionId) return;
  const pool = getDatabasePool();
  await pool.query(
    'INSERT INTO audit_events (user_id, session_id, actor_type, actor_name, action, status, error_message) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    [session.user.id, session.sessionId, 'user', session.user.displayName, action, status, errorMessage]
  );
}

export async function requireBitrixSession(req, res, next) {
  try {
    const token = req.get(SESSION_HEADER);
    if (!token && !env.BITRIX_AUTH_REQUIRED) return next();
    const session = await getSessionFromToken(token);
    if (!session) return res.status(401).json({ error: 'Bitrix authorization is required' });
    req.bitrixSession = session;
    req.user = session.user;
    next();
  } catch (error) {
    error.status = error.message.startsWith('MySQL is not configured') ? 503 : error.status ?? 401;
    next(error);
  }
}

export function getSessionHeaderName() {
  return SESSION_HEADER;
}
