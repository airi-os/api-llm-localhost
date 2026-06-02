# Tasks: Wrapped Error Payloads on HTTP 200 Responses

## Implementation Steps

- [x] 1. Add `isWrappedError()` method to `BaseProvider` in `server/src/providers/base.ts`
  - Add a `protected isWrappedError(body: unknown): boolean` method
  - Checks: `body !== null`, `typeof body === 'object'`, `!Array.isArray(body)`, `'error' in body`, `body.error !== null`, `typeof body.error === 'string' || typeof body.error === 'object'`
  - Cast `body` to `Record<string, unknown>` for property access

- [x] 2. Add `throwWrappedError()` method to `BaseProvider` in `server/src/providers/base.ts`
  - Add a `protected throwWrappedError(body: unknown): void` method
  - Extract `errPayload` from `body.error`
  - Use `this.extractErrorMessage(body, 'Unknown wrapped error')` for the message
  - Construct `ProviderApiError` with message format: `${this.name} API error (wrapped in 200): ${message}`
  - Set `error.status`: if `errPayload` is an object with a `code` key, use `Number(errPayload.code)`; otherwise default to 200
  - Set `error.provider = this.name`
  - Set `error.responseBody = body`
  - Throw the error

- [x] 3. Change `extractErrorMessage()` visibility from `private` to `protected` in `server/src/providers/base.ts`
  - Change line 112: `private extractErrorMessage(...)` → `protected extractErrorMessage(...)`
  - This allows `throwWrappedError()` to call it

- [x] 4. Add wrapped-error check in `OpenAICompatProvider.chatCompletion()` in `server/src/providers/openai-compat.ts`
  - After line 70 (`const data = await res.json() as ChatCompletionResponse;`), before line 71 (`normalizeChoices(data);`):
  - Insert: `if (this.isWrappedError(data)) { this.throwWrappedError(data); }`

- [x] 5. Add wrapped-error check in `OpenAICompatProvider.streamChatCompletion()` in `server/src/providers/openai-compat.ts`
  - Inside the `try` block at line 126, after `JSON.parse(data)` succeeds:
  - Insert: `if (this.isWrappedError(parsed)) { this.throwWrappedError(parsed); }`
  - Note: assign the result of `JSON.parse` to a variable first, then check, then yield

- [x] 6. Add wrapped-error check in `CohereProvider.chatCompletion()` in `server/src/providers/cohere.ts`
  - After line 49 (`const data = await res.json() as ChatCompletionResponse;`), before line 50 (`data._routed_via = ...`):
  - Insert: `if (this.isWrappedError(data)) { this.throwWrappedError(data); }`

- [x] 7. Add wrapped-error check in `CohereProvider.streamChatCompletion()` in `server/src/providers/cohere.ts`
  - Inside the `try` block at line 110, after `JSON.parse(data)` succeeds:
  - Insert: `if (this.isWrappedError(parsed)) { this.throwWrappedError(parsed); }`
  - Note: assign the result of `JSON.parse` to a variable first, then check, then yield

- [x] 8. Add wrapped-error check in `CloudflareProvider.chatCompletion()` in `server/src/providers/cloudflare.ts`
  - After line 62 (`const data = await res.json() as ChatCompletionResponse;`), before line 63 (`data._routed_via = ...`):
  - Insert: `if (this.isWrappedError(data)) { this.throwWrappedError(data); }`

- [x] 9. Add wrapped-error check in `CloudflareProvider.streamChatCompletion()` in `server/src/providers/cloudflare.ts`
  - Inside the `try` block at line 119, after `JSON.parse(data)` succeeds:
  - Insert: `if (this.isWrappedError(parsed)) { this.throwWrappedError(parsed); }`
  - Note: assign the result of `JSON.parse` to a variable first, then check, then yield

- [x] 10. Add wrapped-error check in `GoogleProvider.chatCompletion()` in `server/src/providers/google.ts`
  - After line 246 (`const data = await res.json() as GeminiResponse;`), before line 247 (`const candidate = data.candidates?.[0];`):
  - Insert: `if (this.isWrappedError(data)) { this.throwWrappedError(data); }`

- [x] 11. Add wrapped-error check in `GoogleProvider.streamChatCompletion()` in `server/src/providers/google.ts`
  - After line 354 (`chunk = JSON.parse(raw) as GeminiResponse;`), before line 358 (`const candidate = chunk.candidates?.[0];`):
  - Insert: `if (this.isWrappedError(chunk)) { this.throwWrappedError(chunk); }`

- [x] 12. TypeScript compilation check
  - Run `npx tsc --noEmit` in the `server/` directory
  - Ensure no type errors from the new methods or visibility changes

- [x] 13. Run all tests
  - Run `npm test` in the `server/` directory
  - Verify no regressions in existing provider or proxy tests