/**
 * Walk the live routing chain 100 steps and report which models are selected.
 * Uses the real database and real analytics history — no synthetic data.
 *
 * Each step adds the chosen model+key to skipKeys so the next call must
 * pick a different one, revealing the full sorted priority order.
 *
 * Usage: npx tsx src/scripts/test-routing-distribution.ts
 */

import '../env.js';
import { initDb } from '../db/index.js';
import { routeRequest } from '../services/router.js';

initDb();

const order: string[] = [];
const skipKeys = new Set<string>();

for (let i = 0; i < 100; i++) {
  let route;
  try {
    route = routeRequest(1000, skipKeys.size > 0 ? skipKeys : undefined);
  } catch {
    break;
  }
  order.push(`${route.platform}/${route.modelId}`);
  skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
}


const providerCounts = new Map<string, number>();
for (const [, label] of order.entries()) {
  const provider = label.split('/')[0];
  providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
}

const sorted = [...providerCounts.entries()].sort((a, b) => b[1] - a[1]);
// Distribution summary available via sorted array

const topProvider = order[0]?.split('/')[0];
