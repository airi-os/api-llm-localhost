# Implementation Plan: IP‑Based Sticky Session Protection

## Overview
This plan translates the requirements and design specifications into concrete development tasks for integrating IP‑based sticky session protection into the freellmapi-alpha project. The work involves:

1. **Extending the session model** to track IP addresses.
2. **Modifying the router and proxy services** to enforce per‑IP session limits.
3. **Updating configuration handling** to read the rotation pool and max sessions per IP.
4. **Persisting session data** across restarts via SQLite.
5. **Integrating with LongCat special handling** (provider‑ban, smart pool, sticky key).
6. **Adding monitoring and error handling** for IP‑limit exceeded scenarios.
7. **Writing tests** to verify correctness and regression protection.

The plan is ordered to minimize disruption and allow incremental verification.

## Phase 1: Preparation and Foundations

| Task | Description | Files / Tools |
|------|-------------|---------------|
| 1.1 | Create a dedicated branch for the feature (`ip-sticky-sessions`) | Git |
| 1.2 | Add environment variable schema for rotation pool and IP limits | `.env.example` |
| 1.3 | Extend SQLite schema with `session_ips` table | Migration script |
| 1.4 | Implement configuration loader for `ROTATION_POOL_IPS` and `MAX_SESSIONS_PER_IP` | `config.ts` (new) |
| 1.5 | Add unit tests for configuration parsing | `tests/unit/config.test.ts` |

## Phase 2: Session Model and Database Changes

| Task | Description | Files / Tools |
|------|-------------|---------------|
| 2.1 | Define `StickySession` TypeScript interface (includes `ipAddress`) | `shared/types.ts` |
| 2.2 | Create migration to add `session_ips` table | `server/db/migrations/xxxx_add_session_ips.sql` |
| 2.3 | Implement repository methods to persist/restore sessions (CRUD) | `server/services/session-store.ts` |
| 2.4 | Write integration tests for DB persistence | `tests/integration/session-store.test.ts` |

## Phase 3: Core IP‑Based Session Logic

| Task | Description | Files / Tools |
|------|-------------|---------------|
| 3.1 | Modify `proxy.ts` session map to store `ipAddress` with each session | `server/src/routes/proxy.ts` |
| 3.2 | Update `setStickyModel`, `setStickyKey`, `clearStickyModel`, `clearStickyKey` to include IP tracking | `proxy.ts` |
| 3.3 | Implement `getAvailableIpCount()` that parses `ROTATION_POOL_IPS` and returns pool size | `config.ts` |
| 3.4 | Add IP‑limit check before granting sticky session affinity | `proxy.ts` (new helper `isIpSessionLimitReached(ip: string)`) |
| 3.5 | Adjust session allocation flow to reject or fallback when limit exceeded | `proxy.ts` |
| 3.6 | Extend `banPlatformFromSession` and related functions to record IP context | `proxy.ts` |
| 3.7 | Ensure LongCat special handling (provider‑ban cooldown, smart pool, sticky key) still applies after IP limit check | `proxy.ts` |

## Phase 4: Router and Thread Protection Integration

| Task | Description | Files / Tools |
|------|-------------|---------------|
| 4.1 | Update `router.ts` to invoke IP‑limit check during session selection | `router.ts` |
| 4.2 | Modify `evaluateThreadProtection` to consider IP‑based session limits when deciding `provider-ban` vs `model-skip` | `threadProtection.ts` |
| 4.3 | Ensure `getSessionKey` incorporates IP address to keep session affinity per IP | `proxy.ts` |
| 4.4 | Adjust `STICKY_TTL_MS` and `PROVIDER_BAN_STICKY_COOLDOWN_MS` logic to respect IP limits | `proxy.ts` |

## Phase 5: Configuration and Environment

| Task | Description | Files / Tools |
|------|-------------|---------------|
| 5.1 | Add `.env.example` entries: `ROTATION_POOL_IPS`, `MAX_SESSIONS_PER_IP` | `.env.example` |
| 5.2 | Document configuration options in `README.md` | `README.md` |
| 5.3 | Add validation to ensure `ROTATION_POOL_IPS` is a comma‑separated list of valid IPs | `config.ts` |

## Phase 6: Error Handling and Response

| Task | Description | Files / Tools |
|------|-------------|---------------|
| 6.1 | Return HTTP 429 with descriptive message when IP limit is exceeded | `proxy.ts` |
| 6.2 | Log IP‑limit events for observability | `logger.ts` |
| 6.3 | Ensure graceful fallback to non‑sticky routing when IP limit is hit | `proxy.ts` |

## Phase 7: Testing

| Task | Description | Files / Tools |
|------|-------------|---------------|
| 7.1 | Write unit tests for IP‑limit logic (boundary conditions, LongCat) | `tests/unit/ip-limit.test.ts` |
| 7.2 | Write integration tests that simulate multiple requests from same IP | `tests/integration/ip-limit.integration.test.ts` |
| 7.3 | Add end‑to‑end tests covering: normal sticky session, IP limit rejection, LongCat IP handling | `tests/e2e/ip-sticky-sessions.e2e.ts` |
| 7.4 | Run existing test suite to ensure no regressions | `pnpm test` |

## Phase 8: Documentation and Release

| Task | Description | Files / Tools |
|------|-------------|---------------|
| 8.1 | Update architecture diagram to show IP‑session flow | `docs/architecture/ip-sticky-sessions.md` |
| 8.2 | Add user‑facing documentation explaining the new IP‑based sticky session behavior | `docs/user-guide/ip-sticky-sessions.md` |
| 8.3 | Increment migration version and apply DB migration | Migration script |
| 8.4 | Create pull request and obtain reviews | GitHub |
| 8.5 | Deploy to staging and monitor for IP‑limit errors | CI/CD pipeline |
| 8.6 | Tag release and announce in changelog | `CHANGELOG.md` |

## Phase 9: Monitoring and Post‑Deployment

| Task | Description | Tools |
|------|-------------|-------|
| 9.1 | Set up Prometheus metrics for `ip_session_limit_exceeded_total` | Monitoring |
| 9.2 | Configure alerting on high IP‑limit rejection rates | Alerting |
| 9.3 | Conduct load testing to validate performance impact | Load test tool |
| 9.4 | Gather feedback from operators and adjust `MAX_SESSIONS_PER_IP` if needed | Ops |

## Dependencies and Risks

- **Database Migration**: Must increment migration version; ensure backward compatibility.
- **Performance**: IP‑limit checks are O(1) lookups; ensure no latency regression.
- **Concurrency**: In‑memory session map is used; consider thread‑safety if scaling horizontally.
- **LongCat Interaction**: Must preserve provider‑ban cooldown and smart pool behavior.

## Next Steps

1. **Proceed with implementation** of Phase 1 tasks (branch creation, env schema, DB migration).
2. **Iteratively develop** each phase, running tests after completion.
3. **Coordinate deployment** with operations to monitor IP‑limit metrics.
