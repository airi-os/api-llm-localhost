// Shared .env file parser and writer
// Preserves comments, ordering, and existing values

import fs from 'node:fs';

export function parseEnvFile(filePath: string): Map<string, string> {
  const env = new Map<string, string>();
  if (!fs.existsSync(filePath)) return env;

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    env.set(key, val);
  }
  return env;
}

export function readEnvFileRaw(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Write updates to an .env file.
 * - Keys that don't exist are appended.
 * - Keys that exist with a non-empty value are preserved.
 * - Keys that exist with an empty value are updated (treated as "missing").
 */
export function writeEnvFile(
  filePath: string,
  existingContent: string,
  updates: Map<string, string>,
  dryRun: boolean,
): { written: string[]; preserved: string[]; updated: string[] } {
  const written: string[] = [];
  const preserved: string[] = [];
  const updated: string[] = [];

  const existingEnv = parseEnvFile(filePath);
  const lines = existingContent.split('\n');

  // Determine which keys need in-place update (exist but empty) vs append (don't exist)
  const keysToAppend: string[] = [];
  const keysToUpdateInPlace: string[] = [];

  for (const [key, value] of updates) {
    if (!existingEnv.has(key)) {
      keysToAppend.push(key);
    } else if (!existingEnv.get(key)) {
      // Key exists but value is empty — treat as needing update
      keysToUpdateInPlace.push(key);
    } else {
      preserved.push(key);
    }
  }

  // Update in-place keys (rewrite the file with updated values)
  if (keysToUpdateInPlace.length > 0) {
    const updateMap = new Map(updates);
    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return line;
      const k = trimmed.slice(0, eq).trim();
      if (keysToUpdateInPlace.includes(k) && updateMap.has(k)) {
        const v = updateMap.get(k)!;
        updated.push(k);
        return `${k}=${v}`;
      }
      return line;
    });

    if (!dryRun) {
      fs.writeFileSync(filePath, newLines.join('\n'));
    }
  }

  // Append new keys
  if (keysToAppend.length > 0) {
    const separator = existingContent.endsWith('\n') ? '' : '\n';
    const appendContent =
      separator +
      keysToAppend
        .map((k) => `${k}=${updates.get(k)}`)
        .join('\n') +
      '\n';

    for (const k of keysToAppend) written.push(k);

    if (!dryRun) {
      fs.appendFileSync(filePath, appendContent);
    }
  }

  return { written, preserved, updated };
}

/**
 * Update a single key in an .env file (in-place rewrite).
 * If the key doesn't exist, it is appended.
 */
export function updateEnvKey(
  filePath: string,
  key: string,
  value: string,
  dryRun: boolean,
): boolean {
  const content = readEnvFileRaw(filePath);
  const lines = content.split('\n');
  let found = false;
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const k = trimmed.slice(0, eq).trim();
    if (k === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    const separator = content.endsWith('\n') ? '' : '\n';
    if (!dryRun) {
      fs.appendFileSync(filePath, `${separator}${key}=${value}\n`);
    }
    return true;
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, newLines.join('\n'));
  }
  return true;
}
