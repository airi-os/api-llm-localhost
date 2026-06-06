// Rotate Secrets — Secret Rotation
//
// Rotates INTERNAL_AUTH_SECRET in both .env files.
// Requires explicit user confirmation before making changes.
//
// Usage:
//   pnpm run rotate-secrets           — rotate secrets (interactive)
//   pnpm run rotate-secrets -- --dry-run  — show what would change

import path from 'node:path';
import readline from 'node:readline';
import { parseEnvFile, updateEnvKey } from './lib/env.js';
import { generateHexSecret } from './lib/crypto.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const llmProxyRoot = path.join(projectRoot, 'llm-proxy');
const frellmapiEnvPath = path.join(projectRoot, '.env');
const llmProxyEnvPath = path.join(llmProxyRoot, '.env');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function main(): void {
  if (isDryRun) {
    console.log('=== DRY RUN — no changes will be made ===\n');
  }

  console.log('🔄 Secret Rotation\n');

  const frellmapiEnv = parseEnvFile(frellmapiEnvPath);
  const llmProxyEnv = parseEnvFile(llmProxyEnvPath);

  const currentSecret = frellmapiEnv.get('INTERNAL_AUTH_SECRET');
  if (!currentSecret) {
    console.log('  ⚠️  INTERNAL_AUTH_SECRET not found in .env');
    console.log('  Run "pnpm run setup" first to generate secrets.');
    process.exit(1);
  }

  const newSecret = generateHexSecret();

  console.log('  This will rotate INTERNAL_AUTH_SECRET in both:');
  console.log('    - .env');
  console.log('    - llm-proxy/.env');
  console.log(`  Current: ${currentSecret.slice(0, 8)}...`);
  if (isDryRun) {
    console.log(`  [dry-run] New would be: ${newSecret.slice(0, 8)}...`);
    console.log('\n  [dry-run] No changes were made.');
    console.log('\n  After rotation, you must:');
    console.log('    1. cd llm-proxy && npm run deploy');
    console.log('    2. Restart freellmapi server');
    process.exit(0);
  }
  console.log(`  New:      ${newSecret.slice(0, 8)}...`);
  console.log();

  // We need to readline-confirm, but main() is sync. Use a simple approach.
  // Re-readline in an async IIFE
  (async () => {
    const answer = await prompt('  Proceed with rotation? (yes/no): ');

    if (answer.toLowerCase() !== 'yes') {
      console.log('\n  Rotation cancelled. No changes were made.');
      process.exit(0);
    }

    updateEnvKey(frellmapiEnvPath, 'INTERNAL_AUTH_SECRET', newSecret, false);
    updateEnvKey(llmProxyEnvPath, 'INTERNAL_AUTH_SECRET', newSecret, false);

    console.log('\n  ✅ INTERNAL_AUTH_SECRET rotated in both .env files.');
    console.log('\n  Required follow-up actions:');
    console.log('    1. cd llm-proxy && npm run deploy');
    console.log('    2. Restart freellmapi server');
  })().catch((err) => {
    console.error('❌ Rotation failed:', err);
    process.exit(1);
  });
}

main();
