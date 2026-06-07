import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage, ChatToolCall, ChatToolDefinition } from '@freellmapi/shared/types.js';
import { routeRequest, recordSuccess, type RouteResult, type RoutingMode } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, isOnCooldown } from '../services/ratelimit.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { allocateIpForKey, releaseIpForKey, hasIpCapacity } from '../services/ipPoolCapacity.js';
import { extractBearerToken, timingSafeStringEqual } from '../lib/secrets.js';
import { getProtectionLevel, evaluateThreadProtection } from '../services/threadProtection.js';
import '../services/logBuffer.js';

export const proxyRouter: Router = Router();

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId?: number; keyId?: number; bannedPlatforms?: Set<string>; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL
const PROVIDER_BAN_STICKY_COOLDOWN_MS = 3 * 60 * 1000; // 3 min cooldown for provider-ban platform sticky sessions
const responseSessionMap = new Map<string, { messages: ChatMessage[]; lastUsed: number }>();

// Tracks which sessions are currently making requests or streaming
// Uses Set to allow concurrent requests from the same session without overwriting
const activeRequests = new Set<{ sessionKey: string; platform: string; modelId: string; startTime: number }>();
const responseItemMap = new Map<string, ChatMessage>();
const RESPONSE_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_RESPONSE_SESSIONS = 500;
const MAX_MODEL_RESPONSE_LOG_CHARS = 6000;

// Stream keepalive / stall detection configuration
export const streamKeepaliveConfig = {
  KEEPALIVE_INTERVAL_MS: 15000,
  MAX_STREAM_STALL_MS: 60000,
};

// Transient model cooldowns: modelDbId → expiry timestamp
// Used to temporarily skip models that returned 5xx errors
export const transientModelCooldowns = new Map<number, number>();
export const TRANSIENT_COOLDOWN_MS = 15_000;

function getSessionKey(messages: ChatMessage[], routingMode: RoutingMode): string {
  // Use the first user message as session identifier — clients like Hermes
  // re-send the full conversation each turn, so the first user message is
  // stable across turns. Hash the FULL message (not a 100-char slice) so
  // distinct conversations with identical openings don't collide.
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser || typeof firstUser.content !== 'string') return '';
  return crypto.createHash('sha1').update(`${routingMode}:${firstUser.content}`).digest('hex');
}

function getStickyModel(messages: ChatMessage[], routingMode: RoutingMode): number | undefined {
  const key = getSessionKey(messages, routingMode);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) {
    return undefined;
  }

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }

  return entry.modelDbId;
}

function getStickyKey(messages: ChatMessage[], routingMode: RoutingMode): number | undefined {
  const key = getSessionKey(messages, routingMode);
  if (!key) {
    return undefined;
  }

  const entry = stickySessionMap.get(key);
  if (!entry) {
    return undefined;
  }

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }

  // Check if the sticky model's platform is banned
  if (entry.bannedPlatforms) {
    const db = getDb();
    const modelRow = db.prepare('SELECT platform FROM models WHERE id = ?').get(entry.modelDbId) as { platform: string } | undefined;
    if (modelRow && entry.bannedPlatforms.has(modelRow.platform)) {
      return undefined;
    }
  }

  if (entry.keyId !== undefined) {
  } else {
  }
  return entry.keyId;
}

function isSessionBannedFromPlatform(
  messages: ChatMessage[],
  routingMode: RoutingMode,
  platform: string,
): boolean {
  const key = getSessionKey(messages, routingMode);
  if (!key) return false;
  const entry = stickySessionMap.get(key);
  if (!entry) return false;
  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return false;
  }
  return entry.bannedPlatforms?.has(platform) ?? false;
}

function banPlatformFromSession(
  messages: ChatMessage[],
  routingMode: RoutingMode,
  platform: string,
  modelDbId?: number,
): void {
  const key = getSessionKey(messages, routingMode);
  if (!key) return;
  let entry = stickySessionMap.get(key);
  if (!entry) {
    if (modelDbId === undefined) return;
    entry = { modelDbId, bannedPlatforms: new Set(), lastUsed: Date.now() };
  }
  if (!entry.bannedPlatforms) entry.bannedPlatforms = new Set();
  entry.bannedPlatforms.add(platform);
  entry.lastUsed = Date.now();
  stickySessionMap.set(key, entry);
}

function addProviderModelsToSkipModels(skipModels: Set<number>, provider: string): void {
  const db = getDb();
  // Use the same filtered set that routeRequest() uses: models in the fallback chain
  // (fallback_config.enabled = 1 AND models.enabled = 1), not all enabled models.
  const providerModels = db.prepare(
    'SELECT m.id FROM fallback_config fc JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1 WHERE fc.enabled = 1 AND m.platform = ?'
  ).all(provider) as Array<{ id: number }>;
  for (const model of providerModels) {
    skipModels.add(model.id);
  }
}

function resetAllConsecutiveFailures(
  messages: ChatMessage[],
  routingMode: RoutingMode,
): void {
  // No longer tracking consecutive failures; function retained for compatibility.
}

function isTruncatedResponse(errOrContent: unknown): boolean {
  if (!errOrContent) return false;
  const text = typeof errOrContent === 'string' ? errOrContent
    : errOrContent instanceof Error ? errOrContent.message
    : typeof errOrContent === 'object' ? (() => { try { return JSON.stringify(errOrContent); } catch { return null; } })()
    : null;
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('truncated') || lower.includes('truncation') ||
    lower.includes('context_length_exceeded') || lower.includes('token_limit') ||
    lower.includes('maximum length') || lower.includes('response_length_limit') ||
    lower.includes('cut off') || lower.includes('truncate')
}

// Exported for testing purposes only
export {
  isSessionBannedFromPlatform,
  banPlatformFromSession,
  addProviderModelsToSkipModels,
  resetAllConsecutiveFailures,
  isTruncatedResponse,
  getSessionKey,
  getStickyModel,
  getStickyKey,
  setStickyModel,
  clearStickyModel,
  stickySessionMap,
};

function clearStickyModel(messages: ChatMessage[], routingMode: RoutingMode) {
  const key = getSessionKey(messages, routingMode);
  if (!key) return;
  if (!stickySessionMap.has(key)) return;
  
  const existing = stickySessionMap.get(key);
  if (existing) {
    // Preserve ban history while clearing the model/key assignment
    const { bannedPlatforms } = existing;
    stickySessionMap.set(key, {
      bannedPlatforms,
      lastUsed: Date.now()
    });
  }
}

function clearStickyKey(messages: ChatMessage[], routingMode: RoutingMode) {
  const key = getSessionKey(messages, routingMode);
  if (!key) return;
  const entry = stickySessionMap.get(key);
  if (!entry) return;
  const clearedKeyId = entry.keyId;
  entry.keyId = undefined;
  stickySessionMap.set(key, entry);
}

function setStickyModel(messages: ChatMessage[], modelDbId: number, routingMode: RoutingMode, keyId?: number) {
  const key = getSessionKey(messages, routingMode);
  if (!key) return;

  // Preserve bannedPlatforms from existing entry
  const existing = stickySessionMap.get(key);
  const bannedPlatforms = existing?.bannedPlatforms;

  stickySessionMap.set(key, { modelDbId, keyId, bannedPlatforms, lastUsed: Date.now() });

  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

const AUTO_MODEL_ID = 'freellmapi/auto';
const AUTO_SMART_MODEL_ID = 'freellmapi/auto-smart';

proxyRouter.use((req, res, next) => {
  const token = extractBearerToken(req.headers.authorization);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  // Store the validated API key on the request for use in handlers
  (req as Request & { apiKey: string }).apiKey = token;
  next();
});

// OpenAI-compatible /models endpoint (used by Hermes for metadata)
proxyRouter.get('/models', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare('SELECT platform, model_id, display_name, context_window FROM models WHERE enabled = 1 ORDER BY intelligence_rank').all() as {
    platform: string;
    model_id: string;
    display_name: string;
    context_window: number;
  }[];
  res.json({
    object: 'list',
    data: [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Auto (Balanced Router)',
        context_window: 128000,
      },
      {
        id: AUTO_SMART_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Auto Smart (Intelligence Router)',
        context_window: 128000,
      },
      ...models.map(m => ({
        id: m.model_id,
        object: 'model',
        created: 0,
        owned_by: m.platform,
        name: m.display_name,
        context_window: m.context_window,
      })),
    ],
  });
});

// OpenAI-compatible GET /models/:id endpoint
proxyRouter.get(/^\/models\/(.+)$/, (req: Request, res: Response) => {
  const id: string = req.params[0];
  if (id === AUTO_MODEL_ID || id === AUTO_SMART_MODEL_ID) {
    res.json({ id, object: 'model', created: 0, owned_by: 'freellmapi' });
    return;
  }
  const db = getDb();
  const model = db.prepare('SELECT platform, model_id, display_name, context_window FROM models WHERE model_id = ? AND enabled = 1').get(id) as { platform: string; model_id: string; display_name: string; context_window: number; } | undefined;
  if (!model) {
    res.status(404).json({ error: { message: `Model '${id}' not found`, type: 'invalid_request_error' } });
    return;
  }
  res.json({ id: model.model_id, object: 'model', created: 0, owned_by: model.platform, name: model.display_name, context_window: model.context_window });
});

const _parsedRetries = parseInt(process.env.MAX_FALLBACK_RETRIES ?? '5', 10);
const MAX_RETRIES = Number.isFinite(_parsedRetries) && _parsedRetries > 0 ? _parsedRetries : 5;

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
  thought_signature: z.string().optional(),
});

const chatContentPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
});

const chatContentSchema = z.union([z.string(), z.array(chatContentPartSchema)]);

function flattenContent(content: string | Array<{ type?: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content.map(p => p.text ?? '').join('');
}

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: chatContentSchema,
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: chatContentSchema,
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.string(),
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
});

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const responseFunctionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
});

const responseContentPartSchema = z.object({
  type: z.enum(['input_text', 'output_text', 'text']).optional(),
  text: z.string().optional(),
});

const responseInputMessageSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.union([
    z.string(),
    z.array(responseContentPartSchema),
  ]),
});

const responseItemReferenceSchema = z.object({
  type: z.literal('item_reference'),
  id: z.string().min(1),
});

const responseFunctionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1),
  output: z.unknown(),
});

const responseFunctionCallSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

const responseInputSchema = z.union([
  z.string(),
  z.array(z.union([
    responseInputMessageSchema,
    responseItemReferenceSchema,
    responseFunctionCallSchema,
    responseFunctionCallOutputSchema,
    z.string(),
  ])),
]);

const responseCreateSchema = z.object({
  model: z.string().optional(),
  input: responseInputSchema.optional(),
  instructions: z.string().optional(),
  previous_response_id: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.union([toolDefinitionSchema, responseFunctionToolSchema])).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
});

type ChatResponseFormatter = (result: ChatCompletionResponse, messages: ChatMessage[]) => unknown;
type ResponseTool = z.infer<typeof responseCreateSchema>['tools'] extends Array<infer T> | undefined ? T : never;
type ResponseInputItem = Exclude<z.infer<typeof responseInputSchema>, string>[number];

function stringifyModelResponseForLog(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return '';
    return serialized.length > MAX_MODEL_RESPONSE_LOG_CHARS
      ? `${serialized.slice(0, MAX_MODEL_RESPONSE_LOG_CHARS)}...`
      : serialized;
  } catch {
    return '[unserializable response]';
  }
}

function logFinalModelResponse(route: RouteResult, response: unknown, ttfbMs: number | null): void {
  const ttfbStr = ttfbMs !== null ? ` | ttfb=${ttfbMs}ms` : '';
  if (process.env.LOG_SENSITIVE_DATA !== 'true') {
    return;
  }
}

interface ResponsesStreamContext {
  responseId: string;
  messageId: string;
  createdAt: number;
  messages: ChatMessage[];
  outputText: string;
  textStarted: boolean;
  messageOutputIndex: number | null;
  toolCalls: Map<number, ResponseStreamToolCall>;
  nextOutputIndex: number;
}

interface ResponseStreamToolCall {
  id: string;
  itemId: string;
  outputIndex: number;
  name: string;
  arguments: string;
}

function isChatToolDefinition(tool: ResponseTool): tool is ChatToolDefinition {
  return 'function' in tool;
}

function getErrorStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const statusValue = e.status ?? (e.response as Record<string, unknown> | undefined)?.status;
    return typeof statusValue === 'number' ? statusValue : undefined;
  }
  return undefined;
}

function isBanEligibleStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

function getErrorMessage(err: unknown): string {
  if (typeof err === 'string') {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      return obj.message;
    }
    const errorProp = obj.error;
    if (typeof errorProp === 'object' && errorProp !== null) {
      const errorObj = errorProp as Record<string, unknown>;
      if (typeof errorObj.message === 'string') {
        return errorObj.message;
      }
    }
  }
  return String(err);
}

function isRateLimitError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === 429) return true;

  const msg = getErrorMessage(err).toLowerCase();
  return msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted');
}

function isAuthError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === 401 || status === 403) return true;

  const msg = getErrorMessage(err).toLowerCase();
  return msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('invalid api key');
}

function isRetryableError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === 401 || status === 403) return true;
  if (status === 413 || status === 429 || status === 400 || status === 404 || status === 408 || status === 409
    || status === 422 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  const msg = getErrorMessage(err).toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    // 404 from a provider means the model no longer exists/is accessible — fall back
    || msg.includes('404') || msg.includes('no longer available') || msg.includes('model not found')
    // 400 from a provider means provider-specific incompatibility (e.g. unsupported schema fields) — fall back
    || msg.includes('400') || msg.includes('bad request') || msg.includes('invalid json payload');
}

function isRetryableStreamError(streamErr: unknown): boolean {
  if (typeof streamErr !== 'object' || streamErr === null) return false;
  const status = getErrorStatus(streamErr);
  if (status === 429 || status === 401 || status === 403 || status === 408) return true;

  const msg = getErrorMessage(streamErr).toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('unauthorized') || msg.includes('forbidden')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnreset') || msg.includes('econnrefused')
    || msg.includes('socket hang up') || msg.includes('network error')
    || msg.includes('econnaborted') || msg.includes('connreset');
}

function shouldSkipModelOnRetry(err: unknown): boolean {
  return !isRateLimitError(err) && !isAuthError(err);
}

function summarizeProviderError(err: unknown): string {
  const status = getErrorStatus(err);
  const message = getErrorMessage(err).replace(/\s+/g, ' ').trim();
  return `${status ? `${status} ` : ''}${message}`.slice(0, 240);
}

function isResponseFunctionCallOutput(item: ResponseInputItem): item is z.infer<typeof responseFunctionCallOutputSchema> {
  return typeof item === 'object' && item !== null && 'type' in item && item.type === 'function_call_output';
}

function isResponseFunctionCall(item: ResponseInputItem): item is z.infer<typeof responseFunctionCallSchema> {
  return typeof item === 'object' && item !== null && 'type' in item && item.type === 'function_call';
}

function extractResponseText(content: z.infer<typeof responseInputMessageSchema>['content']): string {
  if (typeof content === 'string') return content;
  return content.map(part => part.text ?? '').join('');
}

function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return [message];

    const hasContent = typeof message.content === 'string' && message.content.length > 0;
    const hasToolCalls = (message.tool_calls?.length ?? 0) > 0;
    if (!hasContent && !hasToolCalls) return [];

    return [message];
  });
}

function isEmptyAssistantResponse(result: ChatCompletionResponse): boolean {
  const choice = result.choices[0];
  if (!choice) return true;

  const hasToolCalls = (choice.message.tool_calls?.length ?? 0) > 0;
  if (hasToolCalls) return false;

  return typeof choice.message.content !== 'string' || choice.message.content.trim().length === 0;
}

function normalizeResponseTools(tools: z.infer<typeof responseCreateSchema>['tools']): ChatToolDefinition[] | undefined {
  if (!tools) return undefined;

  return tools.map((tool): ChatToolDefinition => {
    if (isChatToolDefinition(tool)) return tool;

    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters ? { parameters: tool.parameters } : {}),
        ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
      },
    };
  });
}

function getPreviousResponseMessages(previousResponseId: string | undefined): ChatMessage[] {
  if (!previousResponseId) {
    return [];
  }
  const session = responseSessionMap.get(previousResponseId);
  if (!session) {
    return [];
  }
  const ageMs = Date.now() - session.lastUsed;
  if (ageMs > RESPONSE_SESSION_TTL_MS) {
    responseSessionMap.delete(previousResponseId);
    return [];
  }
  session.lastUsed = Date.now();
  return session.messages.map(message => ({ ...message }));
}

function saveResponseSession(responseId: string, itemId: string, messages: ChatMessage[], outputText: string, toolCalls?: ChatToolCall[]): void {
  const hasContent = outputText.length > 0;
  const hasToolCalls = (toolCalls?.length ?? 0) > 0;
  const assistantMessage = (hasContent || hasToolCalls)
    ? ({
        role: 'assistant',
        content: hasContent ? outputText : null,
        ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
      } satisfies ChatMessage)
    : undefined;
  const stored = assistantMessage
    ? [...messages.map(message => ({ ...message })), assistantMessage]
    : [...messages.map(message => ({ ...message }))];
  responseSessionMap.set(responseId, {
    messages: stored,
    lastUsed: Date.now(),
  });
  if (assistantMessage) responseItemMap.set(itemId, assistantMessage);

  if (responseSessionMap.size <= MAX_RESPONSE_SESSIONS) return;

  const now = Date.now();
  for (const [id, session] of responseSessionMap) {
    if (now - session.lastUsed > RESPONSE_SESSION_TTL_MS) {
      responseSessionMap.delete(id);
    }
  }
}

function toChatMessages(
  input: z.infer<typeof responseInputSchema> | undefined,
  instructions?: string,
  previousResponseId?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  messages.push(...getPreviousResponseMessages(previousResponseId));

  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  for (const item of input ?? []) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }

    if ('type' in item && item.type === 'item_reference' && typeof item.id === 'string') {
      const referencedMessage = responseItemMap.get(item.id);
      if (referencedMessage) messages.push({ ...referencedMessage });
      continue;
    }

    if (isResponseFunctionCall(item)) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments,
          },
        }],
      });
      continue;
    }

    if (isResponseFunctionCallOutput(item)) {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : (JSON.stringify(item.output) ?? ''),
      });
      continue;
    }

    if (!('role' in item)) continue;

    const role = item.role === 'developer' ? 'system' : item.role;
    messages.push({ role, content: extractResponseText(item.content) });
  }

  return messages;
}

function formatResponseApiResult(result: ChatCompletionResponse, messages: ChatMessage[]): unknown {
  const outputText = result.choices[0]?.message.content ?? '';
  const toolCalls = result.choices[0]?.message.tool_calls ?? [];
  const createdAt = result.created ?? Math.floor(Date.now() / 1000);
  const messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
  const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;

  saveResponseSession(responseId, messageId, messages, outputText, toolCalls);
  const output = [
    {
      id: messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: outputText,
        annotations: [],
      }],
    },
    ...toolCalls.map(toolCall => ({
      id: `fc_${crypto.randomUUID().replaceAll('-', '')}`,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    })),
  ];

  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: result.model,
    output,
    output_text: outputText,
    usage: {
      input_tokens: result.usage?.prompt_tokens ?? 0,
      output_tokens: result.usage?.completion_tokens ?? 0,
      total_tokens: result.usage?.total_tokens ?? 0,
    },
  };
}

function createResponsesStreamContext(messages: ChatMessage[]): ResponsesStreamContext {
  return {
    responseId: `resp_${crypto.randomUUID().replaceAll('-', '')}`,
    messageId: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: Math.floor(Date.now() / 1000),
    messages,
    outputText: '',
    textStarted: false,
    messageOutputIndex: null,
    toolCalls: new Map(),
    nextOutputIndex: 0,
  };
}

function writeResponseStreamEvent(res: Response, event: Record<string, unknown> & { type: string }): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeResponseStreamStart(res: Response, context: ResponsesStreamContext, model: string): void {
  writeResponseStreamEvent(res, {
    type: 'response.created',
    response: {
      id: context.responseId,
      object: 'response',
      created_at: context.createdAt,
      status: 'in_progress',
      model,
      output: [],
      output_text: '',
    },
  });
}

function ensureResponseTextItem(res: Response, context: ResponsesStreamContext): void {
  if (context.textStarted) return;

  context.textStarted = true;
  context.messageOutputIndex = context.nextOutputIndex++;
  writeResponseStreamEvent(res, {
    type: 'response.output_item.added',
    response_id: context.responseId,
    output_index: context.messageOutputIndex,
    item: {
      id: context.messageId,
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    },
  });
  writeResponseStreamEvent(res, {
    type: 'response.content_part.added',
    response_id: context.responseId,
    item_id: context.messageId,
    output_index: context.messageOutputIndex,
    content_index: 0,
    part: {
      type: 'output_text',
      text: '',
      annotations: [],
    },
  });
}

function writeResponseStreamChunk(res: Response, context: ResponsesStreamContext, chunk: ChatCompletionChunk): number {
  const text = chunk.choices[0]?.delta?.content ?? '';
  const toolCalls = chunk.choices[0]?.delta?.tool_calls ?? [];

  let outputTokens = 0;
  if (text) {
    ensureResponseTextItem(res, context);
    context.outputText += text;
    outputTokens += Math.ceil(text.length / 4);
    writeResponseStreamEvent(res, {
      type: 'response.output_text.delta',
      response_id: context.responseId,
      item_id: context.messageId,
      output_index: context.messageOutputIndex ?? 0,
      content_index: 0,
      delta: text,
    });
  }

  for (const rawToolCall of toolCalls) {
    const toolCall = rawToolCall as ChatToolCall & { index?: number };
    const index = toolCall.index ?? 0;
    let existing = context.toolCalls.get(index);

    if (!existing) {
      existing = {
        id: toolCall.id || `call_${crypto.randomUUID().replaceAll('-', '')}`,
        itemId: `fc_${crypto.randomUUID().replaceAll('-', '')}`,
        outputIndex: context.nextOutputIndex++,
        name: toolCall.function?.name ?? '',
        arguments: '',
      };
      context.toolCalls.set(index, existing);
      writeResponseStreamEvent(res, {
        type: 'response.output_item.added',
        response_id: context.responseId,
        output_index: existing.outputIndex,
        item: {
          id: existing.itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: existing.id,
          name: existing.name,
          arguments: '',
        },
      });
    }

    if (toolCall.id) existing.id = toolCall.id;
    if (toolCall.function?.name) existing.name = toolCall.function.name;

    const argumentDelta = toolCall.function?.arguments ?? '';
    if (!argumentDelta) continue;

    existing.arguments += argumentDelta;
    writeResponseStreamEvent(res, {
      type: 'response.function_call_arguments.delta',
      response_id: context.responseId,
      item_id: existing.itemId,
      output_index: existing.outputIndex,
      call_id: existing.id,
      delta: argumentDelta,
    });
  }

  return outputTokens;
}

function writeResponseStreamEnd(res: Response, context: ResponsesStreamContext, model: string, inputTokens: number, outputTokens: number): void {
  const finalToolCalls = Array.from(context.toolCalls.values());
  const chatToolCalls: ChatToolCall[] = finalToolCalls.map(toolCall => ({
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  }));

  saveResponseSession(context.responseId, context.messageId, context.messages, context.outputText, chatToolCalls);
  const messageOutput = context.textStarted
    ? [{
      id: context.messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: context.outputText,
        annotations: [],
      }],
    }]
    : [];
  const output = [
    ...messageOutput,
    ...finalToolCalls.map(toolCall => ({
      id: toolCall.itemId,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    })),
  ];
  const finalResponse = {
    id: context.responseId,
    object: 'response',
    created_at: context.createdAt,
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    model,
    output,
    output_text: context.outputText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };

  if (context.textStarted) {
    writeResponseStreamEvent(res, {
      type: 'response.output_text.done',
      response_id: context.responseId,
      item_id: context.messageId,
      output_index: context.messageOutputIndex ?? 0,
      content_index: 0,
      text: context.outputText,
    });
    writeResponseStreamEvent(res, {
      type: 'response.output_item.done',
      response_id: context.responseId,
      output_index: context.messageOutputIndex ?? 0,
      item: messageOutput[0],
    });
  }
  for (const toolCall of finalToolCalls) {
    writeResponseStreamEvent(res, {
      type: 'response.function_call_arguments.done',
      response_id: context.responseId,
      item_id: toolCall.itemId,
      output_index: toolCall.outputIndex,
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    });
    writeResponseStreamEvent(res, {
      type: 'response.output_item.done',
      response_id: context.responseId,
      output_index: toolCall.outputIndex,
      item: {
        id: toolCall.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    });
  }
  writeResponseStreamEvent(res, {
    type: 'response.completed',
    response: finalResponse,
  });
}

proxyRouter.post('/responses', async (req: Request, res: Response) => {
  const parsed = responseCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`;
    res.status(400).json({
      error: {
        message,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const messages = toChatMessages(parsed.data.input, parsed.data.instructions, parsed.data.previous_response_id);
  if (messages.length === 0) {
    res.status(400).json({
      error: {
        message: 'Invalid request: input or instructions is required',
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const responseStreamContext = parsed.data.stream ? createResponsesStreamContext(messages) : undefined;
  const apiKey = (req as Request & { apiKey?: string }).apiKey ?? '';

  await handleChatCompletion(req, res, (result, normalizedMessages) => formatResponseApiResult(result, normalizedMessages), {
    model: parsed.data.model,
    messages,
    temperature: parsed.data.temperature,
    max_tokens: parsed.data.max_output_tokens,
    top_p: parsed.data.top_p,
    stream: parsed.data.stream,
    tools: normalizeResponseTools(parsed.data.tools),
    tool_choice: parsed.data.tool_choice,
    parallel_tool_calls: parsed.data.parallel_tool_calls,
  }, responseStreamContext, apiKey);
});

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const apiKey = (req as Request & { apiKey?: string }).apiKey ?? '';
  await handleChatCompletion(req, res, undefined, undefined, undefined, apiKey);
});

async function handleChatCompletion(
  req: Request,
  res: Response,
  formatResponse?: ChatResponseFormatter,
  body: unknown = req.body,
  responseStreamContext?: ResponsesStreamContext,
  apiKey?: string,
): Promise<void> {
  const start = Date.now();

  // T2.3: Acquire slot before execution using API key
  const requestApiKey = apiKey ?? (req as Request & { apiKey?: string }).apiKey ?? '';
  const allocationResult = allocateIpForKey(requestApiKey);
  const shouldRelease = allocationResult.kind === 'allocated';

  if (allocationResult.kind === 'key_busy') {
    res.status(409).json({
      error: { message: 'An active request already exists for this API key.', type: 'key_busy' },
    });
    return;
  }

  if (allocationResult.kind === 'capacity_exhausted') {
    res.status(503)
      .set('Retry-After', '5')
      .json({
        error: { message: 'No proxy workers available. All slots are occupied.', type: 'capacity_exhausted' },
      });
    return;
  }

  // Validate request
  const parsed = chatCompletionSchema.safeParse(body);
  if (!parsed.success) {
    const message = `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`;
    res.status(400).json({
      error: {
        message,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { model: rawModel, temperature, max_tokens, top_p, stream, tools, tool_choice, parallel_tool_calls } = parsed.data;
  const routingMode: RoutingMode = rawModel === AUTO_SMART_MODEL_ID ? 'smart' : 'balanced';
  const requestedModel = rawModel === AUTO_MODEL_ID || rawModel === AUTO_SMART_MODEL_ID ? undefined : rawModel;
  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
          thought_signature: tc.thought_signature,
        })) } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id,
        ...(m.name ? { name: m.name } : {}),
      };
    }

    return {
      role: m.role,
      content: flattenContent(m.content),
      ...(m.name ? { name: m.name } : {}),
    };
  });
  const normalizedMessages = normalizeChatMessages(messages);

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  const estimatedInputTokens = normalizedMessages.reduce((sum, m) => {
    if (typeof m.content !== 'string') return sum;
    return sum + Math.ceil(m.content.length / 4);
  }, 0);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);

  const lastUserMessage = [...normalizedMessages].reverse().find(m => m.role === 'user');
  const preview = process.env.LOG_SENSITIVE_DATA === 'true' && typeof lastUserMessage?.content === 'string'
    ? lastUserMessage.content.slice(0, 120).replace(/\n/g, ' ')
    : '';

  // Explicit `model` field pins routing. If the catalog has no enabled row
  // matching the requested id, return 400 — silently auto-routing to a
  // different model would be surprising to OpenAI-compatible clients.
  // Sticky-session is the fallback when no `model` field was sent at all.
  let preferredModel: number | undefined;
  if (requestedModel) {
    const db = getDb();
    const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
    if (enabled) {
      preferredModel = enabled.id;
    } else {
      const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
      const reason = disabled ? 'is disabled' : 'is not in the catalog';
      const message = `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`;
      res.status(400).json({
        error: {
          message,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
      return;
    }
  } else {
    preferredModel = getStickyModel(normalizedMessages, routingMode);
  }

  // Sticky key: prefer the same API key within a session for
  // session continuity on the provider side. getStickyKey() already
  // returns undefined when the sticky model's platform is banned.
  let preferredKeyId: number | undefined;
  if (preferredModel !== undefined && !requestedModel) {
    const stickyKeyId = getStickyKey(normalizedMessages, routingMode);
    if (stickyKeyId !== undefined) {
      preferredKeyId = stickyKeyId;
    }
  }

  // Check if session is banned from any platform — add all banned platforms' models to skipModels
  // and clear preferredModel/preferredKeyId if it points to a banned platform.
  const skipModels = new Set<number>();
  const sessionKey = getSessionKey(normalizedMessages, routingMode);
  if (sessionKey) {
    const entry = stickySessionMap.get(sessionKey);
    if (entry) {
      if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
        stickySessionMap.delete(sessionKey);
      } else if (entry.bannedPlatforms) {
        for (const platform of entry.bannedPlatforms) {
          addProviderModelsToSkipModels(skipModels, platform);
        }
      }
    }
  }

  if (preferredModel) {
    const db = getDb();
    const prefRow = db.prepare('SELECT platform FROM models WHERE id = ?').get(preferredModel) as { platform: string } | undefined;
    if (prefRow && isSessionBannedFromPlatform(normalizedMessages, routingMode, prefRow.platform)) {
      preferredModel = undefined;
      preferredKeyId = undefined;
    }
  }

  // Provider-ban platform sticky cooldown: if the session's preferred model is from
  // a provider-ban platform and it was used within the cooldown window, exclude that
  // platform from bandit routing but preserve the sticky preference so the request still
  // routes to the preferred model. Ban check above already clears preferredModel if banned.
  if (preferredModel && sessionKey !== undefined) {
    const db = getDb();
    const prefRow = db.prepare('SELECT platform FROM models WHERE id = ?').get(preferredModel) as { platform: string } | undefined;
    if (prefRow && getProtectionLevel(prefRow.platform) === 'provider-ban') {
      const entry = stickySessionMap.get(sessionKey);
      if (entry && entry.modelDbId === preferredModel && Date.now() - entry.lastUsed <= PROVIDER_BAN_STICKY_COOLDOWN_MS) {
        addProviderModelsToSkipModels(skipModels, prefRow.platform);
      }
    }
  }

  // Clean up stale active requests (older than 10 minutes)
  const ACTIVE_REQUEST_TTL_MS = 10 * 60 * 1000;
  const activeNow = Date.now();
  for (const active of activeRequests) {
    if (activeNow - active.startTime > ACTIVE_REQUEST_TTL_MS) {
      activeRequests.delete(active);
    }
  }

  // Active-Request Safeguard: for provider-ban platforms, exclude from bandit
  // routing if another session is actively using the same platform right now.
  // This prevents concurrent sessions from overwhelming a single provider.
  for (const active of activeRequests) {
    if (active.sessionKey !== sessionKey && getProtectionLevel(active.platform) === 'provider-ban') {
      addProviderModelsToSkipModels(skipModels, active.platform);
    }
  }

  // Inject transient model cooldowns into skipModels
  {
    const cooldownIds = new Set<number>();
    const now = Date.now();
    for (const [id, exp] of transientModelCooldowns) {
      if (now > exp) {
        transientModelCooldowns.delete(id);
      } else {
        skipModels.add(id);
        cooldownIds.add(id);
      }
    }
    if (cooldownIds.size > 0) {
    }
  }

  // Retry loop: skip bad keys and, for non-rate-limit errors, skip the model
  // entirely so the fallback chain can move to a different provider/model.
  const skipKeys = new Set<string>();
  let lastError: unknown = null;

  // IP capacity check: if the global IP pool is at capacity,
  // clear the sticky preference so the bandit can route elsewhere.
  // Pass sessionKey so re-entrant sessions that already hold an IP
  // are not penalised (they won't consume a new slot).
  // Skip this check when the user explicitly requested a model —
  // we should never silently override an explicit model choice.
  if (!requestedModel && preferredModel && !hasIpCapacity(requestApiKey)) {
    preferredModel = undefined;
    preferredKeyId = undefined;
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(
        estimatedTotal,
        skipKeys.size > 0 ? skipKeys : undefined,
        preferredModel,
        routingMode,
        skipModels.size > 0 ? skipModels : undefined,
        preferredKeyId,
      );
    } catch (err: unknown) {
      // No more models available
      if (lastError) {
        const status = isRateLimitError(lastError) ? 429 : 502;
        const type = status === 429 ? 'rate_limit_error' : 'provider_error';
        const prefix = status === 429 ? 'All models rate-limited' : 'All fallback attempts failed';
        res.status(status).json({
          error: {
            message: `${prefix}. Last error: ${getErrorMessage(lastError)}`,
            type,
            status,
          },
        });
      } else {
        const statusCode = typeof err === 'object' && err !== null && 'status' in err && typeof (err as Record<string, unknown>).status === 'number'
          ? (err as {status: number}).status
          : 503;
        const message = typeof err === 'object' && err !== null && 'message' in err && typeof (err as Record<string, unknown>).message === 'string'
          ? (err as {message: string}).message
          : String(err);
        res.status(statusCode).json({
          error: { message, type: 'routing_error' },
        });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        // Lazy header set: pre-stream errors stay retryable (no headers sent yet);
        // mid-stream errors emit an `error` SSE frame so the client sees a real signal
        // instead of a silently truncated stream.
        let totalOutputTokens = 0;
        let streamedText = '';
        let sawToolCalls = false;
        let streamStarted = false;
        let ttfbMs: number | null = null;
        try {
          // Register the session as active
          if (sessionKey) {
            activeRequests.add({
              sessionKey,
              platform: route.platform,
              modelId: route.modelId,
              startTime: Date.now()
            });
          }

          const gen = route.provider.streamChatCompletion(
            route.apiKey, normalizedMessages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
          );

          let lastChunkTime = Date.now();
          let stalled = false;

          const cleanup = () => {
            clearInterval(keepaliveTimer);
            try { gen.return(undefined); } catch { /* already closed */ }
          };

          const keepaliveTimer = setInterval(() => {
            if (stalled) {
              clearInterval(keepaliveTimer);
              return;
            }
            const elapsed = Date.now() - lastChunkTime;
            if (elapsed >= streamKeepaliveConfig.MAX_STREAM_STALL_MS) {
              stalled = true;
              cleanup();
              if (streamStarted) {
                const payload = { error: { message: 'Stream stalled: no data received within timeout', type: 'stream_timeout', status: 504 } };
                try {
                  if (responseStreamContext) {
                    writeResponseStreamEvent(res, {
                      type: 'response.failed',
                      response: {
                        id: responseStreamContext.responseId,
                        status: 'failed',
                        error: payload.error,
                      },
                    });
                  } else {
                    res.write(`data: ${JSON.stringify(payload)}\n\n`);
                    res.write('data: [DONE]\n\n');
                  }
                  res.end();
                } catch { /* socket gone */ }
              }
              return;
            }
            if (!stalled && streamStarted && elapsed >= streamKeepaliveConfig.KEEPALIVE_INTERVAL_MS) {
              try { res.write(': keep-alive\n\n'); } catch { /* socket gone */ }
            }
          }, streamKeepaliveConfig.KEEPALIVE_INTERVAL_MS);

          res.on('close', cleanup);

          try {
            for await (const chunk of gen) {
              if (stalled) break;
              lastChunkTime = Date.now();
              if (!streamStarted) {
                ttfbMs = Date.now() - start;
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
                if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
                if (responseStreamContext) {
                  writeResponseStreamStart(res, responseStreamContext, route.modelId);
                }
                streamStarted = true;
                // Note: sticky routing slot was already allocated at request start (allocationResult)
              }
              const deltaToolCalls = chunk.choices[0]?.delta?.tool_calls ?? [];
              if (deltaToolCalls.length > 0) sawToolCalls = true;
              if (responseStreamContext) {
                totalOutputTokens += writeResponseStreamChunk(res, responseStreamContext, chunk);
              } else {
                const text = chunk.choices[0]?.delta?.content ?? '';
                if (text) streamedText += text;
                totalOutputTokens += Math.ceil(text.length / 4);
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            }
          } finally {
            res.off('close', cleanup);
            cleanup();
          }

          // Safe synchronous throw for pre-stream timeouts so the outer catch block
          // can handle retries safely (throwing inside setInterval causes uncaught exceptions)
          if (stalled && !streamStarted) {
            throw Object.assign(
              new Error(`Stream timed out: no data received from provider ${route.displayName}`),
              { status: 504 }
            );
          }

          // Check for truncated response content after stream completes.
          // The stream has already been sent to the client — no retry within same request.
          // Future requests in this session will route to other providers.
          {
            const streamTextToCheck = responseStreamContext ? responseStreamContext.outputText : streamedText;
            if (isTruncatedResponse(streamTextToCheck)) {
                const action = evaluateThreadProtection({ platform: route.platform, kind: 'truncation', midStream: false, modelDbId: route.modelDbId });
                if (action.banProvider) {
                  banPlatformFromSession(normalizedMessages, routingMode, route.platform, route.modelDbId);
                  addProviderModelsToSkipModels(skipModels, route.platform);
                }
                if (action.skipModel) {
                  skipModels.add(route.modelDbId);
                }
            }
          }

          if (!streamStarted) {
            // Upstream returned no chunks — emit minimal successful stream.
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
            if (responseStreamContext) {
              writeResponseStreamStart(res, responseStreamContext, route.modelId);
            }
          }

          const hasMeaningfulStreamOutput = responseStreamContext
            ? (responseStreamContext.outputText.trim().length > 0 || responseStreamContext.toolCalls.size > 0)
            : (streamedText.trim().length > 0 || sawToolCalls);
          if (!hasMeaningfulStreamOutput) {
            throw Object.assign(new Error(`Provider returned an empty streamed assistant response from ${route.displayName}`), { status: 502 });
          }

          if (responseStreamContext) {
            writeResponseStreamEnd(res, responseStreamContext, route.modelId, estimatedInputTokens, totalOutputTokens);
            logFinalModelResponse(route, {
              id: responseStreamContext.responseId,
              object: 'response',
              status: 'completed',
              model: route.modelId,
              output_text: responseStreamContext.outputText,
              tool_calls: Array.from(responseStreamContext.toolCalls.values()).map(toolCall => ({
                call_id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
              })),
              usage: {
                input_tokens: estimatedInputTokens,
                output_tokens: totalOutputTokens,
                total_tokens: estimatedInputTokens + totalOutputTokens,
              },
            }, ttfbMs);
          } else {
            res.write('data: [DONE]\n\n');
            logFinalModelResponse(route, {
              object: 'chat.completion.stream',
              model: route.modelId,
              output_tokens: totalOutputTokens,
            }, ttfbMs);
          }
          res.end();

          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(normalizedMessages, route.modelDbId, routingMode, route.keyId);
          resetAllConsecutiveFailures(normalizedMessages, routingMode);
          logRequest(route.platform, route.modelId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, ttfbMs, null);
          return;
        } catch (streamErr: unknown) {
            const err = streamErr instanceof Error ? streamErr : new Error(String(streamErr));
            if (streamStarted) {
            // 5xx failure detection for mid-stream errors
            // All providers: skip the specific model for this session
            const streamErrStatus = getErrorStatus(err);
            if (streamErrStatus && isBanEligibleStatus(streamErrStatus)) {
                const action = evaluateThreadProtection({ platform: route.platform, kind: '5xx', midStream: true, modelDbId: route.modelDbId, error: err });
                if (action.banProvider) {
                  banPlatformFromSession(normalizedMessages, routingMode, route.platform, route.modelDbId);
                  addProviderModelsToSkipModels(skipModels, route.platform);
                }
                if (action.skipModel) {
                  skipModels.add(route.modelDbId);
                }
                if (action.clearStickyIfPinned && preferredModel) {
                  const db = getDb();
                  const prefRow = db.prepare('SELECT platform FROM models WHERE id = ?').get(preferredModel) as { platform: string } | undefined;
                  if (prefRow?.platform === route.platform) {
                    preferredModel = undefined;
                    preferredKeyId = undefined;
                  }
                }
              // Register global transient cooldown for any 5xx mid-stream error
              transientModelCooldowns.set(route.modelDbId, Date.now() + TRANSIENT_COOLDOWN_MS);
            }

            // Generalized truncation detection for any provider (not just LongCat)
            // Aggregate all possible error text sources for comprehensive detection
            const truncationTexts: string[] = [];
            const errObj = streamErr as Record<string, unknown>;
            if (streamErr instanceof Error) {
              truncationTexts.push(streamErr.message);
            }
            const response = errObj?.response as Record<string, unknown> | undefined;
            if (response?.data) {
              truncationTexts.push(typeof response.data === 'string' ? response.data : JSON.stringify(response.data));
            }
            if (errObj?.body) {
              truncationTexts.push(typeof errObj.body === 'string' ? errObj.body : JSON.stringify(errObj.body));
            }
            truncationTexts.push(String(streamErr));
            const combinedTruncationText = truncationTexts.join(' ');
            if (isTruncatedResponse(combinedTruncationText)) {
                const action = evaluateThreadProtection({ platform: route.platform, kind: 'truncation', midStream: true, modelDbId: route.modelDbId, error: streamErr });
                if (action.banProvider) {
                  banPlatformFromSession(normalizedMessages, routingMode, route.platform, route.modelDbId);
                  addProviderModelsToSkipModels(skipModels, route.platform);
                }
                if (action.skipModel) {
                  skipModels.add(route.modelDbId);
                }
              try {
                if (responseStreamContext) {
                  writeResponseStreamEvent(res, {
                    type: 'response.completed',
                    response: {
                      id: responseStreamContext.responseId,
                      status: 'completed',
                      model: route.modelId,
                      output_text: responseStreamContext.outputText,
                    },
                  });
                } else {
                  res.write('data: [DONE]\n\n');
                }
                res.end();
              } catch { /* socket gone */ }
              logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, ttfbMs, streamErr instanceof Error ? streamErr.message : String(streamErr));
              return;
            }
          
            // Mid-stream retryable error handling — provider-ban for configured platforms
            if (isRetryableStreamError(streamErr)) {
              const protection = getProtectionLevel(route.platform);
              if (protection === 'provider-ban') {
                banPlatformFromSession(normalizedMessages, routingMode, route.platform, route.modelDbId);
                addProviderModelsToSkipModels(skipModels, route.platform);
              } else {
                skipModels.add(route.modelDbId);
              }
              // Clear sticky preference if pinned to this platform
              if (preferredModel) {
                const db = getDb();
                const prefRow = db.prepare('SELECT platform FROM models WHERE id = ?').get(preferredModel) as { platform: string } | undefined;
                if (prefRow?.platform === route.platform) {
                  preferredModel = undefined;
                  preferredKeyId = undefined;
                }
              }
              try {
                if (responseStreamContext) {
                  writeResponseStreamEvent(res, {
                    type: 'response.completed',
                    response: {
                      id: responseStreamContext.responseId,
                      status: 'completed',
                      model: route.modelId,
                      output_text: responseStreamContext.outputText,
                    },
                  });
                } else {
                  res.write('data: [DONE]\n\n');
                }
                res.end();
              } catch { /* socket gone */ }
              logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, ttfbMs, streamErr instanceof Error ? streamErr.message : String(streamErr));
              return;
            }

            // Mid-stream error — finish the SSE response cleanly instead of leaving
            // the client hanging or letting Express's default handler take over.
            // Full upstream message goes to the log; the client sees a generic
            // message so we don't leak provider internals into a partial stream.
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try {
              if (responseStreamContext) {
                writeResponseStreamEvent(res, {
                  type: 'response.failed',
                  response: {
                    id: responseStreamContext.responseId,
                    status: 'failed',
                    error: payload.error,
                  },
                });
              } else {
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
                res.write('data: [DONE]\n\n');
              }
              res.end();
            } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, ttfbMs, streamErr instanceof Error ? streamErr.message : String(streamErr));
            return;
          }
          // Pre-stream error — bubble to outer retry/502 handler.
          throw streamErr;
        } finally {
          // Ensure the session is deregistered immediately on end/abort/fail
          if (sessionKey) {
            for (const active of activeRequests) {
              if (active.sessionKey === sessionKey && active.platform === route.platform && active.modelId === route.modelId) {
                activeRequests.delete(active);
                break;
              }
            }
          }
          // T2.5: Release worker slot in finally block
          if (shouldRelease) {
            releaseIpForKey(requestApiKey);
          }
        }
      } else {
        let result;
        try {
          // Register the session as active
          if (sessionKey) {
            activeRequests.add({
              sessionKey,
              platform: route.platform,
              modelId: route.modelId,
              startTime: Date.now()
            });
          }

          result = await route.provider.chatCompletion(
           route.apiKey, normalizedMessages, route.modelId,
           { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
         );
         const ttfbMs = Date.now() - start;

         if (isEmptyAssistantResponse(result)) {
           throw Object.assign(new Error(`Provider returned an empty assistant response from ${route.displayName}`), { status: 502 });
         }

         const totalTokens = result.usage?.total_tokens ?? 0;
         recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
         recordSuccess(route.modelDbId);
         setStickyModel(normalizedMessages, route.modelDbId, routingMode, route.keyId);
         resetAllConsecutiveFailures(normalizedMessages, routingMode);

         res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
         if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
         // Note: sticky routing slot was already allocated at request start (allocationResult)
         const responseBody = formatResponse ? formatResponse(result, normalizedMessages) : result;
         res.json(responseBody);
         logFinalModelResponse(route, responseBody, ttfbMs);

         logRequest(
           route.platform, route.modelId, 'success',
           result.usage?.prompt_tokens ?? 0,
           result.usage?.completion_tokens ?? 0,
           Date.now() - start, ttfbMs, null,
         );
         return;
       } finally {
         // Ensure the session is deregistered immediately on end/abort/fail
         if (sessionKey) {
           for (const active of activeRequests) {
             if (active.sessionKey === sessionKey && active.platform === route.platform && active.modelId === route.modelId) {
               activeRequests.delete(active);
               break;
             }
           }
         }
         // T2.5: Release worker slot in finally block
         if (shouldRelease) {
           releaseIpForKey(requestApiKey);
         }
       }
     }
   } catch (err: unknown) {
      const latency = Date.now() - start;
      const errMessage = err instanceof Error ? err.message : String(err);
      logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, null, errMessage);

      // 5xx failure detection
         const errStatus = getErrorStatus(err);
         const isTransientCooldownEligible = (errStatus !== undefined && errStatus >= 500 && errStatus < 600) || errStatus === undefined;
         if (errStatus && isBanEligibleStatus(errStatus)) {
           const action = evaluateThreadProtection({ platform: route.platform, kind: '5xx', midStream: false, modelDbId: route.modelDbId, error: err });
           if (action.banProvider) {
             banPlatformFromSession(normalizedMessages, routingMode, route.platform, route.modelDbId);
             addProviderModelsToSkipModels(skipModels, route.platform);
           }
           if (action.skipModel) {
             skipModels.add(route.modelDbId);
             // Clear preferred model if it matches the model being skipped to avoid deadlock
             if (preferredModel === route.modelDbId) {
               preferredModel = undefined;
               preferredKeyId = undefined;
             }
           }
           if (action.clearStickyIfPinned && preferredModel) {
             const db = getDb();
             const prefRow = db.prepare('SELECT platform FROM models WHERE id = ?').get(preferredModel) as { platform: string } | undefined;
             if (prefRow?.platform === route.platform) {
               preferredModel = undefined;
               preferredKeyId = undefined;
             }
           }
           // Only register transient cooldown when all keys are exhausted (non-retryable).
           // A single key failing should not penalise the entire model — other keys may work.
           if (!isRetryableError(err)) {
             transientModelCooldowns.set(route.modelDbId, Date.now() + TRANSIENT_COOLDOWN_MS);
           }
         } else if (isTransientCooldownEligible) {
           // Connection failures (undefined status) and non-ban-eligible 5xx (e.g. 501, 505+)
           // still trigger transient cooldown even if not session-banned — but only when
           // all keys are exhausted (non-retryable) so a single key failure doesn't penalise the model.
           if (!isRetryableError(err)) {
             transientModelCooldowns.set(route.modelDbId, Date.now() + TRANSIENT_COOLDOWN_MS);
           }
         }

        if (isRetryableError(err)) {
           // Do NOT register transient cooldown here — the retry loop will try other keys
           // for this model first. Cooldowns are only set above for non-retryable errors
           // when all keys are exhausted.
           const action = evaluateThreadProtection({ platform: route.platform, kind: 'retryable', midStream: false, modelDbId: route.modelDbId, error: err });
           if (action.banProvider) {
             banPlatformFromSession(normalizedMessages, routingMode, route.platform, route.modelDbId);
             addProviderModelsToSkipModels(skipModels, route.platform);
           }
           if (action.skipModel) {
             skipModels.add(route.modelDbId);
             // Clear preferred model if it matches the model being skipped to avoid deadlock
             if (preferredModel === route.modelDbId) {
               preferredModel = undefined;
               preferredKeyId = undefined;
             }
           }
           if (action.clearStickyIfPinned && preferredModel) {
             const db = getDb();
             const prefRow = db.prepare('SELECT platform FROM models WHERE id = ?').get(preferredModel) as { platform: string } | undefined;
             if (prefRow?.platform === route.platform) {
               preferredModel = undefined;
               preferredKeyId = undefined;
             }
           }
           if (!action.banProvider) {
             // Key-level retry handling for non-provider-ban platforms
             const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
             skipKeys.add(skipId);
             // Non-rate-limit, non-auth errors: skip the model so fallback moves to a different model
             if (shouldSkipModelOnRetry(err)) {
               skipModels.add(route.modelDbId);
             }
             // Rate-limit errors: cooldown this key but allow other keys for the same model
             if (isRateLimitError(err)) {
               setCooldown(route.platform, route.modelId, route.keyId, 120_000);
               // Check if all keys for the preferred model are exhausted
               if (preferredModel === route.modelDbId) {
                 const db = getDb();
                 const keys = db.prepare(
                   'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND (status != ? OR status IS NULL)'
                 ).all(route.platform, 'invalid') as Array<{ id: number; rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null }>;

                 const hasValidKeys = keys.some(key => !isOnCooldown(route.platform, route.modelId, key.id));

                 if (!hasValidKeys) {
                   // All keys exhausted, clear preferred model to avoid deadlock
                   preferredModel = undefined;
                   preferredKeyId = undefined;
                 }
               }
             }
           }
        // Auth errors (401/403): clear the sticky key for this session
        // so the retry unpins the broken key and falls through to round-robin.
        if (isAuthError(err)) {
          const authStatus = getErrorStatus(err);
          clearStickyKey(normalizedMessages, routingMode);
          preferredKeyId = undefined;
        }
        lastError = err;
        continue;
      }

      // Non-retryable error (auth, etc.): don't retry, but clear sticky so the
      // next request in this conversation isn't pinned to the broken model.
      clearStickyModel(normalizedMessages, routingMode);
      const nonRetryableStatus = getErrorStatus(err) ?? 502;
      res.status(nonRetryableStatus).json({
        error: {
          message: `Provider error (${route.displayName}): ${getErrorMessage(err)}`,
          type: nonRetryableStatus === 429 ? 'rate_limit_error' : 'provider_error',
          status: nonRetryableStatus,
        },
      });
      return;
    }
  }

  // Exhausted all retries
  const status = isRateLimitError(lastError) ? 429 : 502;
  const type = status === 429 ? 'rate_limit_error' : 'provider_error';
  const message = status === 429
    ? `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${getErrorMessage(lastError)}`
    : `All fallback attempts failed after ${MAX_RETRIES} attempts. Last: ${getErrorMessage(lastError)}`;
  res.status(status).json({
    error: {
      message,
      type,
      status,
    },
  });
}

function logRequest(
  platform: string,
  modelId: string,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  ttfbMs: number | null,
  error: string | null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, status, inputTokens, outputTokens, latencyMs, ttfbMs, error);
  } catch (e) {
  }
}
