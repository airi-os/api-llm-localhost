import './env.js';
import './services/logBuffer.js';
import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { assertAdminAuthConfigured } from './middleware/adminAuth.js';
import { startHealthChecker } from './services/health.js';
import { initialize as initTopology } from './services/proxyTopology.js';
import { reconcileTopology } from './services/topologyReconciliation.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  assertAdminAuthConfigured();
  initDb();
  await initTopology();
  await reconcileTopology();
  const app = createApp();

  const server = app.listen(Number(PORT), '0.0.0.0', () => {
    startHealthChecker();
  });

  const shutdown = () => { server.close(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(console.error);
