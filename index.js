import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

import express from 'express';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import 'dotenv/config';


const PORT            = Number(process.env.PORT || 8000);
const CHECKBOX_COUNT  = Number(process.env.CHECKBOX_COUNT || 1_000_000);
const RATE_LIMIT_MS   = Number(process.env.CHECKBOX_RATE_MS || 5000);

const VALKEY_URL       = process.env.VALKEY_URL || 'redis://127.0.0.1:6379';
const BITMAP_KEY       = process.env.VALKEY_BITMAP_KEY    || 'checkbox:bitmap';
const PUB_CHANNEL      = process.env.VALKEY_PUB_CHANNEL   || 'checkbox:events';
const RATE_KEY_PREFIX  = process.env.VALKEY_RATE_PREFIX   || 'checkbox:rate:';
const RATE_KEY_TTL_SEC = Number(process.env.VALKEY_RATE_TTL_SEC || 86400);

const IDP_URL      = process.env.IDP_URL    || 'http://localhost:3000';
const APP_URL      = process.env.APP_URL    || `http://localhost:${PORT}`;
const CLIENT_ID    = process.env.CLIENT_ID  || 'one-mil-checkbox';
const REDIRECT_URI = `${APP_URL}/auth/callback`;

const SESSION_COOKIE  = 'cb_session';
const SESSION_PREFIX  = 'session:';
const PKCE_PREFIX     = 'pkce:';
const SESSION_TTL_SEC = 3600;  // 1 hour
const PKCE_TTL_SEC    = 300;   // 5 minutes


const RATE_LIMIT_LUA = `
local key    = KEYS[1]
local window = tonumber(ARGV[1])
local ttlSec = tonumber(ARGV[2])
local t      = redis.call('TIME')
local nowMs  = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local prev   = redis.call('GET', key)
if type(prev) == 'string' then
  local lastMs = tonumber(prev)
  if lastMs ~= nil then
    local elapsed = nowMs - lastMs
    if elapsed < window then
      return {0, math.ceil(window - elapsed)}
    end
  end
end
redis.call('SET', key, tostring(nowMs), 'EX', ttlSec)
return {1, 0}
`;


const bitmapByteLength = (bits) => Math.ceil(bits / 8);

const parseCookies = (header = '') =>
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


async function main() {
  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server);

  const redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
  const sub   = redis.duplicate();

  redis.on('error', (err) => console.error('[redis]', err.message));
  sub.on('error',   (err) => console.error('[redis sub]', err.message));

  await sub.subscribe(PUB_CHANNEL);
  sub.on('message', (_ch, msg) => {
    try { io.emit('checkbox:updated', JSON.parse(msg)); }
    catch (e) { console.error('pub/sub parse error', e); }
  });

  const getSession = async (req) => {
    const sid = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
    if (!sid) return null;
    const raw = await redis.get(`${SESSION_PREFIX}${sid}`);
    return raw ? JSON.parse(raw) : null;
  };

  const createSession = async (user) => {
    const sid = randomId(32);
    await redis.set(`${SESSION_PREFIX}${sid}`, JSON.stringify(user), 'EX', SESSION_TTL_SEC);
    return sid;
  };

  const destroySession = async (req) => {
    const sid = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
    if (sid) await redis.del(`${SESSION_PREFIX}${sid}`);
  };

  const sessionCookieHeader = (sid) =>
    `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`;

  const clearCookieHeader = () =>
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;


  app.get('/auth/login', (_req, res) => {
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

    res.redirect(302, `${IDP_URL}/authorize?${params}`);
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error)          return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
    if (!code || !state) return res.redirect('/?auth_error=missing_params');

    const pkceRaw = await redis.get(`${PKCE_PREFIX}${state}`);
    if (!pkceRaw) return res.redirect('/?auth_error=invalid_state');
    await redis.del(`${PKCE_PREFIX}${state}`); // one-time use

    const { verifier } = JSON.parse(pkceRaw);

    try {
      const tokenRes = await fetch(`${IDP_URL}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type:    'authorization_code',
          code,
          redirect_uri:  REDIRECT_URI,
          client_id:     CLIENT_ID,
          code_verifier: verifier,
        }),
      });

      if (!tokenRes.ok) {
        console.error('token exchange failed', await tokenRes.text());
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
      console.error('auth callback error', err);
      res.redirect('/?auth_error=server_error');
    }
  });

  app.get('/auth/logout', async (req, res) => {
    await destroySession(req);
    res.setHeader('Set-Cookie', clearCookieHeader());
    res.redirect(302, '/');
  });

  // Returns the current user from session cookie, or 401
  app.get('/auth/me', async (req, res) => {
    const user = await getSession(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    res.json(user);
  });

  io.use(async (socket, next) => {
    try {
      const sid = parseCookies(socket.handshake.headers.cookie || '')[SESSION_COOKIE];
      if (sid) {
        const raw = await redis.get(`${SESSION_PREFIX}${sid}`);
        if (raw) socket.user = JSON.parse(raw);
      }
    } catch { /* treat as anonymous */ }
    next();
  });

  
  const emitInit = async (socket) => {
    const totalChecked = await redis.bitcount(BITMAP_KEY);
    socket.emit('checkbox:init', {
      checkboxCount: CHECKBOX_COUNT,
      totalChecked,
      rateLimitMs: RATE_LIMIT_MS,
      user: socket.user ?? null, // let the client know its auth state
    });
  };

  io.on('connection', (socket) => {
    const who = socket.user?.email ?? 'anon';
    console.log(`[socket] connect  id=${socket.id.slice(0, 6)}  user=${who}`);

    emitInit(socket).catch(console.error);

    socket.on('checkbox:init:request', () => emitInit(socket).catch(console.error));

    socket.on('checkbox:bitmap:request', async () => {
      try {
        const raw = await redis.getBuffer(BITMAP_KEY);
        const len = bitmapByteLength(CHECKBOX_COUNT);
        const buf = Buffer.alloc(len, 0);
        if (raw?.length) raw.copy(buf, 0, 0, Math.min(raw.length, len));
        socket.emit('checkbox:bitmap', {
          encoding: 'base64',
          data:     buf.toString('base64'),
          byteLength: len,
        });
      } catch (err) {
        console.error('bitmap:request', err);
        socket.emit('checkbox:error', { message: 'bitmap_load_failed' });
      }
    });

    socket.on('checkbox:update', async (payload = {}) => {
      // Anonymous users are read-only
      if (!socket.user) {
        socket.emit('checkbox:error', { message: 'login_required', code: 'UNAUTHORIZED' });
        return;
      }

      const index   = Number(payload.index);
      const checked = Boolean(payload.checked);
      if (!Number.isInteger(index) || index < 0 || index >= CHECKBOX_COUNT) return;

      // Rate limit keyed on user ID so the window persists across reconnects
      const rKey = `${RATE_KEY_PREFIX}user:${socket.user.userId}`;
      try {
        const result  = await redis.eval(RATE_LIMIT_LUA, 1, rKey, String(RATE_LIMIT_MS), String(RATE_KEY_TTL_SEC));
        const allowed = Array.isArray(result) && Number(result[0]) === 1;
        const retryMs = Array.isArray(result) ? Math.max(0, Math.ceil(Number(result[1]) || 0)) : RATE_LIMIT_MS;

        if (!allowed) {
          socket.emit('checkbox:rate_limited', { index, retryAfterMs: retryMs, message: 'RATE_LIMIT' });
          return;
        }
      } catch (err) {
        console.error('rate_limit eval', err);
        socket.emit('checkbox:error', { message: 'rate_check_failed' });
        return;
      }

      try {
        const bit  = checked ? 1 : 0;
        const prev = await redis.setbit(BITMAP_KEY, index, bit);
        if (prev === bit) return; // no actual state change

        const totalChecked = await redis.bitcount(BITMAP_KEY);
        await redis.publish(PUB_CHANNEL, JSON.stringify({
          index,
          checked,
          user:         socket.user.name,
          timestamp:    Date.now(),
          totalChecked,
        }));
      } catch (err) {
        console.error('checkbox:update', err);
      }
    });

    socket.on('disconnect', () => {
      console.log(`[socket] disconnect id=${socket.id.slice(0, 6)}`);
    });
  });

  
  app.use(express.static(path.resolve('./public')));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  server.listen(PORT, () => {
    console.log(`Listening  →  http://localhost:${PORT}`);
    console.log(`IDP        →  ${IDP_URL}  (client_id: ${CLIENT_ID})`);
    console.log(`Callback   →  ${REDIRECT_URI}`);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
