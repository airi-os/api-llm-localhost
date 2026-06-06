# IP-Based Sticky Session Capacity Manager

## Overview

This document defines the requirements for an IP-based sticky session capacity manager that extends the existing message-hash-based sticky session system with client IP awareness. The goal is to provide capacity isolation, fair resource distribution, and improved session affinity based on client IP addresses.

## Problem Statement

The current sticky session system uses a hash of the first user message to identify sessions. This approach has limitations:

1. **No capacity isolation**: Multiple clients sharing the same message content get routed to the same model, causing uneven load distribution
2. **No IP awareness**: The system cannot differentiate between requests from different clients that happen to have similar conversation starters
3. **No resource fairness**: A single client could monopolize a model's capacity if their messages hash to the same session key
4. **Limited observability**: No way to see which IPs are consuming what resources

## Goals

1. **Capacity Isolation**: Prevent a single IP from overwhelming a model's capacity
2. **Fair Resource Distribution**: Ensure multiple clients get fair access to model resources
3. **Improved Session Affinity**: Combine IP and message hash for more stable session identification
4. **Configurable Limits**: Allow administrators to set per-IP capacity limits
5. **Observability**: Track IP-based usage for monitoring and debugging

## Functional Requirements

### FR-1: IP Extraction and Normalization

- Extract client IP from request headers (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `req.ip`)
- Normalize IPv6 addresses (expand abbreviated forms, handle IPv4-mapped IPv6)
- Handle multiple IPs in `X-Forwarded-For` header (use first non-private IP)
- Fall back to session-key-only mode when IP cannot be determined

### FR-2: IP-Based Session Key Generation

- Generate session keys combining IP hash + message hash
- Format: `SHA1(routingMode:normalizedIP:firstUserMessage)`
- Maintain backward compatibility with existing message-only session keys
- Support both IP-aware and legacy session modes

### FR-3: Per-IP Capacity Limits

- Track concurrent requests per IP
- Configurable limits:
  - `IP_MAX_CONCURRENT_REQUESTS`: Maximum concurrent requests per IP (default: 5)
  - `IP_SESSION_TTL_MS`: Session TTL for IP-based sessions (default: 30 minutes)
  - `IP_STICKY_TTL_MS`: Sticky session TTL for IP-aware sessions (default: 30 minutes)
- Queue or reject requests exceeding limits
- Per-IP rate limiting on routing decisions

### FR-4: Capacity-Aware Routing

- When routing, consider IP's current load
- Prefer less-loaded IPs for new sessions when possible
- Skip models that are at capacity for a given IP
- Implement IP-based model exclusion during fallback

### FR-5: IP Session Management

- Track IP sessions separately from message sessions
- Clean up stale IP sessions based on TTL
- Support IP-based session clearing (admin function)
- Merge IP session data with message session data

### FR-6: Observability and Metrics

- Log IP-based routing decisions
- Track per-IP request counts
- Track per-IP model distribution
- Expose IP-based statistics via admin API

### FR-7: Configuration

- All limits configurable via environment variables
- Feature flag to enable/disable IP-based sticky sessions
- Per-platform IP limits (optional)
- Admin API for runtime configuration

## Non-Functional Requirements

### NFR-1: Performance

- IP extraction and normalization must add < 1ms latency
- Session key generation must be O(1) after initial hash
- In-memory storage with automatic cleanup (no external dependencies)

### NFR-2: Scalability

- Support up to 10,000 concurrent IP sessions
- Automatic cleanup of stale sessions
- No memory leaks from session accumulation

### NFR-3: Compatibility

- Backward compatible with existing session system
- Graceful degradation when IP cannot be determined
- No breaking changes to existing APIs

### NFR-4: Security

- Do not log full IP addresses (log only hashed IPs for privacy)
- Rate limit IP-based operations to prevent abuse
- No PII stored in session data

## User Interactions and Flows

### Flow 1: Normal Request with IP Awareness

1. Client sends request with API key
2. System extracts and normalizes client IP
3. System generates IP-aware session key
4. System checks IP capacity limits
5. System routes request using existing logic + IP awareness
6. System records IP session data
7. Response returned with IP-aware sticky session

### Flow 2: IP Exceeds Capacity

1. Client sends request
2. System extracts client IP
3. IP is at concurrent request limit
4. System queues request or returns 429 with retry-after
5. When slot opens, request proceeds

### Flow 3: Fallback with IP Awareness

1. Request to preferred model fails
2. System considers IP's current load on fallback models
3. System routes to least-loaded available model for this IP
4. Session updated with new model

## Data Structures

### IP Session Entry

```typescript
interface IPSessionEntry {
  ipHash: string;           // SHA1 hash of normalized IP
  sessionKey: string;       // Combined IP+message session key
  modelDbId: number;        // Current sticky model
  keyId?: number;           // Current sticky key
  bannedPlatforms?: Set<string>;
  lastUsed: number;         // Timestamp
  concurrentRequests: number;
  requestCount: number;      // Total requests in session
}
```

### IP Capacity Tracker

```typescript
interface IPCapacityTracker {
  ipHash: string;
  activeRequests: Set<string>;  // Session keys with active requests
  lastActivity: number;
  totalRequests: number;
}
```

## Edge Cases

1. **No IP available**: Fall back to message-only session key
2. **Private IP range**: Treat as single client (no differentiation)
3. **IP changes mid-session**: Use original IP for session continuity
4. **IPv4-mapped IPv6**: Normalize to standard format
5. **Proxy chain**: Use rightmost non-private IP
6. **Rate limit on IP extraction**: Fail open (use message-only)
7. **Memory pressure**: Aggressive cleanup of stale sessions

## Acceptance Criteria

- [ ] AC-1: Requests from different IPs get different session keys
- [ ] AC-2: Same IP with same message gets same session key
- [ ] AC-3: Concurrent requests per IP are limited to configured value
- [ ] AC-4: IP-based routing considers current IP load
- [ ] AC-5: Stale IP sessions are cleaned up automatically
- [ ] AC-6: Admin can view IP-based statistics
- [ ] AC-7: System degrades gracefully when IP unavailable
- [ ] AC-8: All configuration via environment variables
- [ ] AC-9: No breaking changes to existing functionality
- [ ] AC-10: Performance impact < 1ms per request

## Dependencies

- No new external dependencies
- Uses existing in-memory storage patterns from ratelimit.ts
- Uses existing crypto utilities from lib/crypto.ts
- Extends existing session management in routes/proxy.ts

## Related Documentation

- Existing sticky session implementation: `server/src/routes/proxy.ts`
- Router service: `server/src/services/router.ts`
- Rate limit service: `server/src/services/ratelimit.ts`