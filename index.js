import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';

import express from 'express';
import { Server } from 'socket.io';

import { PORT } from './src/config.js';
import { authRouter } from './src/auth.js';
import { setupSocket } from './src/socket.js';

async function main() {
  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server);

  app.use(authRouter);
  app.use(express.static(path.resolve('./public')));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  await setupSocket(io);

  server.listen(PORT, () => {
    console.log(`Listening  →  http://localhost:${PORT}`);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
