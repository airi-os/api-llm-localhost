#!/usr/bin/env python3
"""Replace the streaming block in proxy.ts with Promise.race-based stall detection."""

# Read the before and after parts
with open('/tmp/before.ts', 'r') as f:
    before = f.read()

with open('/tmp/after.ts', 'r') as f:
    after = f.read()  # starts with "} else {"

# The new streaming block
new_streaming = r'''      if (stream) {
        // SSE headers set immediately so keep-alive works during TTFB.
        // Pre-stream errors stay retryable; mid-stream errors emit an SSE error frame.
        let totalOutputTokens = 0;
        let streamedText = '';
        let sawToolCalls = false;
        let streamStarted = false;
        let ttfbMs: number | null = null;
        let lastChunkTimestamp = Date.now();
        let heartbeatInterval: ReturnType<typeof setInterval>{