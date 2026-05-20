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

  protected async fetchWithTimeout(
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

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
