/**
 * Probe every enabled model with a minimal request to find broken model IDs.
 * Usage: npx tsx src/scripts/test-all-models.ts
 */
import { initDb, getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider } from '../providers/index.js';
import type { Platform } from '@freellmapi/shared/types.js';

initDb();
const db = getDb();

interface Row {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
}
interface Key {
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

const models = db.prepare(`
  SELECT m.id, m.platform, m.model_id, m.display_name
    FROM models m
   WHERE m.enabled = 1
     AND EXISTS (SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = 1)
   ORDER BY m.intelligence_rank, m.platform
`).all() as Row[];

const keyStmt = db.prepare(`
  SELECT encrypted_key, iv, auth_tag FROM api_keys
   WHERE platform = ? AND enabled = 1 ORDER BY id LIMIT 1
`);

const results: { row: Row; ok: boolean; ms: number; error?: string; reply?: string }[] = [];

for (const row of models) {
  const keyRow = keyStmt.get(row.platform) as Key | undefined;
  if (!keyRow) { results.push({ row, ok: false, ms: 0, error: 'no key' }); continue; }
  const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  const provider = getProvider(row.platform as Platform);
  if (!provider) { results.push({ row, ok: false, ms: 0, error: 'no provider' }); continue; }

  const start = Date.now();
  try {
    const res = await provider.chatCompletion(apiKey, [{ role: 'user', content: 'hi' }], row.model_id, { max_tokens: 5 });
    const reply = res.choices?.[0]?.message?.content?.slice(0, 40) ?? '';
    results.push({ row, ok: true, ms: Date.now() - start, reply });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    results.push({ row, ok: false, ms: Date.now() - start, error: errorMsg.slice(0, 200) });
  }
}

const pad = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
for (const r of results) {
  const status = r.ok ? '✓' : '✗';
}
const okCount = results.filter(r => r.ok).length;

process.exit(0);
