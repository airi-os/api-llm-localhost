// Setup Script — First-Time Project Configuration
//
// Generates missing secrets, synchronizes shared secrets between repos,
// creates .env files from templates, and populates missing configuration.
//
// Usage:
//   pnpm run setup           — non-interactive setup (default: auto-generate all secrets, deploy proxy)
//   pnpm run setup -- --interactive  — interactive setup (prompts for secrets)
//   pnpm run setup -- --dry-run      — report actions without writing
//   pnpm run setup -- --regenerate   — overwrite existing values

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { parseEnvFile, readEnvFileRaw, writeEnvFile, updateEnvKey } from './lib/env.js';
import { generateHexSecret, generateAdminKey, generateAuthKey } from './lib/crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const llmProxyRoot = path.join(projectRoot, 'llm-proxy');
const frellmapiEnvPath = path.join(projectRoot, '.env');
const llmProxyEnvPath = path.join(llmProxyRoot, '.env');
const frellmapiEnvExample = path.join(projectRoot, '.env.example');
const llmProxyEnvExample = path.join(llmProxyRoot, '.env.example');

// ── CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isRegenerate = args.includes('--regenerate');
const isInteractive = args.includes('--interactive');

if (isDryRun) {
  console.log('=== DRY RUN — no changes will be made ===\n');
}

// ── Helpers ───────────────────────────────────────────────────────────

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const display = defaultValue ? `${question} [${defaultValue}] ` : `${question} `;
  return new Promise((resolve) => {
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function logAction(action: string, key: string, target: string) {
  if (isDryRun) {
    console.log(`  [dry-run] Would ${action} ${key} in ${target}`);
  } else {
    console.log(`  ${action}: ${key} → ${target}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🔧 freellmapi setup\n');

  // ── Step 1: Ensure .env files exist from templates ──────────────────

  const frellmapiEnvExists = fs.existsSync(frellmapiEnvPath);
  const llmProxyEnvExists = fs.existsSync(llmProxyEnvPath);

  if (!frellmapiEnvExists) {
    if (isDryRun) {
      console.log('  [dry-run] Would create .env from .env.example');
    } else {
      fs.copyFileSync(frellmapiEnvExample, frellmapiEnvPath);
      console.log('  Created .env from .env.example');
    }
  }

  if (!llmProxyEnvExists) {
    if (isDryRun) {
      console.log('  [dry-run] Would create llm-proxy/.env from llm-proxy/.env.example');
    } else {
      fs.copyFileSync(llmProxyEnvExample, llmProxyEnvPath);
      console.log('  Created llm-proxy/.env from llm-proxy/.env.example');
    }
  }

  // ── Step 2: Parse existing values ───────────────────────────────────

  const frellmapiEnv = parseEnvFile(frellmapiEnvPath);
  const llmProxyEnv = parseEnvFile(llmProxyEnvPath);

  const frellmapiRaw = readEnvFileRaw(frellmapiEnvPath);
  const llmProxyRaw = readEnvFileRaw(llmProxyEnvPath);

  const frellmapiUpdates = new Map<string, string>();
  const llmProxyUpdates = new Map<string, string>();

  // ── Step 3: Generate missing secrets (REQ-D1) ────────────────────────

  console.log('\n── Secrets ──');

  // ENCRYPTION_KEY
  if (isRegenerate || !frellmapiEnv.has('ENCRYPTION_KEY') || !frellmapiEnv.get('ENCRYPTION_KEY')) {
    const key = generateHexSecret();
    if (frellmapiEnv.has('ENCRYPTION_KEY') && frellmapiEnv.get('ENCRYPTION_KEY')) {
      logAction('regenerate', 'ENCRYPTION_KEY', '.env');
    } else {
      logAction('generate', 'ENCRYPTION_KEY', '.env');
    }
    frellmapiUpdates.set('ENCRYPTION_KEY', key);
  } else {
    console.log('  preserved: ENCRYPTION_KEY (already set)');
  }

  // ADMIN_DASHBOARD_KEY
  if (isRegenerate || !frellmapiEnv.has('ADMIN_DASHBOARD_KEY') || !frellmapiEnv.get('ADMIN_DASHBOARD_KEY')) {
    const key = generateAdminKey();
    if (frellmapiEnv.has('ADMIN_DASHBOARD_KEY') && frellmapiEnv.get('ADMIN_DASHBOARD_KEY')) {
      logAction('regenerate', 'ADMIN_DASHBOARD_KEY', '.env');
    } else {
      logAction('generate', 'ADMIN_DASHBOARD_KEY', '.env');
    }
    frellmapiUpdates.set('ADMIN_DASHBOARD_KEY', key);
  } else {
    console.log('  preserved: ADMIN_DASHBOARD_KEY (already set)');
  }

  // INTERNAL_AUTH_SECRET — must be the same in both repos
  const frellmapiInternal = frellmapiEnv.get('INTERNAL_AUTH_SECRET');
  const llmProxyInternal = llmProxyEnv.get('INTERNAL_AUTH_SECRET');

  const frellmapiHas = !!frellmapiInternal;
  const llmProxyHas = !!llmProxyInternal;

  if (isRegenerate) {
    // Explicit regeneration requested — generate new for both
    const secret = generateHexSecret();
    logAction('regenerate', 'INTERNAL_AUTH_SECRET', '.env + llm-proxy/.env');
    frellmapiUpdates.set('INTERNAL_AUTH_SECRET', secret);
    llmProxyUpdates.set('INTERNAL_AUTH_SECRET', secret);
  } else if (!frellmapiHas && !llmProxyHas) {
    // Neither has it — generate new
    const secret = generateHexSecret();
    logAction('generate', 'INTERNAL_AUTH_SECRET', '.env + llm-proxy/.env');
    frellmapiUpdates.set('INTERNAL_AUTH_SECRET', secret);
    llmProxyUpdates.set('INTERNAL_AUTH_SECRET', secret);
  } else if (frellmapiHas && llmProxyHas) {
    // Both exist — preserve, sync if mismatched
    if (frellmapiInternal !== llmProxyInternal) {
      console.log('  ⚠️  INTERNAL_AUTH_SECRET mismatch detected');
      logAction('sync', 'INTERNAL_AUTH_SECRET', 'llm-proxy/.env → match .env');
      llmProxyUpdates.set('INTERNAL_AUTH_SECRET', frellmapiInternal);
    } else {
      console.log('  preserved: INTERNAL_AUTH_SECRET (already synced)');
    }
  } else {
    // Only one has it — copy existing value to the other (preserve, don't regenerate)
    const existingSecret = frellmapiHas ? frellmapiInternal : llmProxyInternal;
    if (!frellmapiHas) {
      logAction('sync', 'INTERNAL_AUTH_SECRET', '.env ← llm-proxy/.env');
      frellmapiUpdates.set('INTERNAL_AUTH_SECRET', existingSecret);
    } else {
      logAction('sync', 'INTERNAL_AUTH_SECRET', 'llm-proxy/.env ← .env');
      llmProxyUpdates.set('INTERNAL_AUTH_SECRET', existingSecret);
    }
  }

  // AUTH_KEY — auto-generate in non-interactive mode, prompt in interactive mode
  if (isRegenerate || !llmProxyEnv.has('AUTH_KEY') || !llmProxyEnv.get('AUTH_KEY')) {
    if (!isInteractive) {
      // Non-interactive: auto-generate without prompt
      const authKey = generateAuthKey();
      logAction('generate', 'AUTH_KEY', 'llm-proxy/.env');
      llmProxyUpdates.set('AUTH_KEY', authKey);
    } else {
      // Interactive: prompt user
      const suggested = generateAuthKey();
      const authKey = await prompt('Enter AUTH_KEY (or press Enter for random):', suggested);
      if (authKey) {
        logAction('set', 'AUTH_KEY', 'llm-proxy/.env');
        llmProxyUpdates.set('AUTH_KEY', authKey);
      }
    }
  } else {
    console.log('  preserved: AUTH_KEY (already set)');
  }

  // ── Step 4: Router URL discovery (REQ-D3) ───────────────────────────

  console.log('\n── Router Configuration ──');

  if (isInteractive) {
    // Interactive mode: preserve existing prompt behavior
    const existingRouterDomain = llmProxyEnv.get('ROUTER_DOMAIN') || 'router.example.com';
    const routerDomain = await prompt('Enter router domain:', existingRouterDomain);

    if (routerDomain && routerDomain !== existingRouterDomain) {
      logAction('set', 'ROUTER_DOMAIN', 'llm-proxy/.env');
      llmProxyUpdates.set('ROUTER_DOMAIN', routerDomain);
    }

    const llmProxyUrl = `https://${routerDomain}`;
    if (!frellmapiEnv.has('LLM_PROXY_URL') || isRegenerate) {
      logAction('set', 'LLM_PROXY_URL', '.env');
      frellmapiUpdates.set('LLM_PROXY_URL', llmProxyUrl);
    } else {
      console.log('  preserved: LLM_PROXY_URL=' + frellmapiEnv.get('LLM_PROXY_URL'));
    }
  } else {
    // Non-interactive mode: skip ROUTER_DOMAIN entirely, deploy-proxy handles it
    console.log('  ROUTER_DOMAIN and LLM_PROXY_URL will be configured by deploy-proxy');
  }

  // ── Step 5: Write updates ───────────────────────────────────────────

  console.log('\n── Writing Configuration ──');

  if (frellmapiUpdates.size > 0) {
    const { written, preserved, updated } = writeEnvFile(frellmapiEnvPath, frellmapiRaw, frellmapiUpdates, isDryRun);
    for (const k of written) console.log(`  written: ${k}`);
    for (const k of preserved) console.log(`  preserved: ${k}`);
    for (const k of updated) console.log(`  updated: ${k}`);
  } else {
    console.log('  No changes needed in .env');
  }

  if (llmProxyUpdates.size > 0) {
    const { written, preserved, updated } = writeEnvFile(llmProxyEnvPath, llmProxyRaw, llmProxyUpdates, isDryRun);
    for (const k of written) console.log(`  written: ${k}`);
    for (const k of preserved) console.log(`  preserved: ${k}`);
    for (const k of updated) console.log(`  updated: ${k}`);
  } else {
    console.log('  No changes needed in llm-proxy/.env');
  }

  // ── Step 6: Deploy proxy (non-interactive mode only) ─────────────────

  if (!isDryRun && !isInteractive) {
    console.log('\n── Deploying llm-proxy ──');
    const { deployProxy } = await import('./deploy-proxy.js');
    await deployProxy();
  } else if (isDryRun && !isInteractive) {
    console.log('\n  [dry-run] Would run: pnpm run deploy-proxy');
  }

  // ── Step 7: Summary ─────────────────────────────────────────────────

  console.log('\n── Summary ──');
  if (isDryRun) {
    console.log('  Dry run complete. No files were modified.');
  } else if (isInteractive) {
    console.log('  Configuration complete.');
    console.log('\nNext steps:');
    console.log('  pnpm dev                  Start local development');
    console.log('  cd llm-proxy && npm run deploy   Deploy proxy to Cloudflare');
    console.log('  pnpm run verify           Verify deployment');
  } else {
    console.log('  Installation complete. llm-proxy deployed.');
    console.log('\nNext steps:');
    console.log('  pnpm dev                  Start local development');
    console.log('  pnpm run verify           Verify deployment');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Setup failed:', err);
    process.exit(1);
  });
