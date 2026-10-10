import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { env } from '../config/env.js';
import { assertAllowedBitrixDomain, callBitrixMethod, exchangeBitrixCode, getBitrixStatus } from '../services/bitrixClient.js';
import {
  assertBitrixApplicationRequest,
  createBitrixSession,
  getBitrixSession,
  getClientIndexPath,
  normalizeBitrixAuth,
  rememberInstallation
} from '../services/bitrixSession.js';

export const bitrixRouter = Router();

bitrixRouter.get('/status', (_req, res) => {
  res.json(getBitrixStatus());
});

bitrixRouter.post('/webhook/test', async (_req, res, next) => {
  try {
    const profile = await callBitrixMethod('profile');

    res.json({
      ok: true,
      profile
    });
  } catch (error) {
    next(error);
  }
});

// Bitrix calls this endpoint server-to-server when the local application is
// installed with "Application completes installation itself" enabled.
bitrixRouter.post('/install', async (req, res, next) => {
  try {
    const auth = normalizeBitrixAuth(req.body, req.query);
    await assertBitrixApplicationRequestForInstallation(auth);
    await rememberInstallation(auth);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Bitrix opens the UI handler with a POST containing the current employee's
// OAuth data. Direct GET access without a previously established session is
// deliberately rejected.
bitrixRouter.post('/app', async (req, res, next) => {
  try {
    const auth = normalizeBitrixAuth(req.body, req.query);
    if (auth?.domain) allowBitrixEmbedding(res, auth.domain);
    await assertBitrixApplicationRequest(auth);
    const { cookie } = createBitrixSession(auth);
    res.setHeader('Set-Cookie', cookie);
    res.send(await readFile(getClientIndexPath(), 'utf8'));
  } catch (error) {
    next(error);
  }
});

bitrixRouter.get('/app', async (req, res, next) => {
  try {
    const session = getBitrixSession(req);
    if (!session) {
      return res.status(403).send('This application can only be opened from Bitrix24.');
    }

    allowBitrixEmbedding(res, session.auth.domain);
    res.send(await readFile(getClientIndexPath(), 'utf8'));
  } catch (error) {
    next(error);
  }
});

bitrixRouter.get('/oauth/callback', async (req, res, next) => {
  try {
    const { code, domain } = req.query;

    if (!code || !domain) {
      return res.status(400).json({ error: 'Bitrix OAuth code and domain are required' });
    }

    if (!env.BITRIX_CLIENT_ID || !env.BITRIX_CLIENT_SECRET || !env.BITRIX_REDIRECT_URI) {
      return res.status(500).json({ error: 'Bitrix OAuth environment is not configured' });
    }

    const allowedDomain = assertAllowedBitrixDomain(domain);
    const token = await exchangeBitrixCode({
      code,
      domain: allowedDomain,
      clientId: env.BITRIX_CLIENT_ID,
      clientSecret: env.BITRIX_CLIENT_SECRET,
      redirectUri: env.BITRIX_REDIRECT_URI
    });

    // Persist token securely once a database is selected.
    res.json({
      ok: true,
      domain: allowedDomain,
      expiresIn: token.expires_in
    });
  } catch (error) {
    next(error);
  }
});

async function assertBitrixApplicationRequestForInstallation(auth) {
  if (!auth) {
    const error = new Error('Bitrix installation authorization is required');
    error.status = 400;
    throw error;
  }

  // The initial installation request is the trusted moment at which the
  // application token is captured. Subsequent UI requests are checked against
  // this stored hash by assertBitrixApplicationRequest().
  if (!auth.applicationToken || !auth.memberId) {
    const error = new Error('Bitrix installation application token is required');
    error.status = 400;
    throw error;
  }
}

function allowBitrixEmbedding(res, portalDomain) {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' https://${portalDomain};`);
}
