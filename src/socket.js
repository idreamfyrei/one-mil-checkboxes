import { redis, sub } from './redis.js';
import { parseCookies, getSession } from './auth.js';
import { checkSocketRateLimit } from './rate-limit.js';
import {
  SESSION_COOKIE, SESSION_PREFIX,
  BITMAP_KEY, PUB_CHANNEL,
  CHECKBOX_COUNT, RATE_LIMIT_MS,
} from './config.js';

const bitmapByteLength = (bits) => Math.ceil(bits / 8);

export async function setupSocket(io) {

  await sub.subscribe(PUB_CHANNEL);
  sub.on('message', (_ch, msg) => {
    try { io.emit('checkbox:updated', JSON.parse(msg)); }
    catch (e) { console.error('[socket] pub/sub parse error', e); }
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

  io.on('connection', (socket) => {
    const who = socket.user?.email ?? 'anon';
    console.log(`[socket] connect    id=${socket.id.slice(0, 6)}  user=${who}`);


    const emitInit = async () => {
      const totalChecked = await redis.bitcount(BITMAP_KEY);
      socket.emit('checkbox:init', {
        checkboxCount: CHECKBOX_COUNT,
        totalChecked,
        rateLimitMs:   RATE_LIMIT_MS,
        user:          socket.user ?? null,
      });
    };

    emitInit().catch(console.error);
    socket.on('checkbox:init:request', () => emitInit().catch(console.error));

    socket.on('checkbox:bitmap:request', async () => {
      try {
        const raw = await redis.getBuffer(BITMAP_KEY);
        const len = bitmapByteLength(CHECKBOX_COUNT);
        const buf = Buffer.alloc(len, 0);
        if (raw?.length) raw.copy(buf, 0, 0, Math.min(raw.length, len));
        socket.emit('checkbox:bitmap', {
          encoding:   'base64',
          data:       buf.toString('base64'),
          byteLength: len,
        });
      } catch (err) {
        console.error('[socket] bitmap:request', err);
        socket.emit('checkbox:error', { message: 'bitmap_load_failed' });
      }
    });

    socket.on('checkbox:update', async (payload = {}) => {
      if (!socket.user) {
        socket.emit('checkbox:error', { message: 'login_required', code: 'UNAUTHORIZED' });
        return;
      }

      const index   = Number(payload.index);
      const checked = Boolean(payload.checked);
      if (!Number.isInteger(index) || index < 0 || index >= CHECKBOX_COUNT) return;

      try {
        const { allowed, retryAfterMs } = await checkSocketRateLimit(socket.user.userId);
        if (!allowed) {
          socket.emit('checkbox:rate_limited', { index, retryAfterMs, message: 'RATE_LIMIT' });
          return;
        }
      } catch (err) {
        console.error('[socket] rate_limit eval', err);
        socket.emit('checkbox:error', { message: 'rate_check_failed' });
        return;
      }

      try {
        const prev = await redis.setbit(BITMAP_KEY, index, checked ? 1 : 0);
        if (prev === (checked ? 1 : 0)) return; // no actual state change

        const totalChecked = await redis.bitcount(BITMAP_KEY);
        await redis.publish(PUB_CHANNEL, JSON.stringify({
          index,
          checked,
          user:         socket.user.name,
          timestamp:    Date.now(),
          totalChecked,
        }));
      } catch (err) {
        console.error('[socket] checkbox:update', err);
      }
    });

    socket.on('disconnect', () => {
      console.log(`[socket] disconnect id=${socket.id.slice(0, 6)}`);
    });
  });
}
