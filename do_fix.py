#!/usr/bin/env python3
"""Replace the streaming block in proxy.ts with Promise.race-based stall detection."""

with open('server/src/routes/proxy.ts', 'r') as f:
    content = f.read()

{