import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import type { BaseProvider } from '../providers/base.js';
import type { Database } from 'better-sqlite3';

interface ChainRow {
  model_db_id: number;
  priority: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

// ── Analytics-based routing ────────────────────────────────────────────────
// Bayesian success rate + UCB exploration so the router prefers models that
// historically succeed while still probing lesser-known ones.

const ANALYTICS_WINDOW_MS = 24 * 60 * 60 * 1000; // look-back window for stats
const ANALYTICS_CACHE_TTL_MS = 60 * 1000;         // re-query at most once per minute

// Beta prior: equivalent to having seen PRIOR_TOTAL observations with a 50% rate.
// Ensures models with no history get a neutral score rather than being ranked
// as perfect or terrible.
const PRIOR_SUCCESS = 2;
const PRIOR_TOTAL = 4;

// UCB exploration constant. Scales the bonus that pulls under-sampled models up.
const EXPLORE_FACTOR = 0.15;

// Weight of the normalized speed signal relative to the success-rate signal.
// Success rate is the primary gate (broken models must not be chosen); speed
// is secondary — a fast model with equal reliability should win.
const SPEED_WEIGHT = 0.3;

// Optimistic speed prior for models with no successful history yet.
// UCB principle: be optimistic under uncertainty — assume as fast as the fastest
// known model until data proves otherwise. Using 0.5 (pessimistic) was penalising
// untested models and preventing them from ever being tried.
const SPEED_PRIOR = 1.0;

// Maximum positions analytics can shift a model up or down from its configured
// base priority. Keeping this small ensures analytics is a soft tie-breaker
// rather than a winner-takes-all override. Without a cap, a model with even a
// slight track record advantage gets scaled by the full chain length (~50) and
// permanently locks out every competitor.
const ANALYTICS_SHIFT_CAP = 5;

interface ModelStats {
  successes: number;
  total: number;
  tokPerSec: number; // output tok/s from successful requests only
}

let statsCache: Map<string, ModelStats> | null = null;
let statsCacheTime = 0;
let totalGlobalRequests = 0;
let maxTokPerSec = 0; // normalisation denominator for speed scores

function refreshStatsCache(db: Database): void {
  if (statsCache && Date.now() - statsCacheTime < ANALYTICS_CACHE_TTL_MS) return;

  const since = new Date(Date.now() - ANALYTICS_WINDOW_MS).toISOString();
  const rows = db.prepare(`
    SELECT platform, model_id,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
      CASE
        WHEN SUM(CASE WHEN status = 'success' THEN latency_ms ELSE 0 END) > 0
        THEN SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END) * 1000.0
             / SUM(CASE WHEN status = 'success' THEN latency_ms ELSE 0 END)
        ELSE 0
      END as tok_per_sec
    FROM requests
    WHERE created_at >= ?
    GROUP BY platform, model_id
  `).all(since) as Array<{ platform: string; model_id: string; total: number; successes: number; tok_per_sec: number }>;

  statsCache = new Map();
  totalGlobalRequests = 0;
  maxTokPerSec = 0;
  for (const row of rows) {
    statsCache.set(`${row.platform}:${row.model_id}`, {
      successes: row.successes,
      total: row.total,
      tokPerSec: row.tok_per_sec,
    });
    totalGlobalRequests += row.total;
    if (row.tok_per_sec > maxTokPerSec) maxTokPerSec = row.tok_per_sec;
  }
  statsCacheTime = Date.now();
}

function getAnalyticsScore(platform: string, modelId: string): number {
  const stats = statsCache?.get(`${platform}:${modelId}`);
  const total = stats?.total ?? 0;
  const successes = stats?.successes ?? 0;

  const bayesRate = (successes + PRIOR_SUCCESS) / (total + PRIOR_TOTAL);
  // UCB bonus: large when model is rarely observed, shrinks with more data
  const explorationBonus = EXPLORE_FACTOR * Math.sqrt(Math.log(totalGlobalRequests + 1) / (total + 1));
  const successScore = bayesRate + explorationBonus;

  // Normalise speed to [0, 1] relative to the fastest observed model.
  // Falls back to a neutral prior when no successful data exists yet.
  const speedScore = (maxTokPerSec > 0 && stats && stats.tokPerSec > 0)
    ? stats.tokPerSec / maxTokPerSec
    : SPEED_PRIOR;

  return successScore + SPEED_WEIGHT * speedScore;
}

/**
 * Returns current analytics scores for every (platform, model_id) pair seen in
 * the last 24 h. Used by the fallback dashboard to surface routing rationale.
 */
export function getAnalyticsScores(): Array<{
  platform: string;
  modelId: string;
  score: number;
  successRate: number;
  total: number;
  tokPerSec: number;
}> {
  if (!statsCache) return [];
  const result: Array<{
    platform: string;
    modelId: string;
    score: number;
    successRate: number;
    total: number;
    tokPerSec: number;
  }> = [];
  for (const [key, stats] of statsCache) {
    const [platform, ...rest] = key.split(':');
    const modelId = rest.join(':');
    result.push({
      platform,
      modelId,
      score: getAnalyticsScore(platform, modelId),
      successRate: stats.total > 0 ? stats.successes / stats.total : 0,
      total: stats.total,
      tokPerSec: stats.tokPerSec,
    });
  }
  return result.sort((a, b) => b.score - a.score);
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/**
 * Get the current penalty for a model (with time-based decay).
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  // Apply time-based decay
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now; // reset so we don't double-decay
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

/**
 * Route a request to the best available model.
 *
 * Ordering combines three signals (all lower = tried first):
 *   1. Analytics bias   — derived from recent success rate + UCB exploration bonus
 *   2. Rate-limit penalty — in-session 429 counter with time decay
 *   3. Base priority    — user-configured fallback order
 *
 * If preferredModelDbId is set, that model is forced to the front (sticky sessions)
 * to prevent hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate-limit pre-check
 * @param skipKeys - "platform:modelId:keyId" triples to skip (already failed this request)
 * @param preferredModelDbId - pin this model to position 0 (sticky session)
 */
export function routeRequest(estimatedTokens = 1000, skipKeys?: Set<string>, preferredModelDbId?: number): RouteResult {
  const db = getDb();

  // Refresh analytics cache (no-op if called within the TTL window)
  refreshStatsCache(db);

  // Single query: join fallback config with model details, filtering out disabled rows
  const chain = db.prepare(`
    SELECT fc.model_db_id, fc.priority,
           m.platform, m.model_id, m.display_name,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
    WHERE fc.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as ChainRow[];

  // Score each entry. analyticsBias nudges a model up (negative) or down
  // (positive) relative to its configured base priority, capped at
  // ANALYTICS_SHIFT_CAP so that a model's track record can never completely
  // override the user's intended ordering.
  const sorted = chain.map(entry => ({
    ...entry,
    effectivePriority:
      entry.priority
      + getPenalty(entry.model_db_id)
      + (1 - getAnalyticsScore(entry.platform, entry.model_id)) * ANALYTICS_SHIFT_CAP,
  })).sort((a, b) => a.effectivePriority - b.effectivePriority);

  // Sticky session: force preferred model to the front regardless of score
  if (preferredModelDbId) {
    const idx = sorted.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sorted.splice(idx, 1);
      sorted.unshift(preferred);
    }
  }

  for (const entry of sorted) {
    const provider = getProvider(entry.platform as any);
    if (!provider) continue;

    const keys = db.prepare(
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
    ).all(entry.platform, 'invalid') as KeyRow[];

    if (keys.length === 0) continue;

    const limits = {
      rpm: entry.rpm_limit,
      rpd: entry.rpd_limit,
      tpm: entry.tpm_limit,
      tpd: entry.tpd_limit,
    };

    const rrKey = `${entry.platform}:${entry.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${entry.platform}:${entry.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;
      if (isOnCooldown(entry.platform, entry.model_id, key.id)) continue;
      if (!canMakeRequest(entry.platform, entry.model_id, key.id, limits)) continue;
      if (!canUseTokens(entry.platform, entry.model_id, key.id, estimatedTokens, limits)) continue;

      roundRobinIndex.set(rrKey, idx);
      const decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);

      return {
        provider,
        modelId: entry.model_id,
        modelDbId: entry.model_db_id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: entry.platform,
        displayName: entry.display_name,
      };
    }

    roundRobinIndex.set(rrKey, idx);
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as any;
  err.status = 429;
  throw err;
}
