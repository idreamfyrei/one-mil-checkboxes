import Redis from 'ioredis';
import { VALKEY_URL } from './config.js';

export const redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
export const sub   = redis.duplicate();

redis.on('error', (err) => console.error('[redis]', err.message));
sub.on('error',   (err) => console.error('[redis:sub]', err.message));
