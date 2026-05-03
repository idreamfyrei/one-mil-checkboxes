# One Million Checkboxes

- [One mil checkboxes](https://mil-checkboxes.saumyagrawal.in/)
- [IdP](https://auth.saumyagrawal.in/)
Real-time collaborative checkbox board with one million virtualized cells, backed by Redis/Valkey for shared state and pub/sub fan-out.

## Project overview

Users see a 1,000,000-cell canvas grid and can toggle individual checkboxes. Every toggle is immediately reflected for all connected users via WebSockets. State is stored compactly in Redis as a single bitmap. Multiple server instances stay in sync through Redis Pub/Sub.

Anonymous users can view the grid. Only authenticated users (via OIDC login) can toggle checkboxes. Each user is rate-limited to prevent spam.

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Node.js (ESM), Express 5 |
| WebSockets | Socket.IO 4 |
| Data / sessions | Redis / Valkey via ioredis |
| Rate limiting | Custom Lua (socket) + Redis INCR (HTTP) |
| Auth | OAuth 2.0 Authorization Code + PKCE |
| Frontend | Plain HTML + Canvas + vanilla JS |
| Config | `.env` + dotenv |
| Local infra | Docker Compose (Valkey) |

## Features implemented

- 1,000,000-checkbox canvas grid with virtual rendering (only visible rows drawn)
- Real-time sync across all connected clients via Socket.IO + Redis Pub/Sub
- Compact bitmap state storage (`SETBIT` / `BITCOUNT`) — 1M checkboxes = 125 KB
- Full OIDC / OAuth 2.0 Authorization Code + PKCE login flow
- Session stored server-side in Redis with HttpOnly cookie
- Anonymous users: read-only. Authenticated users: can toggle
- Custom rate limiting — no external rate-limit packages used
- Live activity feed (last 20 actions)
- Checked counter displayed in real time

## Folder structure

```
one-mil-checkbox/
├── index.js           Entry point — wires Express, Socket.IO, starts server
├── src/
│   ├── config.js      All constants and env defaults
│   ├── redis.js       Redis client + subscriber setup
│   ├── rate-limit.js  Lua sliding-window (socket) + INCR/EXPIRE (HTTP)
│   ├── auth.js        Session helpers + OIDC auth router
│   └── socket.js      Socket.IO setup, pub/sub fan-out, event handlers
├── public/
│   └── index.html     Full frontend — canvas, auth UI, socket events
├── docker-compose.yml Local Valkey container
├── package.json
├── .env.example
└── README.md
```

## How to run locally

### Prerequisites

- Node.js 18+
- pnpm (`npm i -g pnpm`)
- Docker (for local Valkey)

### 1. Clone and install

```bash
git clone <repo-url>
cd one-mil-checkbox
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — minimum required:

```env
PORT=8000
APP_URL=http://localhost:8000
VALKEY_URL=redis://127.0.0.1:6379
IDP_URL=https://auth.saumyagrawal.in   # URL of your OIDC identity provider
CLIENT_ID=client-id      # client_id registered at the IdP

# REDIRECT_URL=http://localhost:8000/auth/callback
```

### 3. Start Redis / Valkey

```bash
pnpm valkey:up
```

This starts a Valkey container on port 6379 via Docker Compose.

### 4. Start the app

```bash
pnpm start
```

Open `http://localhost:8000`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8000` | HTTP server port |
| `APP_URL` | `http://localhost:8000` | Public base URL of this app (used to build callback URI) |
| `VALKEY_URL` | `redis://127.0.0.1:6379` | Redis / Valkey connection URL |
| `VALKEY_BITMAP_KEY` | `checkbox:bitmap` | Key storing the 1M-bit checkbox state |
| `VALKEY_PUB_CHANNEL` | `checkbox:events` | Pub/Sub channel for broadcasting toggle events |
| `VALKEY_RATE_PREFIX` | `checkbox:rate:` | Prefix for per-user rate limit keys |
| `VALKEY_RATE_TTL_SEC` | `86400` | TTL for rate limit keys (1 day) |
| `CHECKBOX_COUNT` | `1000000` | Number of checkboxes |
| `CHECKBOX_RATE_MS` | `5000` | Minimum ms between toggles per user |
| `IDP_URL` | `http://localhost:3000` | OIDC identity provider base URL |
| `CLIENT_ID` | `one-mil-checkbox` | OAuth client ID registered at the IdP |

## Redis setup instructions

### With Docker Compose (recommended for local dev)

```bash
# Start
pnpm valkey:up

# Stop and remove
pnpm valkey:down
```

### Key structure

| Key pattern | Type | Purpose |
|---|---|---|
| `checkbox:bitmap` | String (bitmap) | 1M-bit checkbox state — 1 bit per checkbox |
| `checkbox:events` | Pub/Sub channel | Broadcasts toggle events to all server instances |
| `checkbox:rate:user:<id>` | String | Timestamp of last allowed toggle for rate limiting |
| `session:<sid>` | String (JSON) | User session data |
| `pkce:<state>` | String (JSON) | PKCE verifier stored during OAuth flow |
| `ratelimit:http:login:<ip>` | String (counter) | Login attempt counter for HTTP rate limiting |

### Why Redis is needed

- **Bitmap state**: 1M checkboxes stored in 125 KB. `SETBIT` and `GETBIT` in O(1). A SQL row per checkbox would need 1M rows and be orders of magnitude slower to bulk-read.
- **Pub/Sub**: When multiple server instances run, a toggle on instance A must reach clients connected to instance B. Redis Pub/Sub is the message bus.
- **Sessions**: Server-side sessions avoid sending user data to the client. HttpOnly cookie holds only a random session ID.
- **Rate limiting**: Redis `EVAL` executes Lua atomically — no race condition between two concurrent socket events from the same user.

## Auth flow explanation

```
Browser                 App Server              IdP (OIDCFlow)
  |                          |                        |
  |-- GET /auth/login ------->|                        |
  |                          |-- generate PKCE ------->|
  |                          |   store state in Redis  |
  |<-- 302 /authorize?... ---|                        |
  |                                                    |
  |-- GET /authorize?... ------------------------------>|
  |<-- 302 /auth/callback?code=... -------------------|
  |                          |                        |
  |-- GET /auth/callback ---->|                        |
  |                          |-- POST /oauth/token --->|
  |                          |<-- access_token --------|
  |                          |-- GET /oauth/userinfo ->|
  |                          |<-- { sub, email, name }--|
  |                          |-- createSession(Redis) --|
  |<-- 302 / + Set-Cookie ---|
```

- PKCE (Proof Key for Code Exchange) prevents authorization code interception — the verifier never leaves the server.
- Sessions are stored in Redis with a 1-hour TTL. The browser holds only a signed session ID in an HttpOnly cookie.
- On Socket.IO connect, the handshake headers are read to attach `socket.user` before any events fire.

## WebSocket flow explanation

```
Client                    Server                   Redis
  |                          |                       |
  |-- connect (cookie) ------>|                       |
  |                          |-- getSession --------->|
  |                          |<-- user or null -------|
  |<-- checkbox:init --------|                       |
  |<-- checkbox:bitmap ------|-- GETRANGE bitmap --->|
  |                          |                       |
  |-- checkbox:update ------->|                       |
  |  { index, checked }      |-- EVAL rate-limit ---->|
  |                          |-- SETBIT index ------->|
  |                          |-- PUBLISH event ------>|
  |                          |                       |
  |               [all server instances receive from Pub/Sub]
  |<-- checkbox:updated -----| io.emit to all clients
```

Socket events:

| Event | Direction | Description |
|---|---|---|
| `checkbox:init` | server → client | Auth state, checkbox count, rate limit config |
| `checkbox:init:request` | client → server | Request fresh init (e.g. after login) |
| `checkbox:bitmap:request` | client → server | Request full bitmap for initial render |
| `checkbox:bitmap` | server → client | Base64-encoded full state snapshot |
| `checkbox:update` | client → server | Toggle request `{ index, checked }` |
| `checkbox:updated` | server → client | Broadcast `{ index, checked, user, totalChecked }` |
| `checkbox:rate_limited` | server → client | Toggle rejected `{ retryAfterMs }` |
| `checkbox:error` | server → client | Error states (unauthenticated, bitmap load fail) |

## Rate limiting logic explanation

Two independent strategies are used — one for HTTP, one for WebSocket:

### HTTP: INCR + EXPIRE (login endpoint)

Applied to `GET /auth/login` per IP address.

```
key = ratelimit:http:login:<ip>
count = INCR key
if count == 1: EXPIRE key 60      ← set TTL only on first hit
if count > 20: return 429
```

Fixed window of 60 seconds, max 20 requests. Simple and correct for protecting against PKCE state flooding. Window resets after 60 s.

### WebSocket: Lua sliding window (checkbox toggles)

Applied per authenticated user ID on every `checkbox:update` event.

```lua
nowMs = current time in milliseconds
prev  = GET ratelimit key
if prev exists and (nowMs - prev) < window:
    return { denied, msUntilAllowed }
SET key nowMs EX ttl
return { allowed, 0 }
```

The Lua script runs atomically inside Redis — no two concurrent toggle events from the same user can both pass the check. The window slides with each action, not on a fixed clock boundary. Rate window is configured via `CHECKBOX_RATE_MS` (default 5 seconds).

## HTTP routes

| Route | Description |
|---|---|
| `GET /auth/login` | Starts OIDC flow — rate limited by IP |
| `GET /auth/callback` | Exchanges auth code, creates session |
| `GET /auth/logout` | Destroys session, clears cookie |
| `GET /auth/me` | Returns current user or 401 |
| `GET /auth/config` | Returns runtime auth config |
| `GET /health` | Health check |


