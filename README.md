# One Million Checkbox

Real-time collaborative checkbox board with one million virtualized cells, backed by Valkey for shared state and pub/sub fanout.

## What this project does

- Renders a 1,000,000-cell grid on a single canvas.
- Syncs checkbox updates in real time across connected clients using Socket.IO.
- Persists state in Valkey as a bitmap (`SETBIT`, `BITCOUNT`).
- Uses OAuth/OIDC login flow (Authorization Code + PKCE) with session cookies.
- Restricts toggle actions to authenticated users and rate-limits by user ID.

## Tech stack

- Backend: `Node.js` (ESM), `Express 5`, `Socket.IO`
- Data layer: `Valkey` via `ioredis`
- Auth: OAuth/OIDC style redirect flow with PKCE + session in Valkey
- Frontend: Plain `HTML + Canvas + vanilla JS` served from `public/`
- Config: `.env` + `dotenv`
- Local infrastructure: `docker compose` for Valkey

## Current folder structure

```text
one-mil-checkbox/
├── index.js
├── public/
│   └── index.html
├── docker-compose.yml
├── package.json
├── pnpm-lock.yaml
├── .env.example
└── README.md
```

### Folder notes

- `index.js`: Main app entry point (Express routes, Socket.IO handlers, auth/session logic, Valkey pub/sub, rate limiting Lua).
- `public/index.html`: Entire UI (rendering, auth UI state, websocket events, activity feed).
- `docker-compose.yml`: Local Valkey container.
- `.env.example`: Required environment variables and defaults.

## Realtime architecture

ss1

How update propagation works:

1. User clicks a checkbox in the canvas.
2. Client emits `checkbox:update` via Socket.IO.
3. Server validates auth, validates index, runs rate-limit Lua in Valkey.
4. Server writes bit with `SETBIT`.
5. Server publishes update event to Valkey pub/sub channel.
6. Subscriber receives it and emits `checkbox:updated` to connected clients.
7. Clients patch local bitmap + redraw only visible region.

## Auth and IdP flow

The app implements an OAuth/OIDC-style flow against your IdP:

- `/auth/login` creates PKCE verifier/challenge and redirects to IdP `/authorize`.
- IdP redirects back to `/auth/callback` with auth code.
- Server exchanges code at IdP `/oauth/token`.
- Server fetches profile from IdP `/oauth/userinfo`.
- Server creates session in Valkey and sets `cb_session` HttpOnly cookie.
- Socket handshake reads this cookie and attaches `socket.user`.

ss2

## Route map (what each route does)

### HTTP routes

- `GET /auth/login`: Starts login flow, stores PKCE verifier, redirects to IdP authorize URL.
- `GET /auth/config`: Returns runtime auth config (`idpUrl`, `appUrl`, `clientId`, `redirectUri`).
- `GET /auth/callback`: Exchanges code for token, loads userinfo, creates session cookie, redirects home.
- `GET /auth/logout`: Deletes session and clears cookie.
- `GET /auth/me`: Returns current user from session, else `401`.
- `GET /health`: Basic health endpoint.
- `GET /` and static assets: Served by `express.static(public)`.

### Socket events

- `checkbox:init:request`: Client asks for fresh init payload.
- `checkbox:init` (server -> client): Sends `checkboxCount`, `totalChecked`, `rateLimitMs`, `user`.
- `checkbox:bitmap:request`: Client requests full bitmap snapshot.
- `checkbox:bitmap` (server -> client): Base64 bitmap payload.
- `checkbox:update`: Authenticated toggle request.
- `checkbox:updated` (server -> clients): Broadcasted state change event.
- `checkbox:rate_limited` (server -> client): Sent when user exceeds update window.
- `checkbox:error` (server -> client): Error states such as unauthenticated writes.

## Local setup

### Prerequisites

- Node.js 18+
- `pnpm` (project uses `pnpm@10.11.0`)
- Docker (optional, for local Valkey)

### 1) Install dependencies

```bash
pnpm install
```

### 2) Configure environment

```bash
cp .env.example .env
```

Minimum env keys:

- `PORT`: App port (default `8000`)
- `APP_URL`: App base URL (must match callback host)
- `VALKEY_URL`: Valkey connection URL
- `VALKEY_BITMAP_KEY`: Bitmap key name
- `VALKEY_PUB_CHANNEL`: Pub/sub channel name
- `VALKEY_RATE_PREFIX`: Prefix for rate keys
- `VALKEY_RATE_TTL_SEC`: Rate key TTL
- `CHECKBOX_COUNT`: Total logical checkboxes
- `CHECKBOX_RATE_MS`: Minimum interval between updates per user
- `IDP_URL`: Identity provider base URL
- `CLIENT_ID`: Registered client ID in your IdP

### 3) Start Valkey

```bash
pnpm valkey:up
```

### 4) Start the app

```bash
pnpm start
```

Open `http://localhost:8000`.

## End-to-end flow summary

1. Browser loads UI from `public/index.html`.
2. UI calls `/auth/me` to determine login state.
3. UI opens Socket.IO connection.
4. Server emits init payload (`checkbox:init`), then bitmap (`checkbox:bitmap`) on request.
5. User click emits `checkbox:update`.
6. Server enforces auth + distributed rate limit, writes bit, publishes event.
7. All clients receive `checkbox:updated`, mutate local cache, and redraw.

## License

ISC (see `package.json`).
