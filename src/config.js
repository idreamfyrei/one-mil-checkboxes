import 'dotenv/config';

export const PORT           = Number(process.env.PORT || 8000);
export const CHECKBOX_COUNT = Number(process.env.CHECKBOX_COUNT || 1_000_000);
export const RATE_LIMIT_MS  = Number(process.env.CHECKBOX_RATE_MS || 5000);

export const VALKEY_URL       = process.env.VALKEY_URL          || 'redis://127.0.0.1:6379';
export const BITMAP_KEY       = process.env.VALKEY_BITMAP_KEY   || 'checkbox:bitmap';
export const PUB_CHANNEL      = process.env.VALKEY_PUB_CHANNEL  || 'checkbox:events';
export const RATE_KEY_PREFIX  = process.env.VALKEY_RATE_PREFIX  || 'checkbox:rate:';
export const RATE_KEY_TTL_SEC = Number(process.env.VALKEY_RATE_TTL_SEC || 86400);

export const IDP_URL     = (process.env.IDP_URL  || 'http://localhost:3000').replace(/\/+$/, '');
export const APP_URL     = (process.env.APP_URL  || `http://localhost:${PORT}`).replace(/\/+$/, '');
export const CLIENT_ID   = process.env.CLIENT_ID || 'one-mil-checkbox';
export const REDIRECT_URI = `${APP_URL}/auth/callback`;

export const SESSION_COOKIE  = 'cb_session';
export const SESSION_PREFIX  = 'session:';
export const PKCE_PREFIX     = 'pkce:';
export const SESSION_TTL_SEC = 3600;
export const PKCE_TTL_SEC    = 300;

// HTTP rate limit: 20 login attempts per 60 seconds per IP
export const HTTP_RL_MAX    = 20;
export const HTTP_RL_WINDOW = 60;
export const HTTP_RL_PREFIX = 'ratelimit:http:login:';
