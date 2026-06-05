# Tasks: SSE Stream Heartbeats and Stall Protection

## Task List

- [ ] Add `KEEPALIVE_INTERVAL_MS = 15000` and `MAX_STREAM_STALL_MS = 45000` constants after `LONGCAT_STICKY_COOLDOWN_MS` in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:18)
- [ ] Add `lastChunkTimestamp`, `heartbeatInterval`, and `streamAborted` state variables inside the `if (stream)` block, before the `try` at line 1288 in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:1283)
- [ ] Define `cleanupStream()` function that clears `heartbeatInterval` and sets it to `null` — idempotent, safe to call multiple times
- [ ] Set up heartbeat `setInterval` with stall detection logic: check `Date.now() - lastChunkTimestamp > MAX_STREAM_STALL_MS` for stall, write `: keep-alive\n\n` SSE comment when `streamStarted === true` and not stalled
- [ ] Implement pre-stream stall path: when `streamStarted === false` on stall detection, throw `Object.assign(new Error(...), { status: 504 })` to fall through to outer retry loop
- [ ] Implement mid-stream stall path: when `streamStarted === true` on stall detection, write `stream_timeout` error frame (Responses API: `response.failed` event via `writeResponseStreamEvent`; Chat Completion: `data: {"error":...}\n\n` + `data: [DONE]\n\n`), then `res.end()`
- [ ] Attach `req.on('close', ...)` listener that calls `cleanupStream()` for client-disconnect cleanup
- [ ] Add `lastChunkTimestamp = Date.now()` update and `if (streamAborted) break` check inside the `for await (const chunk of gen)` loop body in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:1294)
- [ ] Add `cleanupStream()` call and `if (streamAborted) { logRequest(...); return; }` check after the `for await` loop completes, before the existing success-path code
- [ ] Add `cleanupStream()` call at the top of the `catch (streamErr)` block in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:1392)
- [ ] Add unit test: heartbeat SSE comments are emitted during idle periods (mock provider with delayed TTFB > 15s, verify `: keep-alive\n\n` appears in response)
- [ ] Add unit test: stall detection terminates stream after 45s of silence (mock provider that yields chunks then stalls indefinitely, verify `stream_timeout` error frame and `res.end()`)
- [ ] Add unit test: pre-stream stall throws 504 for retry (mock provider with TTFB > 45s, verify fallback to another provider)
- [ ] Add unit test: client-disconnect clears heartbeat interval (abort client fetch mid-stream, verify no leaked timers)
- [ ] Add unit test: heartbeat write failure triggers cleanup (mock `res.write` to throw EPIPE, verify `cleanupStream()` is called)
- [ ] Run existing test suite to verify no regressions: `pnpm --filter server test`