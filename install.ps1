# Install Script — Windows Bootstrap
#
# Bootstraps the freellmapi-alpha project:
#   1. Initialize/update git submodules
#   2. Install dependencies
#   3. Validate prerequisites
#   4. Invoke setup automatically
#
# Usage: .\install.ps1
# Idempotent: safe to re-run.

param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

if ($DryRun) {
    Write-Host "=== DRY RUN -- no changes will be made ==="
    Write-Host ""
}

function Log { param($msg) Write-Host "  $msg" }
function Info { param($msg) Write-Host "🔧 $msg" }
function Ok   { param($msg) Write-Host "✅ $msg" }
function Warn { param($msg) Write-Host "⚠️  $msg" }
function Err  { param($msg) Write-Host "❌ $msg" }

##############################################################################
# Step 1: Git submodules
##############################################################################

Info "Checking git submodules"

if (-not (Test-Path "$ScriptDir\llm-proxy\package.json")) {
    Log "Submodule not initialized. Running: git submodule update --init"
    if (-not $DryRun) {
        git submodule update --init
        Ok "Submodule initialized"
    } else {
        Log "[dry-run] Would run: git submodule update --init"
    }
} else {
    Log "Updating submodules to committed revision"
    if (-not $DryRun) {
        git submodule update --init
        Ok "Submodules up to date"
    } else {
        Log "[dry-run] Would run: git submodule update --init"
    }
}

##############################################################################
# Step 2: Install dependencies
##############################################################################

Info "Installing dependencies"

if (Test-Path "$ScriptDir\node_modules") {
    Log "Root node_modules already present -- running pnpm install to update"
} else {
    Log "Installing root dependencies"
}

if (-not $DryRun) {
    pnpm install
    Ok "Root dependencies installed"
} else {
    Log "[dry-run] Would run: pnpm install"
}

if (Test-Path "$ScriptDir\llm-proxy\node_modules") {
    Log "llm-proxy node_modules already present -- running npm install to update"
} else {
    Log "Installing llm-proxy dependencies"
}

if (-not $DryRun) {
    Push-Location "$ScriptDir\llm-proxy"
    npm install
    Pop-Location
    Ok "llm-proxy dependencies installed"
} else {
    Log "[dry-run] Would run: cd llm-proxy; npm install"
}

##############################################################################
# Step 3: Validate prerequisites
##############################################################################

Info "Validating prerequisites"

# Node.js
try {
    $nodeVersion = node --version
    Ok "Node.js: $nodeVersion"
} catch {
    Err "Node.js not found. Please install Node.js and try again."
    exit 1
}

# pnpm
try {
    $pnpmVersion = pnpm --version
    Ok "pnpm: $pnpmVersion"
} catch {
    Err "pnpm not found. Please install pnpm and try again."
    exit 1
}

# wrangler
try {
    $wranglerVersion = (npx wrangler --version 2>$null | Select-Object -First 1)
    if ($wranglerVersion) {
        Ok "wrangler: $wranglerVersion"
    } else {
        Warn "wrangler not found. Install with: npm install -g wrangler"
    }
} catch {
    Warn "wrangler not found. Install with: npm install -g wrangler"
}

# Wrangler authentication
Log "Checking Wrangler authentication..."
try {
    $whoami = npx wrangler whoami 2>$null
    if ($LASTEXITCODE -eq 0) {
        Ok "Wrangler authenticated"
    } else {
        Warn "Wrangler not authenticated."
        Warn "Run: npx wrangler login"
        Warn "(You can continue setup and authenticate later before deploying llm-proxy)"
    }
} catch {
    Warn "Wrangler not authenticated."
    Warn "Run: npx wrangler login"
    Warn "(You can continue setup and authenticate later before deploying llm-proxy)"
}

##############################################################################
# Step 4: Invoke setup
##############################################################################

Info "Running setup"

if (-not $DryRun) {
    pnpm run setup
    Ok "Setup complete"
} else {
    Log "[dry-run] Would run: pnpm run setup"
}

##############################################################################
# Done
##############################################################################

Write-Host ""
Ok "Installation complete!"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  pnpm dev                        Start local development"
Write-Host "  cd llm-proxy; npm run deploy    Deploy proxy to Cloudflare"
Write-Host "  pnpm run verify                 Verify deployment"
