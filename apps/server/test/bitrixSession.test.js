import assert from 'node:assert/strict';
import { basename } from 'node:path';
import test from 'node:test';

process.env.BITRIX_ALLOWED_DOMAINS = 'milonmining24.bitrix24.ru';

const { getClientIndexPath, normalizeBitrixAuth } = await import('../src/services/bitrixSession.js');

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
      DOMAIN: 'milonmining24.bitrix24.ru',
      APP_SID: 'application-session-id'
    }
  );

  assert.equal(auth.domain, 'milonmining24.bitrix24.ru');
  assert.equal(auth.accessToken, 'access-token');
  assert.equal(auth.refreshToken, 'refresh-token');
  assert.equal(auth.applicationToken, 'application-token');
  assert.equal(auth.memberId, 'member-id');
});

test('continues to normalize nested installation authorization', () => {
  const auth = normalizeBitrixAuth({
    auth: {
      domain: 'milonmining24.bitrix24.ru',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      application_token: 'application-token',
      member_id: 'member-id'
    }
  });

  assert.equal(auth.domain, 'milonmining24.bitrix24.ru');
  assert.equal(auth.accessToken, 'access-token');
});
