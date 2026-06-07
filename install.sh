#!/usr/bin/env bash
# Install Script — Linux/macOS Bootstrap
#
# Bootstraps the freellmapi-alpha project:
#   1. Initialize/update git submodules
#   2. Install dependencies
#   3. Validate prerequisites
#   4. Invoke setup automatically
#
# Usage: ./install.sh
# Idempotent: safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  echo "=== DRY RUN — no changes will be made ==="
  echo
fi

log() { echo "  $1"; }
info() { echo "🔧 $1"; }
ok() { echo "✅ $1"; }
warn() { echo "⚠️  $1"; }
err() { echo "❌ $1"; }

##############################################################################
# Step 1: Git submodules
##############################################################################

info "Checking git submodules"

if [[ ! -f "$SCRIPT_DIR/llm-proxy/package.json" ]]; then
  log "Submodule not initialized. Running: git submodule update --init"
  if [[ $DRY_RUN -eq 0 ]]; then
    git submodule update --init
    ok "Submodule initialized"
  else
    log "[dry-run] Would run: git submodule update --init"
  fi
else
  log "Updating submodules to committed revision"
  if [[ $DRY_RUN -eq 0 ]]; then
    git submodule update --init
    ok "Submodules up to date"
  else
    log "[dry-run] Would run: git submodule update --init"
  fi
fi

##############################################################################
# Step 2: Install dependencies
##############################################################################

info "Installing dependencies"

# Check if node_modules already exist (idempotency)
if [[ -d "$SCRIPT_DIR/node_modules" ]]; then
  log "Root node_modules already present — running pnpm install to update"
else
  log "Installing root dependencies"
fi

if [[ $DRY_RUN -eq 0 ]]; then
  pnpm install
  ok "Root dependencies installed"
else
  log "[dry-run] Would run: pnpm install"
fi

if [[ -d "$SCRIPT_DIR/llm-proxy/node_modules" ]]; then
  log "llm-proxy node_modules already present — running npm install to update"
else
  log "Installing llm-proxy dependencies"
fi

if [[ $DRY_RUN -eq 0 ]]; then
  cd "$SCRIPT_DIR/llm-proxy"
  npm install
  cd "$SCRIPT_DIR"
  ok "llm-proxy dependencies installed"
else
  log "[dry-run] Would run: cd llm-proxy && npm install"
fi

##############################################################################
# Step 3: Validate prerequisites
##############################################################################

info "Validating prerequisites"

# Node.js
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version)
  ok "Node.js: $NODE_VERSION"
else
  err "Node.js not found. Please install Node.js and try again."
  exit 1
fi

# pnpm
if command -v pnpm &>/dev/null; then
  PNPM_VERSION=$(pnpm --version)
  ok "pnpm: $PNPM_VERSION"
else
  err "pnpm not found. Please install pnpm and try again."
  exit 1
fi

# wrangler
if command -v npx &>/dev/null && npx wrangler --version &>/dev/null; then
  WRANGLER_VERSION=$(npx wrangler --version 2>/dev/null | head -1)
  ok "wrangler: $WRANGLER_VERSION"
else
  warn "wrangler not found. Install with: npm install -g wrangler"
fi

# Wrangler authentication
log "Checking Wrangler authentication..."
if npx wrangler whoami &>/dev/null; then
  ok "Wrangler authenticated"
else
  warn "Wrangler not authenticated."
  warn "Run: npx wrangler login"
  warn "(You can continue setup and authenticate later before deploying llm-proxy)"
fi

##############################################################################
# Step 4: Invoke setup
##############################################################################

info "Running setup"

if [[ $DRY_RUN -eq 0 ]]; then
  pnpm run setup
  ok "Setup complete"
else
  log "[dry-run] Would run: pnpm run setup"
fi

##############################################################################
# Done
##############################################################################

echo
ok "Installation complete!"
echo
echo "Next steps:"
echo "  pnpm dev                        Start local development"
echo "  cd llm-proxy && npm run deploy  Deploy proxy to Cloudflare"
echo "  pnpm run verify                 Verify deployment"
