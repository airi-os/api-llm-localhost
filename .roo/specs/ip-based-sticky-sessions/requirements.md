# Requirements Specification: IP‑Based Sticky Session Protection

## 1. Overview
Modify the sticky session mechanism in freellmapi-alpha to base session affinity on the number of available IP addresses in the rotation pool. Each API key may be used concurrently by only one IP address; for LongCat, each IP address may host one LongCat session in the rotation pool.

## 2. Scope
- Update router.ts and related services to track available IP addresses in the rotation pool.
- Enforce a limit of one concurrent session per IP address for regular platforms.
- Apply a limit of one concurrent LongCat session per IP address, with special handling for provider‑ban, smart pool, and sticky key.
- Preserve existing sticky model/key affinity logic.
- Maintain backward compatibility with existing configurations.

## 3. Functional Requirements
1. **IP Pool Discovery**
   - Load the rotation pool configuration (e.g., environment variable `ROTATION_POOL_IPS` or a config file) that lists available IP addresses.
   - Parse the pool to obtain a count of available IPs at startup and on configuration change.

2. **Session Tracking**
   - Extend the in‑memory sticky session map to record the IP address associated with each session.
   - Enforce a per‑IP concurrent session limit of 1 for regular platforms.
   - Enforce a per‑IP concurrent session limit of 1 for LongCat sessions, respecting provider‑ban, smart pool, and sticky key rules.

3. **Integration with Existing Logic**
   - When allocating a sticky session, check the IP‑based limit before granting affinity.
   - If the limit is reached, either reject the request with a 429 status or fall back to non‑sticky routing.
   - Update `setStickyModel`, `setStickyKey`, and related functions to store the IP address alongside model/key identifiers.

4. **LongCat Special Handling**
   - Apply the same IP‑based limit to LongCat sessions.
   - Ensure provider‑ban cooldown and smart pool logic still apply while respecting the IP limit.

5. **Configuration Flexibility**
   - Allow the maximum allowed sessions per IP to be configurable (default: 1).
   - Provide a configuration option to enable/disable the IP‑based enforcement.

## 4. Non‑Functional Requirements
- **Performance**: Minimal impact on request latency; IP checks must be O(1).
- **Reliability**: Session state must survive server restarts via persistent storage (e.g., SQLite).
- **Security**: Do not expose internal IP pool details to clients.
- **Maintainability**: Clear module boundaries; all new logic must be documented.

## 5. Assumptions
- The rotation pool is defined externally (environment variable or config file) and lists reachable IP addresses.
- Each API key is constrained to a single IP address at any given time.
- LongCat sessions have distinct protection levels (`provider-ban`, `smart pool`, `sticky key`) but still obey the per‑IP session limit.

## 6. Constraints
- Existing in‑memory session map (`stickySessions`) must be extended without breaking current functionality.
- Database schema may need an additional table for IP‑session mapping; migrations must follow the existing versioning convention.
- The solution must not alter the public API contracts of existing endpoints.

## 7. User Stories
- **As a client**, I want my sessions to be pinned to a specific IP address so that only one active session per IP is allowed, preventing abuse of rate limits.
- **As a system**, I need to dynamically discover the pool of available IP addresses and adjust session limits accordingly.
- **As an operator**, I want to configure the maximum sessions per IP via configuration, allowing flexibility for future changes.

## 8. Success Criteria
- Sessions are rejected or rerouted when the per‑IP concurrent session limit is exceeded.
- No regression in existing sticky session behavior for model or key affinity.
- All new functionality is covered by unit and integration tests.
- Documentation is updated with design diagrams and configuration instructions.

## 9. Open Questions
- Should the IP pool be refreshed periodically or only at startup?
- How should session cleanup be handled when an IP becomes unavailable or a client disconnects?
- Which persistence mechanism (SQLite table vs. in‑memory cache) best balances performance and reliability?
