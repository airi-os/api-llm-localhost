# Design: LongCat Smart-Auto Preference

## Architecture

The change is confined to server/src/services/router.ts in the routeRequest function. No new files, no new dependencies, no database schema changes.

## Approach: Pre-sort LongCat Boost

After the Thompson Sampling scores are computed and the entries are sorted, but before the key-iteration loop begins, we apply a LongCat preference step. This step only activates when routingMode is "smart".

The algorithm is:

1. Compute scores and sort as before (existing logic).
2. Apply sticky session pinning (existing logic, lines 498-505).
3. NEW: If routingMode is "smart", check if any LongCat model in the sorted list has at least one key with remaining rate-limit capacity. If so, move all LongCat entries to the front of the sorted list, preserving their relative score order.
4. Iterate the sorted list and try keys as before.

## Key Design Decisions

### Why pre-sort instead of score boost?

Adding a large constant to LongCat scores would work but is fragile — it depends on knowing the max possible score. Physically moving LongCat entries to the front of the array is cleaner and guaranteed to work regardless of score magnitudes.

### Why check rate limits before boosting?

The existing per-key rate-limit checks (canMakeRequest, canUseTokens, isOnCooldown) happen inside the inner loop. For the LongCat boost, we need a quick pre-check: does this model have ANY key that is not exhausted? We iterate LongCat keys once before the main loop to decide whether to boost.

### Why only in smart mode?

The user explicitly requested this for auto-smart only. Balanced mode should remain pure Thompson Sampling.

### Sticky session precedence

Sticky sessions are applied BEFORE the LongCat boost. If a sticky session pins a non-LongCat model, that model stays at position 0. LongCat entries are boosted to position 1+ in that case. This preserves the anti-hallucination guarantee of sticky sessions.

## Implementation Details

In routeRequest, after the sticky session block (line 505), add:

```
// LongCat preference in smart mode: move LongCat entries to front
if (routingMode === 'smart') {
  const longcatIdx = sorted.findIndex(e => e.platform === 'longcat');
  if (longcatIdx > 0) {
    // Check if any LongCat key has capacity
    const longcatEntry = sorted[longcatIdx];
    const lcKeys = db.prepare(
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
    ).all('longcat', 'invalid') as KeyRow[];
    const lcLimits = {
      rpm: longcatEntry.rpm_limit,
      rpd: longcatEntry.rpd_limit,
      tpm: longcatEntry.tpm_limit,
      tpd: longcatEntry.tpd_limit,
    };
    const hasCapacity = lcKeys.some(key =>
      !isOnCooldown(longcatEntry.platform, longcatEntry.model_id, key.id) &&
      canMakeRequest(longcatEntry.platform, longcatEntry.model_id, key.id, lcLimits) &&
      canUseTokens(longcatEntry.platform, longcatEntry.model_id, key.id, estimatedTokens, lcLimits)
    );
    if (hasCapacity) {
      // Move all longcat entries to front, preserving relative order
      const longcatEntries = sorted.filter(e => e.platform === 'longcat');
      const others = sorted.filter(e => e.platform !== 'longcat');
      sorted.length = 0;
      sorted.push(...longcatEntries, ...others);
    }
  }
}
```

Wait — this has a subtlety. The sticky session might have already moved a non-LongCat model to position 0. In that case, we should boost LongCat to position 1, not position 0. The filter+rebuild approach handles this correctly: we extract LongCat entries and prepend them, but we need to respect the sticky model at position 0.

Revised approach: After sticky session pinning, if the sticky model is NOT LongCat, extract LongCat entries and insert them at position 1 (after the sticky model). If the sticky model IS LongCat, it is already at position 0 and we just need to move remaining LongCat entries to position 1.

Simpler: just splice all LongCat entries out and unshift them. The sticky session pinning already happened, so if a non-LongCat model was pinned to 0, we should insert LongCat at index 1 instead.

Even simpler: apply the LongCat boost BEFORE the sticky session. Then sticky session pinning (which moves the preferred model to index 0) will correctly take precedence. LongCat entries that are not the sticky model will be at positions 1+.

Final ordering:
1. Compute scores, sort.
2. LongCat boost: move LongCat entries to front if smart mode and has capacity.
3. Sticky session: move preferred model to position 0 (overrides LongCat boost if sticky is non-LongCat).
4. Iterate and try keys.
