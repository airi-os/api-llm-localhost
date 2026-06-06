import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freellmapi/shared/types.js';

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ProviderApiError extends Error {
  status?: number;
  provider?: string;
  responseBody?: unknown;
}

// Recursively removes `additionalProperties` from a JSON Schema object.
// Cohere and Google do not support this field in tool parameter schemas.
export function stripAdditionalProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const { additionalProperties: _, ...rest } = schema;

  if (rest.properties && typeof rest.properties === 'object' && !Array.isArray(rest.properties)) {
    rest.properties = Object.fromEntries(
      Object.entries(rest.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        v && typeof v === 'object' && !Array.isArray(v)
          ? stripAdditionalProperties(v as Record<string, unknown>)
          : v,
      ])
    );
  }

  if (rest.items && typeof rest.items === 'object' && !Array.isArray(rest.items)) {
    rest.items = stripAdditionalProperties(rest.items as Record<string, unknown>);
  }

  return rest;
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk>;

  abstract validateKey(apiKey: string): Promise<boolean>;

  protected static async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 15000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  protected async createApiError(res: Response): Promise<ProviderApiError> {
    const body = await BaseProvider.readErrorBody(res);
    const message = BaseProvider.extractErrorMessage(body, res.statusText);
    const error = new Error(`${this.name} API error ${res.status}: ${message}`) as ProviderApiError;
    error.status = res.status;
    error.provider = this.name;
    error.responseBody = body;
    return error;
  }

  private static async readErrorBody(res: Response): Promise<unknown> {
    if (typeof res.text === 'function') {
      const text = await res.text().catch(() => '');
      if (!text) return null;

      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text.slice(0, 1000);
      }
    }

    if (typeof res.json === 'function') {
      return await res.json().catch(() => null) as unknown;
    }

    return null;
  }

  protected static extractErrorMessage(body: unknown, fallback: string): string {
    if (typeof body === 'string') return body || fallback;
    if (!body || typeof body !== 'object') return fallback;

    const err = body as { error?: { message?: string }; errors?: Array<{ message?: string }>; message?: string };
    return err.error?.message ?? err.errors?.[0]?.message ?? err.message ?? fallback;
  }

  protected static makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Detect a root-level `error` field in a parsed JSON body — used to catch
   *  upstream providers that return error payloads with HTTP 200 status. */
  protected isWrappedError(body: unknown): boolean {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
    const obj = body as Record<string, unknown>;
    if (!('error' in obj) || obj.error === null) return false;
    return typeof obj.error === 'string' || typeof obj.error === 'object';
  }

  /** Throw a ProviderApiError from a detected wrapped error payload.
   *  Called after isWrappedError() returns true. */
  protected throwWrappedError(body: unknown): void {
    const obj = body as Record<string, unknown>;
    const errPayload = obj.error;
    const message = BaseProvider.extractErrorMessage(body, 'Unknown wrapped error');
    const error = new Error(
      `${this.name} API error (wrapped in 200): ${message}`,
    ) as ProviderApiError;
    const rawCode = (errPayload as Record<string, unknown>).code;
    const parsedCode = typeof rawCode === 'number' ? rawCode : Number(rawCode);
    error.status =
      typeof errPayload === 'object' && errPayload !== null && 'code' in (errPayload as Record<string, unknown>)
        ? (Number.isFinite(parsedCode) ? parsedCode : 200)
        : 200;
    error.provider = this.name;
    error.responseBody = body;
    throw error;
  }
}
