import http from 'node:http';
import path from 'node:path';

import express from 'express';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import 'dotenv/config';

const PORT = Number(process.env.PORT || 3000);
const CHECKBOX_COUNT = Number(process.env.CHECKBOX_COUNT || 1_000_000);

const RATE_LIMIT_MS = Number(process.env.CHECKBOX_RATE_MS || 5000);

/** Valkey speaks the Redis protocol; ioredis works against both. */
const VALKEY_URL = process.env.VALKEY_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const BITMAP_KEY = process.env.VALKEY_BITMAP_KEY || 'checkbox:bitmap';
const PUB_CHANNEL = process.env.VALKEY_PUB_CHANNEL || 'checkbox:events';
const RATE_KEY_PREFIX = process.env.VALKEY_RATE_PREFIX || 'checkbox:rate:';
/** Idle expiry for per-socket rate keys (seconds). */
const RATE_KEY_TTL_SEC = Number(process.env.VALKEY_RATE_TTL_SEC || 86400);

/**
 * Sliding window: one allowed action per `window` ms per key.
 * Uses Valkey TIME so all app instances share the same clock.
 * Returns: [1, 0] allowed, or [0, retryAfterMs] denied.
 */
const RATE_LIMIT_LUA = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local ttlSec = tonumber(ARGV[2])
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local prev = redis.call('GET', key)
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

function bitmapByteLength(bits) {
    return Math.ceil(bits / 8);
}

function rateLimitKey(socketId) {
    return `${RATE_KEY_PREFIX}${socketId}`;
}

async function main() {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server);
    io.attach(server);

    const redis = new Redis(VALKEY_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
    });
    const sub = redis.duplicate();

    redis.on('error', (err) => {
        console.error('[valkey]', err.message);
    });
    sub.on('error', (err) => {
        console.error('[valkey sub]', err.message);
    });

    await sub.subscribe(PUB_CHANNEL);
    sub.on('message', (_channel, message) => {
        try {
            const payload = JSON.parse(message);
            io.emit('checkbox:updated', payload);
        } catch (e) {
            console.error('pub/sub payload parse error', e);
        }
    });

    async function emitInit(socket) {
        const totalChecked = await redis.bitcount(BITMAP_KEY);
        socket.emit('checkbox:init', {
            checkboxCount: CHECKBOX_COUNT,
            totalChecked,
            rateLimitMs: RATE_LIMIT_MS,
        });
    }

    io.on('connection', (socket) => {
        console.log('Socket connected', { id: socket.id });

        emitInit(socket).catch((err) => console.error('emitInit', err));

        socket.on('checkbox:init:request', () => {
            emitInit(socket).catch((err) => console.error('emitInit', err));
        });

        socket.on('checkbox:bitmap:request', async () => {
            try {
                const raw = await redis.getBuffer(BITMAP_KEY);
                const len = bitmapByteLength(CHECKBOX_COUNT);
                const buf = Buffer.alloc(len, 0);
                if (raw && raw.length) {
                    raw.copy(buf, 0, 0, Math.min(raw.length, len));
                }
                socket.emit('checkbox:bitmap', {
                    encoding: 'base64',
                    data: buf.toString('base64'),
                    byteLength: len,
                });
            } catch (err) {
                console.error('checkbox:bitmap:request', err);
                socket.emit('checkbox:error', { message: 'bitmap_load_failed' });
            }
        });

        socket.on('checkbox:update', async (payload = {}) => {
            const index = Number(payload.index);
            const checked = Boolean(payload.checked);
            const user =
                typeof payload.user === 'string'
                    ? payload.user.slice(0, 32)
                    : `user-${socket.id.slice(0, 6)}`;

            if (!Number.isInteger(index) || index < 0 || index >= CHECKBOX_COUNT) {
                return;
            }

            const rKey = rateLimitKey(socket.id);
            let allowed = false;
            let retryAfterMs = 0;
            try {
                const res = await redis.eval(
                    RATE_LIMIT_LUA,
                    1,
                    rKey,
                    String(RATE_LIMIT_MS),
                    String(RATE_KEY_TTL_SEC)
                );
                const ok = Array.isArray(res) ? Number(res[0]) === 1 : false;
                retryAfterMs = Array.isArray(res)
                    ? Math.max(0, Math.ceil(Number(res[1]) || 0))
                    : RATE_LIMIT_MS;
                allowed = ok;
            } catch (err) {
                console.error('checkbox:update rate_limit eval', err);
                socket.emit('checkbox:error', { message: 'rate_check_failed' });
                return;
            }

            if (!allowed) {
                socket.emit('checkbox:rate_limited', {
                    index,
                    retryAfterMs,
                    message: 'RATE_LIMIT',
                });
                return;
            }

            const bit = checked ? 1 : 0;
            try {
                const prev = await redis.setbit(BITMAP_KEY, index, bit);
                if (prev === bit) {
                    return;
                }
                const totalChecked = await redis.bitcount(BITMAP_KEY);
                const event = {
                    index,
                    checked,
                    user,
                    timestamp: Date.now(),
                    totalChecked,
                };
                await redis.publish(PUB_CHANNEL, JSON.stringify(event));
            } catch (err) {
                console.error('checkbox:update', err);
            }
        });

        socket.on('disconnect', () => {
            redis.del(rateLimitKey(socket.id)).catch(() => {});
        });
    });

    app.use(express.static(path.resolve('./public')));

    app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    server.listen(PORT, () => {
        console.log(`Server listening on ${PORT}`);
        console.log(`Valkey URL: ${VALKEY_URL}`);
        console.log(`Bitmap key: ${BITMAP_KEY}, pub channel: ${PUB_CHANNEL}`);
        console.log(
            `Rate limit: ${RATE_LIMIT_MS}ms per socket (Valkey sliding window, prefix ${RATE_KEY_PREFIX})`
        );
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
