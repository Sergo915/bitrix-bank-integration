import assert from 'node:assert/strict';
import { basename } from 'node:path';
import test from 'node:test';

process.env.BITRIX_ALLOWED_DOMAINS = 'example.bitrix24.com';

const {
  createBitrixSession,
  getBitrixSession,
  getClientIndexPath,
  normalizeBitrixAuth,
  requireBitrixSession
} = await import('../src/services/bitrixSession.js');
const { env } = await import('../src/config/env.js');

function requestWith(cookie) {
  return { get: (name) => (name.toLowerCase() === 'cookie' ? cookie : undefined) };
}

function responseSpy() {
  const headers = {};
  return { headers, setHeader: (name, value) => { headers[name] = value; }, status() { return this; }, json() { return this; } };
}

const PORTAL_AUTH = {
  domain: 'example.bitrix24.com',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  // What Bitrix sends: the lifetime of the access token, one hour.
  expiresIn: 3600
};

test('resolves the built client entry file inside CLIENT_DIST_PATH', () => {
  assert.equal(basename(getClientIndexPath()), 'index.html');
});

test('normalizes a Bitrix UI launch when DOMAIN is supplied in the query string', () => {
  const auth = normalizeBitrixAuth(
    {
      AUTH_ID: 'access-token',
      REFRESH_ID: 'refresh-token',
      AUTH_EXPIRES: '3600',
      APPLICATION_TOKEN: 'application-token',
      member_id: 'member-id'
    },
    {
      DOMAIN: 'example.bitrix24.com',
      APP_SID: 'application-session-id'
    }
  );

  assert.equal(auth.domain, 'example.bitrix24.com');
  assert.equal(auth.accessToken, 'access-token');
  assert.equal(auth.refreshToken, 'refresh-token');
  assert.equal(auth.applicationToken, 'application-token');
  assert.equal(auth.memberId, 'member-id');
});

// The session used to be capped by auth.expiresIn, so it died an hour after the app was
// opened while its cookie still claimed the full TTL. Every request after that answered 401,
// which the UI showed as a button that did nothing: this is the regression test for it.
test('the session outlives the Bitrix access token, which is refreshed separately', () => {
  const previousTtl = env.BITRIX_SESSION_TTL_MS;
  env.BITRIX_SESSION_TTL_MS = 8 * 3600 * 1000;

  try {
    const { session } = createBitrixSession({ ...PORTAL_AUTH });
    const lifetime = session.expiresAt - Date.now();

    assert.ok(
      lifetime > 7 * 3600 * 1000,
      `the session should last the configured TTL, not the token's hour (got ${Math.round(lifetime / 60000)} min)`
    );
  } finally {
    env.BITRIX_SESSION_TTL_MS = previousTtl;
  }
});

test('an in-use session keeps sliding forward and is reissued before its cookie lapses', () => {
  const previousTtl = env.BITRIX_SESSION_TTL_MS;
  env.BITRIX_SESSION_TTL_MS = 600000;

  try {
    const { session, cookie } = createBitrixSession({ ...PORTAL_AUTH });
    const request = requestWith(cookie.split(';')[0]);

    // Most of the window has gone by; the session must not be on the edge of expiry.
    session.expiresAt = Date.now() + 1000;
    const found = getBitrixSession(request);

    assert.ok(found, 'a session in use must not be dropped');
    assert.ok(found.expiresAt - Date.now() > 500000, 'using it pushes the expiry out again');

    // The cookie was issued long enough ago that the browser would drop it first.
    found.cookieIssuedAt = Date.now() - 500000;
    const response = responseSpy();
    requireBitrixSession(request, response, () => undefined);

    assert.match(response.headers['Set-Cookie'] ?? '', /Max-Age=600/, 'a fresh cookie must be sent');
  } finally {
    env.BITRIX_SESSION_TTL_MS = previousTtl;
  }
});

test('continues to normalize nested installation authorization', () => {
  const auth = normalizeBitrixAuth({
    auth: {
      domain: 'example.bitrix24.com',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      application_token: 'application-token',
      member_id: 'member-id'
    }
  });

  assert.equal(auth.domain, 'example.bitrix24.com');
  assert.equal(auth.accessToken, 'access-token');
});
