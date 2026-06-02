#!/usr/bin/env python3
"""Write the complete router.test.ts file."""

path = '/home/vi/freellmapi/server/src/__tests__/services/router.test.ts'

content = [
    "import { describe, it, expect, beforeAll, beforeEach } from 'vitest';",
    "import { initDb, getDb } from '../../db/index.js';",
    "import { encrypt } from '../../lib/crypto.js';",
    "import { routeRequest, refreshStatsCache, getAnalyticsScores } from '../../services/router.js';",
    "",
    "describe('Router', () => {",
    "  beforeAll(() => {",
    "    process.env.ENCRYPTION_KEY = '0'.repeat(64);",
    "    initDb(':memory:');",
    "  });",
    "",
    "  beforeEach(() => {",
    "    const db = getDb();",
    "    db.prepare('DELETE FROM api_keys').run();",
    "    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];",
    "    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');",
    "    for (let i = 0; i < models.length; i++) {",
    "      update.run(i + 1, models[i].id);",
    "    }",
    "  });",
    "",
    "  it('should throw when no keys are configured', () => {",
    "    expect(() => route{