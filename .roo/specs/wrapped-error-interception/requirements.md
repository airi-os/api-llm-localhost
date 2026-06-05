# Requirements: Wrapped Error Payloads on HTTP 200 Responses

## Overview

This spec addresses a critical edge case where upstream LLM providers return error payloads (JSON containing a root-level `error` field) accompanied by an HTTP `200 OK` status code. Currently, the proxy assumes any HTTP `200` response contains a valid completion payload, leading to uncaught `TypeError` crashes further down the execution pipeline — for example, when `normalizeChoices()` tries to iterate `data.choices` on an error object that has no `choices` property, or when the response is passed to clients expecting a `ChatCompletionResponse` shape.

The fix adds a detection layer that inspects parsed JSON bodies for root-level `error` objects before attempting normalization or streaming, and throws a properly typed `ProviderApiError` that the existing retry loop in `handleChatCompletion()` can catch and handle gracefully.

## Context

The provider layer lives in `server/src/providers/`. There are four provider implementations:

| File | Class | Protocol |
|---|---|---|
| `openai-compat.ts` | `OpenAICompatProvider` | OpenAI-compatible JSON + SSE |
| `cohere.ts` | `CohereProvider` | OpenAI-compat JSON + SSE via Cohere endpoint |
| `cloudflare.ts` | `CloudflareProvider` | OpenAI-compat JSON + SSE via Cloudflare Workers AI |
| `google.ts` | `GoogleProvider` | Gemini-specific JSON + SSE |

All four share the same pattern: after `res.ok` is confirmed, they parse the JSON body and immediately use it as a `ChatCompletionResponse` (or `GeminiResponse`). No validation occurs between parsing and usage. The `BaseProvider` class in `base.ts` already has `createApiError()` for non-200 responses, but nothing inspects the body content on 200 responses.

The retry loop in `handleChatCompletion()` (in `proxy.ts`) catches `ProviderApiError` objects and applies cooldown, skip-model, and fallback logic. If a `TypeError` crashes instead, the retry loop sees a non-retryable error and returns 502 to the client — no fallback occurs.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | All provider adapters utilizing JSON-based responses must inspect the parsed JSON body for root-level error indicators, regardless of whether the HTTP status code indicates success (200 OK). | Must |
| FR-2 | If a root-level `error` object is found in an HTTP 200 response, the provider must throw a `ProviderApiError` matching the existing schema (with `status`, `provider`, `responseBody` fields), allowing the proxy retry loop to catch and handle it gracefully. | Must |
| FR-3 | The check must specifically inspect structured JSON keys at the root level (a root-level `error` key). It must NOT flag valid assistant outputs that happen to contain the word "error" in their text content. | Must |
| FR-4 | The `error` field value can be either a string or an object. Both forms must be detected and handled. When the value is an object with a `message` key, that message must be used in the thrown error. When the value is a string, the string itself must be used. | Must |
| FR-5 | When the `error` object contains a `code` key with a numeric value, that value must be used as the `status` field on the `ProviderApiError`. When no `code` is present, the status must default to 200 (reflecting the actual HTTP status). | Must |
| FR-6 | In streaming mode, if the first SSE chunk contains a root-level `error` field instead of a valid completion chunk, the stream must be aborted and a `ProviderApiError` must be thrown. | Must |
| FR-7 | The detection helper must be added to `BaseProvider` so all provider subclasses can reuse it without duplicating logic. | Must |
| FR-8 | Google/Gemini responses use a different error format (`error` at root level with `code`, `message`, `status` fields). The same root-level `error` check must apply to Google responses as well. | Must |

## Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1 | No changes to the router (`router.ts`). The existing `skipModels` and cooldown mechanisms handle routing around failed providers. |
| NFR-2 | No changes to the database schema. All error detection is runtime-only. |
| NFR-3 | Backward compatible: valid responses without an `error` field pass through unchanged. The detection is purely additive. |
| NFR-4 | Minimal performance impact: the check is a simple property lookup on a already-parsed JSON object — no regex, no deep traversal. |
| NFR-5 | The `ProviderApiError` thrown must be catchable by the existing `isRetryableError()` and `isRateLimitError()` helpers in `proxy.ts`, so wrapped 429-style errors trigger cooldown logic. |

## Out of Scope

- Detecting non-standard error key names (e.g., `err`, `errors` array) — only the standard OpenAI `error` key is targeted
- Persistent error logging or analytics for wrapped errors
- Client-side UI changes
- Changes to the retry loop logic in `proxy.ts` (the existing loop already handles `ProviderApiError` correctly)
- Modifying the `validateKey()` methods (they already handle non-200 responses)