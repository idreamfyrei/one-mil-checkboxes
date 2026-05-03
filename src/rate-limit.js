import { redis } from './redis.js';
import {
  RATE_KEY_PREFIX, RATE_KEY_TTL_SEC, RATE_LIMIT_MS,
  HTTP_RL_PREFIX, HTTP_RL_MAX, HTTP_RL_WINDOW,
} from './config.js';


const SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local window = tonumber(ARGV[1])
local ttlSec = tonumber(ARGV[2])
local t      = redis.call('TIME')
local nowMs  = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local prev   = redis.call('GET', key)
if type(prev) == 'string' then
  local lastMs = tonumber(prev)
  if lastMs ~= nil and (nowMs - lastMs) < window then
    return {0, math.ceil(window - (nowMs - lastMs))}
  end
end
redis.call('SET', key, tostring(nowMs), 'EX', ttlSec)
return {1, 0}
`;

export async function checkSocketRateLimit(userId) {
  const key    = `${RATE_KEY_PREFIX}user:${userId}`;
  const result = await redis.eval(SLIDING_WINDOW_LUA, 1, key, String(RATE_LIMIT_MS), String(RATE_KEY_TTL_SEC));
  const allowed      = Array.isArray(result) && Number(result[0]) === 1;
  const retryAfterMs = Array.isArray(result) ? Math.max(0, Math.ceil(Number(result[1]) || 0)) : RATE_LIMIT_MS;
  return { allowed, retryAfterMs };
}

export async function checkHttpRateLimit(ip) {
  const key   = `${HTTP_RL_PREFIX}${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, HTTP_RL_WINDOW);
  return {
    allowed:       count <= HTTP_RL_MAX,
    retryAfterSec: count <= HTTP_RL_MAX ? 0 : HTTP_RL_WINDOW,
  };
}

export function httpRateLimit() {
  return async (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || 'unknown';
    try {
      const { allowed, retryAfterSec } = await checkHttpRateLimit(ip);
      if (!allowed) {
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({ error: 'too_many_requests', retryAfterSec });
      }
      next();
    } catch (err) {
      console.error('[rate-limit:http]', err.message);
      next(); 
    }
  };
}
