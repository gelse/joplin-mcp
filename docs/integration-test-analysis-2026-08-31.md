# Integration Test Coverage Analysis

> Date: 2026-08-31

There are **two tiers** of integration tests:

1. **`tests/integration.test.ts`** — exercises `JoplinDataClient` directly against a real Joplin Data API (skipped unless `RUN_INTEGRATION_TESTS=true`).
2. **`tests/container/*.test.ts`** — spin up the full MCP server in Docker (`docker-compose.test.yml`/`Dockerfile.tests`) and drive it over the MCP protocol via the SDK `Client`. This is the primary end-to-end coverage.

---

## Functions tested via the container (end-to-end MCP) tests

The MCP tools map 1:1 to handler functions in [`src/mcp/tools.ts`](src/mcp/tools.ts), which in turn call `JoplinDataClient` methods in [`src/data-client.ts`](src/data-client.ts).

### Read tools — covered ✅

| Tool | Handler fn | Data-client method | Covered by |
|------|-----------|--------------------|-----------|
| `list_notes` | [`listNotes`](src/mcp/tools.ts:36) | `listNotes()` | [`notes-crud.test.ts`](tests/container/notes-crud.test.ts:87) |
| `read_note` | [`readNote`](src/mcp/tools.ts:63) | `getNote()` | [`notes-crud.test.ts`](tests/container/notes-crud.test.ts:66) |
| `read_multinote` | [`readMultinote`](src/mcp/tools.ts:71) | `getNote()` (multiple, `allSettled`) | [`notes-crud.test.ts`](tests/container/notes-crud.test.ts:136) |
| `list_notebooks` | [`listNotebooks`](src/mcp/tools.ts:45) | `getAllFolders()` | [`folders-crud.test.ts`](tests/container/folders-crud.test.ts:54) |
| `read_notebook` | [`readNotebook`](src/mcp/tools.ts:67) | `getFolder()` | [`folders-crud.test.ts`](tests/container/folders-crud.test.ts:38,92,127) |
| `read_tags` | [`readTags`](src/mcp/tools.ts:95) | `getNoteTags()` | [`search-tags.test.ts`](tests/container/search-tags.test.ts:204,235) |

### Write tools — covered ✅

| Tool | Handler fn | Data-client method | Covered by |
|------|-----------|--------------------|-----------|
| `create_note` | [`createNote`](src/mcp/tools.ts:104) | `createNote()` + `triggerSync` | [`notes-crud.test.ts`](tests/container/notes-crud.test.ts:47) |
| `edit_note` | [`editNote`](src/mcp/tools.ts:142) | `updateNote()` + `triggerSync` | [`notes-crud.test.ts`](tests/container/notes-crud.test.ts:108) |
| `delete_note` | [`deleteNote`](src/mcp/tools.ts:206) | `deleteNote()` + `triggerSync` | [`notes-crud.test.ts`](tests/container/notes-crud.test.ts:174) |
| `create_folder` | [`createFolder`](src/mcp/tools.ts:129) | `createFolder()` + `triggerSync` | [`folders-crud.test.ts`](tests/container/folders-crud.test.ts:24) |
| `edit_folder` | [`editFolder`](src/mcp/tools.ts:164) | `updateFolder()` + `triggerSync` | [`folders-crud.test.ts`](tests/container/folders-crud.test.ts:70) |
| `delete_folder` | [`deleteFolder`](src/mcp/tools.ts:215) | `deleteFolder()` + `triggerSync` | [`folders-crud.test.ts`](tests/container/folders-crud.test.ts:92) |
| `create_tag` | [`createTag`](src/mcp/tools.ts:174) | `createTag()` + `triggerSync` | [`search-tags.test.ts`](tests/container/search-tags.test.ts:167) |
| `tag_note` | [`tagNote`](src/mcp/tools.ts:180) | `tagNote()` + `triggerSync` | [`search-tags.test.ts`](tests/container/search-tags.test.ts:179) |
| `untag_note` | [`untagNote`](src/mcp/tools.ts:193) | `untagNote()` + `triggerSync` | [`search-tags.test.ts`](tests/container/search-tags.test.ts:235) |
| Nested folders (`parent_id`) | — | `createFolder`/`getFolder` | [`folders-crud.test.ts`](tests/container/folders-crud.test.ts:107) |

### Infrastructure / harness — covered ✅

- MCP initialize handshake, 17-tool discovery, schema shape, and tool-name enumeration → [`mcp-connection.test.ts`](tests/container/mcp-connection.test.ts:15)
- Health endpoint `/health` → [`mcp-connection.test.ts`](tests/container/mcp-connection.test.ts:59)
- Validation + error paths (invalid/absent IDs, missing/empty required fields, unknown tool) → [`error-handling.test.ts`](tests/container/error-handling.test.ts:21)
- Helper functions [`createTestClient`](tests/container/helpers.ts:7), [`callTool`](tests/container/helpers.ts:20), [`uid`](tests/container/helpers.ts:15), [`CleanupTracker`](tests/container/helpers.ts:34)

### Direct `JoplinDataClient` coverage (non-container) in [`tests/integration.test.ts`](tests/integration.test.ts)

- Auth/token acquisition via `listNotes` (line 75); unreachable server error (line 81)
- Note CRUD: `createNote`, `getNote`, `updateNote`, `deleteNote` → 404 (lines 98–157)
- Folder CRUD: `createFolder`, `getFolder`, `listFolders` + pagination (lines 166–184)
- `search` found + non-matching (lines 193–215); pagination `listNotes` limit/page (lines 224–261)

---

## Gaps NOT verified by integration tests ⚠️

### 1. `sync` tool is untested end-to-end

[`sync`](src/mcp/tools.ts:228) (and `SyncManager.triggerSync`, which every write tool calls) is only *listed* by name in [`mcp-connection.test.ts`](tests/container/mcp-connection.test.ts:56). **No test actually invokes it.** There *is* a separate shell-based test ([`test-check-sync-errors.sh`](tests/test-check-sync-errors.sh), [`test-sync-failure-diagnostics.sh`](tests/test-sync-failure-diagnostics.sh)), but no container/MCP-level verification of the `sync` tool output, `getSyncStatus`, or `getLastSyncTime`.

### 2. `search_notes` positive/functional cases are SKIPPED

The three meaningful search tests (`search_notes — finds by body`, `search_notes type: note`, `search_notes type: folder`) are marked `it.skip` in [`search-tags.test.ts`](tests/container/search-tags.test.ts:88,110,133) because the Joplin headless CLI doesn't build the FTS index ([upstream issue #11631](https://github.com/laurent22/joplin/issues/11631)). Only the empty-results test (line 154) and empty-query validation run. **Actual search behavior, `type:` filtering, and query matching are unverified.**

### 3. `SyncManager` periodic/initial sync path

[`initialSync`](src/sync-manager.ts:59), [`startPeriodicSync`](src/sync-manager.ts:77), and [`stopPeriodicSync`](src/sync-manager.ts:105) are **not exercised** by any integration test (they are covered only by the unit test [`tests/sync-manager.test.ts`](tests/sync-manager.test.ts)).

### 4. `read_multinote` error-partial path

The test only covers the happy path (all IDs valid, `errors: []`). The branch where some `getNote` calls reject and populate the `errors` array (lines 84–89 of [`tools.ts`](src/mcp/tools.ts:84)) is **not integration-tested**.

### 5. `cli-executor` not driven through integration

[`CliExecutor`](src/cli-executor.ts) — the Joplin CLI sync wrapper — is tested only at unit level ([`tests/cli-executor.test.ts`](tests/cli-executor.test.ts)); the real CLI binary is **not driven** through any integration test (the container approximates sync via the `joplin_data` volume and implicit sync delays).

### 6. Tag cleanup / volume-bound behavior

[`CleanupTracker`](tests/container/helpers.ts:54) explicitly notes there is **no `delete_tag` tool**; tags are only removed by destroying the `joplin_data` volume (`docker compose down -v`). Tag-deletion semantics are therefore untested (no UI to delete tags at all).

### 7. Soft-delete read-after-delete is weakly asserted

[`notes-crud.test.ts`](tests/container/notes-crud.test.ts:174) and [`folders-crud.test.ts`](tests/container/folders-crud.test.ts:92) only check that `read_note`/`read_notebook` "still returns data" after delete; they don't assert *what* state (e.g., tombstone flag, missing body) is returned.

### 8. Todo fields & `is_todo`/`todo_due`/`source_url`

[`createNote`](src/mcp/tools.ts:104) and [`editNote`](src/mcp/tools.ts:142) accept todo/author/source_url fields (with a boolean→1/0 conversion), but **no integration test passes these**; only title, body, and parent_id are exercised.
