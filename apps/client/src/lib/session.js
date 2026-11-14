// The application session used to die an hour after the app was opened while its cookie
// claimed eight hours, so every button quietly started answering 401 and appeared to do
// nothing. The server side of that is fixed, but a session can still lapse -- an idle day, a
// very long shift -- and a manager should never have to work out that the cure is to close
// the app and reopen it from Bitrix.
//
// Bitrix hands the page a live access token through BX24.getAuth(). Posting it back is enough
// for the server to recognise the portal user and issue a fresh session cookie.

export const SESSION_EXPIRED_MESSAGE =
  'Սեսիան ավարտվել է։ ' +
  'Փակեք և նորից բացեք ' +
  'հավելվածը Bitrix24-ից։';

function readBitrixAuth() {
  const bx24 = typeof window === 'undefined' ? null : window.BX24;

  if (!bx24?.getAuth) return null;

  try {
    const auth = bx24.getAuth();
    return auth?.access_token && auth?.domain ? auth : null;
  } catch {
    return null;
  }
}

// Only one renewal runs at a time: a board that fires several requests at once would
// otherwise ask Bitrix for a session once per request.
let renewal = null;

export function renewSession(apiBaseUrl) {
  if (renewal) return renewal;

  renewal = (async () => {
    const auth = readBitrixAuth();

    if (!auth) return false;

    const response = await fetch(`${apiBaseUrl}/api/bitrix/session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(auth)
    });

    return response.ok;
  })()
    .catch(() => false)
    .finally(() => {
      renewal = null;
    });

  return renewal;
}
