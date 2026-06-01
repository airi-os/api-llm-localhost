# Tasks: LongCat LLM Provider Implementation

## Implementation Steps

- [x] 1. Add `'longcat'` to the `Platform` type in `shared/types.ts`
  - Edit line 23: add `| 'longcat'` to the union type
  - This must be done first — all other files depend on this type

- [x] 2. Register LongCat provider in `server/src/providers/index.ts`
  - After line 145 (InceptionLabs registration), add:
    ```typescript
    register(new OpenAICompatProvider({
      platform: 'longcat',
      name: 'LongCat',
      baseUrl: 'https://api.longcat.chat/openai',
    }));
    ```

- [x] 3. Add `'longcat'` to the `PLATFORMS` allowlist in `server/src/routes/keys.ts`
  - Edit line 15: add `'longcat'` to the array

- [x] 4. Add `migrateModelsV16` in `server/src/db/index.ts`
  - After the `migrateModelsV15` function (after line 1058), add the new migration function
  - Insert the LongCat model with stats matching Owl Alpha
  - Auto-populate `fallback_config` for any missing entries
  - Add `migrateModelsV16(db);` call in `initDb()` after `migrateModelsV15(db);` (after line 52)

- [x] 5. Add LongCat to client PLATFORMS in `client/src/pages/KeysPage.tsx`
  - After line 27 (InceptionLabs entry), add:
    ```typescript
    { value: 'longcat', label: 'LongCat', keyUrl: 'https://longcat.chat' },
    ```

- [x] 6. Add LongCat color to `platformColors` in `client/src/pages/FallbackPage.tsx`
  - After line 106 (`llm7: '#0ea5e9',`), add:
    ```typescript
    longcat:     '#ff6b35',
    ```

- [x] 7. Verify TypeScript compilation
  - Run `npx tsc --noEmit` in both `server/` and `client/` directories
  - Ensure no type errors from the `Platform` type change

- [x] 8. Test the migration on a fresh database
  - Initialize a fresh DB and verify the LongCat model appears in the `models` table
  - Verify a `fallback_config` entry is auto-created for LongCat
  - Verify re-running the migration is idempotent (no duplicates)

- [x] 9. Test end-to-end with a real API key
  - Add a LongCat API key via the Keys page
  - Send a chat completion request and verify it routes through LongCat
  - Verify analytics show the request under the LongCat platform
