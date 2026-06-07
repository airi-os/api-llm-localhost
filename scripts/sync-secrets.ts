// Sync Secrets — Synchronize INTERNAL_AUTH_SECRET between freellmapi and llm-proxy
//
// Ensures both .env files share the same INTERNAL_AUTH_SECRET value.
// Reads from freellmapi .env as the source of truth.
//
// Usage:
//   pnpm run sync-secrets           — sync secrets
//   pnpm run sync-secrets -- --dry-run  — report without writing

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, updateEnvKey } from './lib/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const llmProxyRoot = path.join(projectRoot, 'llm-proxy');
const frellmapiEnvPath = path.join(projectRoot, '.env');
const llmProxyEnvPath = path.join(llmProxyRoot, '.env');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

if (isDryRun) {
  console.log('=== DRY RUN — no changes will be made ===\n');
}

function main(): void {
  console.log('🔄 Syncing INTERNAL_AUTH_SECRET\n');

  const frellmapiEnv = parseEnvFile(frellmapiEnvPath);
  const llmProxyEnv = parseEnvFile(llmProxyEnvPath);

  const frellmapiSecret = frellmapiEnv.get('INTERNAL_AUTH_SECRET');
  const llmProxySecret = llmProxyEnv.get('INTERNAL_AUTH_SECRET');

  if (!frellmapiSecret) {
    console.log('  ⚠️  INTERNAL_AUTH_SECRET not found in .env');
    console.log('  Run "pnpm run setup" first to generate secrets.');
    process.exit(1);
  }

  if (!llmProxySecret) {
    console.log('  INTERNAL_AUTH_SECRET missing in llm-proxy/.env');
    if (isDryRun) {
      console.log('  [dry-run] Would write INTERNAL_AUTH_SECRET to llm-proxy/.env');
    } else {
      updateEnvKey(llmProxyEnvPath, 'INTERNAL_AUTH_SECRET', frellmapiSecret, false);
      console.log('  ✅ Wrote INTERNAL_AUTH_SECRET to llm-proxy/.env');
    }
  } else if (frellmapiSecret !== llmProxySecret) {
    console.log('  Mismatch detected:');
    console.log(`    .env:             ${frellmapiSecret.slice(0, 8)}...`);
    console.log(`    llm-proxy/.env:   ${llmProxySecret.slice(0, 8)}...`);
    if (isDryRun) {
      console.log('  [dry-run] Would update llm-proxy/.env to match .env');
    } else {
      updateEnvKey(llmProxyEnvPath, 'INTERNAL_AUTH_SECRET', frellmapiSecret, false);
      console.log('  ✅ Updated llm-proxy/.env to match .env');
    }
  } else {
    console.log('  ✅ INTERNAL_AUTH_SECRET is already in sync');
  }
}

main();
