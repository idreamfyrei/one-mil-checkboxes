import crypto from 'node:crypto';
import { Router } from 'express';
import { redis } from './redis.js';
import { httpRateLimit } from './rate-limit.js';
import {
  IDP_URL, APP_URL, CLIENT_ID, REDIRECT_URI,
  SESSION_COOKIE, SESSION_PREFIX, PKCE_PREFIX,
  SESSION_TTL_SEC, PKCE_TTL_SEC,
} from './config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

export const parseCookies = (header = '') =>
  header.split(';').reduce((acc, part) => {
    const [k, ...rest] = part.trim().split('=');
    if (k?.trim()) acc[k.trim()] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});

const generatePkce = () => {
  const verifier  = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const randomId = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

// ── Session helpers ───────────────────────────────────────────────────────────

export const getSession = async (req) => {
  const sid = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!sid) return null;
  const raw = await redis.get(`${SESSION_PREFIX}${sid}`);
  return raw ? JSON.parse(raw) : null;
};

export const createSession = async (user) => {
  const sid = randomId(32);
  await redis.set(`${SESSION_PREFIX}${sid}`, JSON.stringify(user), 'EX', SESSION_TTL_SEC);
  return sid;
};

export const destroySession = async (req) => {
  const sid = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (sid) await redis.del(`${SESSION_PREFIX}${sid}`);
};

export const sessionCookieHeader = (sid) =>
  `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`;

export const clearCookieHeader = () =>
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

// ── Auth router ───────────────────────────────────────────────────────────────

export const authRouter = Router();

// Rate-limited: prevents PKCE state flooding
authRouter.get('/auth/login', httpRateLimit(), (_req, res) => {
  const { verifier, challenge } = generatePkce();
  const state = randomId(24);
  const nonce = randomId(16);

  redis.set(
    `${PKCE_PREFIX}${state}`,
    JSON.stringify({ verifier, nonce }),
    'EX',
    PKCE_TTL_SEC,
  );

  const params = new URLSearchParams({
    client_id:             CLIENT_ID,
    redirect_uri:          REDIRECT_URI,
    response_type:         'code',
    scope:                 'openid profile email',
    state,
    nonce,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });

  console.log(`[auth] login  client_id=${CLIENT_ID}  redirect_uri=${REDIRECT_URI}`);
  res.redirect(302, `${IDP_URL}/authorize?${params}`);
});

authRouter.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error)           return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect('/?auth_error=missing_params');

  const pkceRaw = await redis.get(`${PKCE_PREFIX}${state}`);
  if (!pkceRaw) return res.redirect('/?auth_error=invalid_state');
  await redis.del(`${PKCE_PREFIX}${state}`);

  const { verifier } = JSON.parse(pkceRaw);

  try {
    const tokenRes = await fetch(`${IDP_URL}/oauth/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
        client_id:     CLIENT_ID,
        code_verifier: verifier,
      }),
    });

    if (!tokenRes.ok) {
      console.error('[auth] token exchange failed', await tokenRes.text());
      return res.redirect('/?auth_error=token_exchange_failed');
    }

    const { access_token } = await tokenRes.json();

    const userRes = await fetch(`${IDP_URL}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userRes.ok) return res.redirect('/?auth_error=userinfo_failed');

    const claims = await userRes.json();
    const sid = await createSession({
      userId: claims.sub,
      email:  claims.email,
      name:   claims.name || claims.given_name || claims.email,
    });

    res.setHeader('Set-Cookie', sessionCookieHeader(sid));
    res.redirect(302, '/');
  } catch (err) {
    console.error('[auth] callback error', err);
    res.redirect('/?auth_error=server_error');
  }
});

authRouter.get('/auth/logout', async (req, res) => {
  await destroySession(req);
  res.setHeader('Set-Cookie', clearCookieHeader());
  res.redirect(302, '/');
});

authRouter.get('/auth/me', async (req, res) => {
  const user = await getSession(req);
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  res.json(user);
});

authRouter.get('/auth/config', (_req, res) => {
  res.json({ idpUrl: IDP_URL, appUrl: APP_URL, clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
});
