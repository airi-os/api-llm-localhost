#!/usr/bin/env python3
"""Replace the streaming block in proxy.ts with the redesigned approach."""

with open('server/src/routes/proxy.ts', 'r') as f:
    content = f.read()

# Find the streaming block boundaries
# Start: line with "      if (stream) {"
# End: line with "      } else {" (the non-streaming path)

lines = content.split('\n')

# Find the if(stream) line
stream_start = None
for i, line in{