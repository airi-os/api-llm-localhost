import './env.js';
import './services/logBuffer.js';
import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { assertAdminAuthConfigured } from './middleware/adminAuth.js';
import { startHealthChecker } from './services/health.js';

const PORT = process.env.PORT ?? 3001;

function main() {
  assertAdminAuthConfigured();
  initDb();
  const app = createApp();

  const server = app.listen(Number(PORT), '0.0.0.0', () => {
    startHealthChecker();
  });

  const shutdown = () => { server.close(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(console.error);
