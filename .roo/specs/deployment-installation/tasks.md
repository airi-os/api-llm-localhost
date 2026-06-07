# Deployment & Installation Tasks

## Phase 1: Install Scripts (Repository Bootstrapping)

- [ ] **T1.1**: Create `install.sh` for Linux/macOS
  - Clone repository if not already present (or operate on current directory)
  - Run `git submodule update --init`
  - Run `pnpm install` in root
  - Run `cd llm-proxy && npm install`
  - Validate prerequisites: `node --version`, `pnpm --version`, `wrangler --version`
  - Check `wrangler whoami`; if not authenticated, print instructions for `wrangler login`
  - Invoke `pnpm run setup` automatically after bootstrapping
  - Print: "Installation complete. Run 'pnpm dev' to start locally."
  - Implement idempotency: safe to re-run, does not modify `.env` files, does not delete repositories
  - Exit 0 on success, non-zero on failure

- [ ] **T1.2**: Create `install.ps1` for Windows
  - Same responsibilities as T1.1, adapted for PowerShell
  - Use `git submodule update --init` (same command works in PowerShell)
  - Handle Windows-specific path and execution policy considerations
  - Invoke `pnpm run setup` automatically after bootstrapping
  - Exit 0 on success, non-zero on failure

- [ ] **T1.3**: Add execute permission handling in `install.sh`
  - `chmod +x install.sh` documented in README
  - Script self-checks and warns if not executable

## Phase 2: Setup Script (First-Time Configuration)

- [ ] **T2.1**: Create `scripts/setup.ts` in freellmapi-alpha root
  - Read existing `.env` or create from `.env.example`
  - Generate `ENCRYPTION_KEY` if missing (64 hex chars)
  - Generate `ADMIN_DASHBOARD_KEY` if missing (`freellmapi-admin-<random>`)
  - Generate `INTERNAL_AUTH_SECRET` if missing (64 hex chars)
  - Prompt for `AUTH_KEY` with random default
  - Prompt for `ROUTER_DOMAIN` with default from llm-proxy `.env`
  - Write `LLM_PROXY_URL` to freellmapi `.env`
  - Write `INTERNAL_AUTH_SECRET` to llm-proxy `.env`
  - Print summary and next steps
  - Exit 0 on success, non-zero on failure

- [ ] **T2.2**: Add `setup` script to root `package.json`
  - `"setup": "tsx scripts/setup.ts"`

- [ ] **T2.3**: Add `tsx` to root `devDependencies` if not present
  - Already present via server workspace, but ensure root-level access

- [ ] **T2.4**: Implement `.env` merge logic
  - Parse existing `.env` into key-value map
  - Only write keys that are missing
  - Preserve comments and ordering where possible
  - Append new keys at end of file

- [ ] **T2.5**: Implement REQ-D8 preservation behavior in setup script
  - Existing keys in `.env` are never overwritten by default
  - Preserves all values: secrets (`ENCRYPTION_KEY`, `ADMIN_DASHBOARD_KEY`, `AUTH_KEY`, `INTERNAL_AUTH_SECRET`), URLs (`LLM_PROXY_URL`), counts (`PROXY_IP_COUNT`), and any future configuration keys
  - `--regenerate` flag allows explicit overwrite of existing values
  - Never delete or truncate `.env` files
  - Print which values were preserved vs generated

- [ ] **T2.6**: Implement REQ-D9 dry-run support in setup script
  - `--dry-run` flag reports all intended actions
  - No files written or modified in dry-run mode
  - Clear "DRY RUN" header in output
  - Exit 0 unless validation fails

## Phase 3: Secret Synchronization

- [ ] **T3.1**: Create `scripts/sync-secrets.ts`
  - Read `INTERNAL_AUTH_SECRET` from both `.env` files
  - Compare values
  - If mismatch: update llm-proxy `.env` to match freellmapi `.env`
  - Print sync status
  - Exit 0 on success, non-zero on failure

- [ ] **T3.2**: Add `sync-secrets` script to root `package.json`
  - `"sync-secrets": "tsx scripts/sync-secrets.ts"`

- [ ] **T3.3**: Implement REQ-D9 dry-run support in sync-secrets
  - `--dry-run` reports what would change without writing

## Phase 4: Post-Deploy Verification

- [ ] **T4.1**: Create `scripts/verify-deploy.ts`
  - Read `LLM_PROXY_URL` and `INTERNAL_AUTH_SECRET` from `.env`
  - Check 1: llm-proxy deployment reachable (network connectivity)
  - Check 2: `GET /internal/v1/topology` returns HTTP 200
  - Check 3: Response validates against topology schema (all required fields, correct types)
  - Check 4: freellmapi can retrieve topology (end-to-end, if server running)
  - Check 5: `workerCount >= 0`
  - Check 6: fallback mode reported correctly when dynamic topology unavailable
  - Print pass/fail for each check
  - Exit 0 if all pass, non-zero if any fail

- [ ] **T4.2**: Add `verify` script to root `package.json`
  - `"verify": "tsx scripts/verify-deploy.ts"`

- [ ] **T4.3**: Implement REQ-D9 dry-run support in verify-deploy
  - `--dry-run` reports what checks would run without making network calls

## Phase 5: Secret Rotation

- [ ] **T5.1**: Create `scripts/rotate-secrets.ts`
  - Generate new `INTERNAL_AUTH_SECRET`
  - Require explicit user confirmation before writing (REQ-D8)
  - Update both `.env` files
  - Print required follow-up actions (redeploy llm-proxy, restart server)
  - Exit 0 on success or user decline, non-zero on failure

- [ ] **T5.2**: Add `rotate-secrets` script to root `package.json`
  - `"rotate-secrets": "tsx scripts/rotate-secrets.ts"`

- [ ] **T5.3**: Implement REQ-D9 dry-run support in rotate-secrets
  - `--dry-run` shows what the new secret would be without writing

## Phase 6: README Updates

- [ ] **T6.1**: Update freellmapi-alpha `README.md` Quick Start section
  - Document install script as the primary entry point (`./install.sh` / `.\install.ps1`)
  - Document that install invokes setup automatically (no separate step needed)
  - Document `pnpm dev` for local development
  - Document `cd llm-proxy && npm run deploy` for production proxy deploy
  - Document `pnpm run verify` for post-deploy verification
  - Remove manual `git submodule update --init` instructions (owned by install scripts)

- [ ] **T6.2**: Update llm-proxy `README.md` Setup section
  - Reference freellmapi-alpha install + setup scripts as the primary path
  - Keep manual `cp .env.example .env` as fallback path

## Phase 7: Validation

- [ ] **T7.1**: Test install script on clean environment
  - Verify repository cloned (if needed)
  - Verify submodules initialized
  - Verify dependencies installed
  - Verify prerequisite checks work
  - Verify setup is invoked automatically
  - Verify exit code 0 on success

- [ ] **T7.2**: Test install script idempotency
  - Re-run on already-bootstrapped environment
  - Verify no `.env` files are modified
  - Verify no repositories are deleted
  - Verify submodules are updated (not re-cloned)
  - Verify exit code 0

- [ ] **T7.3**: Test setup script on clean clone (no `.env` files)
  - Verify all secrets generated
  - Verify both `.env` files created correctly
  - Verify `LLM_PROXY_URL` is valid HTTPS URL

- [ ] **T7.4**: Test setup script idempotency (re-run with existing `.env`)
  - Verify existing values preserved (REQ-D8)
  - Verify only missing keys are added
  - Verify all configuration values preserved (not just secrets)

- [ ] **T7.5**: Test setup script `--regenerate` flag
  - Verify existing values are overwritten when flag is used

- [ ] **T7.6**: Test `--dry-run` on all four scripts (REQ-D9)
  - setup.ts: reports actions, writes nothing
  - sync-secrets.ts: reports sync status, writes nothing
  - rotate-secrets.ts: shows new secret, writes nothing
  - verify-deploy.ts: reports checks, makes no network calls
  - All return exit code 0

- [ ] **T7.7**: Test sync-secrets with mismatched `INTERNAL_AUTH_SECRET`
  - Verify llm-proxy `.env` is updated to match

- [ ] **T7.8**: Test verify-deploy against running llm-proxy
  - Verify all six checks pass
  - Verify clear error when endpoint unreachable
  - Verify non-zero exit code on failure

- [ ] **T7.9**: Test rotate-secrets confirmation flow
  - Verify new secret written to both `.env` files on confirm
  - Verify no changes on reject
  - Verify exit code 0 on decline

- [ ] **T7.10**: Verify `.gitignore` excludes `.env` in both repos
  - freellmapi-alpha `.gitignore` must include `.env`
  - llm-proxy `.gitignore` must include `.env`

## Dependencies

```
T1.1, T1.2 → T1.3 (install scripts before permission docs)
T2.1 → T2.2, T2.3 (setup script + package.json entry)
T2.1 → T2.4, T2.5, T2.6 (setup script features)
T3.1 → T3.2, T3.3 (sync script + package.json + dry-run)
T4.1 → T4.2, T4.3 (verify script + package.json + dry-run)
T5.1 → T5.2, T5.3 (rotate script + package.json + dry-run)
T1.x, T2.x → T6.x (scripts must exist before README documents them)
T1.x, T2.x, T3.x, T4.x, T5.x → T7.x (all scripts must exist before validation)
```
