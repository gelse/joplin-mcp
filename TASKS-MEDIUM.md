# 🟡 Medium Priority Tasks

**Severity:** Medium — should be addressed in the next 1–2 development cycles to improve code quality, test confidence, and operational robustness.
**Issue count:** 12
**Source:** [CODEREVIEW.md](./CODEREVIEW.md) sections 15–26

These issues cover testing gaps, configuration hardening, error handling consistency, and linting improvements that collectively reduce maintenance burden and increase confidence in changes.

---

## MED-001 — Refactor Fragile Mock Introspection for Exit Handler

**Affected file:** [`tests/server.test.ts:185-194,236-245,445-454`](./tests/server.test.ts:185)

**Problem description:**
Three tests locate the `exitHandler` by searching through mock call arrays via `childProcess.on.mock.calls.find(...)` — a fragile introspection pattern. The tests look for the handler registered via `.on('exit', handler)` by iterating mock call records. Any change to the order or number of `.on()` calls (e.g., adding a `'error'` handler) will silently break these tests in ways that are hard to debug:

```typescript
// Fragile pattern in tests:
const exitHandler = childProcess.on.mock.calls.find((call) => call[0] === 'exit')?.[1];
```

**Risk/impact:** LOW-MEDIUM — Tests are brittle to implementation changes. A developer adding an event handler could break tests without realizing the tests depend on call ordering. This discourages refactoring of `startDataApiServer()`.

**Detailed steps to fix:**

1. Refactor [`startDataApiServer()`](./src/server.ts:14) to expose the exit handler separately. One approach — return it from the function:

   ```typescript
   function startDataApiServer(port: number): {
     process: ChildProcess;
     ready: Promise<void>;
   } {
     // ...
     const exitHandler = (code, signal) => {
       /* ... */
     };
     child.on('exit', exitHandler);
     return { process, ready };
   }
   ```

   But this leaks an internal handler. Better approach: use a named function declaration that can be exported for testing:

   ```typescript
   export function createExitHandler(
     stderr: string,
   ): (code: number | null, signal: NodeJS.Signals | null) => void {
     return (code, signal) => {
       /* ... */
     };
   }
   ```

2. Alternatively, refactor the tests to verify behavior rather than implementation:
   - Instead of finding the handler in mock calls, simulate the `exit` event on the mocked process and verify the side effects (e.g., `process.exit` called, stderr logged).
   - Use `vi.mocked(childProcess.on)` if needed, but prefer behavior testing.

3. In the tests, directly emit the `exit` event on the mocked child process:

   ```typescript
   const mockChild = { on: vi.fn(), kill: vi.fn(), stderr: { on: vi.fn() } };
   vi.mocked(spawn).mockReturnValue(mockChild);
   // ...
   // Find and trigger the exit handler
   const exitCall = mockChild.on.mock.calls.find((c) => c[0] === 'exit');
   if (exitCall) exitCall[1](1, null); // Simulate exit code 1
   ```

4. Document the mock boundary pattern used in a test file comment for future developers.

**Acceptance criteria:**

- [ ] No test relies on `.mock.calls.find(...)` to locate event handlers
- [ ] Exit handler behavior is tested via event emission on mocks
- [ ] Tests continue to pass if additional `.on()` calls are added to `startDataApiServer()`
- [ ] `npm run test` passes

---

## MED-002 — Strengthen ESLint Rules

**Affected file:** [`eslint.config.mjs:8-11`](./eslint.config.mjs:8)

**Problem description:**
Only two custom rules are configured beyond the recommended presets: `@typescript-eslint/no-unused-vars` (warn) and `@typescript-eslint/no-explicit-any` (warn). Missing important rules for a production TypeScript project:

- `@typescript-eslint/no-floating-promises` — unhandled promise rejections that could cause silent failures
- `@typescript-eslint/await-thenable` — awaiting values that are not promises
- `@typescript-eslint/no-misused-promises` — promises used in positions expecting non-promise values (e.g., `if (promise)`)
- `no-console` — prevents accidental `console.log` usage (currently used in [`server.ts:161`](./src/server.ts:161))

**Risk/impact:** LOW-MEDIUM — Missing lint rules allow common async bugs to slip through. The `console.error` in `main().catch()` is a specific example where structured logging should be used instead.

**Detailed steps to fix:**

1. Add the missing rules to [`eslint.config.mjs:8-11`](./eslint.config.mjs:8):

   ```javascript
   rules: {
     '@typescript-eslint/no-unused-vars': 'warn',
     '@typescript-eslint/no-explicit-any': 'warn',
     '@typescript-eslint/no-floating-promises': 'error',
     '@typescript-eslint/await-thenable': 'error',
     '@typescript-eslint/no-misused-promises': 'error',
     'no-console': 'warn',
   },
   ```

2. Fix the `console.error` call in [`server.ts:161`](./src/server.ts:161). Since the logger isn't available in the top-level `main().catch()`, either:
   - Initialize a minimal logger before `main()`:
     ```typescript
     import { pino } from 'pino';
     const bootstrapLogger = pino();
     main().catch((error) => {
       bootstrapLogger.fatal({ err: error }, 'Fatal error');
       process.exit(1);
     });
     ```
   - Or use `process.stderr.write()` with a structured JSON format consistent with Pino output.

3. Run `npm run lint` and fix any new violations. Address all errors; evaluate warnings case-by-case.

4. Consider making `no-console` an `"error"` instead of `"warn"` to prevent future regressions.

**Acceptance criteria:**

- [ ] `no-floating-promises`, `await-thenable`, `no-misused-promises` are enforced as errors
- [ ] `no-console` is enforced (warn or error)
- [ ] `console.error` is replaced with structured logging in `server.ts:161`
- [ ] `npm run lint` passes without violations

---

## MED-003 — Consume or Ignore Server Stdout Stream

**Affected file:** [`src/server.ts:18-19`](./src/server.ts:18)

**Problem description:**
[`spawn()`](./src/server.ts:18) is called with `stdio: ["ignore", "pipe", "pipe"]`, piping both stdout and stderr. While stderr is collected and logged (lines 23-26), stdout is never consumed. If the Joplin CLI process writes substantial data to stdout, Node.js's internal stream buffer (default 1MB highWaterMark for pipes) could fill up, causing backpressure that might hang or crash the child process.

```typescript
const child = spawn("joplin", ["server", "start", ...], {
  stdio: ["ignore", "pipe", "pipe"],
});
// stderr IS consumed:
child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
// stdout is NOT consumed anywhere
```

**Risk/impact:** LOW-MEDIUM — Unlikely in normal operation (Joplin CLI server mode probably doesn't write much to stdout), but represents a latent resource leak. Under unusual conditions (verbose output, debug mode), this could cause the child process to stall.

**Detailed steps to fix:**

1. **Option A (Recommended):** Consume stdout similarly to stderr, logging it at debug level:

   ```typescript
   let stdout = '';
   child.stdout?.on('data', (data: Buffer) => {
     stdout += data.toString();
   });
   // On exit or error, log stdout at debug level
   child.on('exit', (code, signal) => {
     if (stdout.length > 0) {
       console.error(`Joplin Data API stdout (${stdout.length} bytes): ${stdout.slice(0, 1000)}`);
     }
     // ... existing stderr logic ...
   });
   ```

2. **Option B:** If stdout is known to be unused, change stdio to `"ignore"` for stdout:

   ```typescript
   stdio: ["ignore", "ignore", "pipe"],
   ```

   This prevents Node.js from allocating a pipe buffer for stdout entirely.

3. Choose Option A unless there is strong evidence that stdout is always empty. The debug-level logging provides diagnostic value for startup issues.

4. Add a test verifying stdout consumption when stdout data is present.

**Acceptance criteria:**

- [ ] stdout is either consumed (with debug logging) or explicitly ignored
- [ ] No backpressure risk from unconsumed stdout pipe
- [ ] `npm run test` passes

---

## MED-004 — Enforce HTTPS for Production URLs

**Affected file:** [`src/config.ts:4`](./src/config.ts:4)

**Problem description:**
The `joplinServerUrl` schema uses `z.string().url()` which accepts both HTTP and HTTPS URLs. For a service syncing with a remote Joplin Server, unencrypted HTTP connections expose authentication tokens and sync data to network interception. While local development may use HTTP, production deployments should enforce HTTPS.

```typescript
joplinServerUrl: z.string().url().describe("JOPLIN_SERVER_URL"),
```

**Risk/impact:** MEDIUM — Credentials and sync data transmitted over HTTP are vulnerable to man-in-the-middle attacks. This is especially concerning for remote Joplin Server instances accessed over the internet.

**Detailed steps to fix:**

1. Add a refinement to enforce HTTPS, with an escape hatch for development:

   ```typescript
   joplinServerUrl: z.string().url().refine(
     (url) => {
       // Allow HTTP for localhost/127.0.0.1 development URLs
       if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
         return true;
       }
       return url.startsWith("https://");
     },
     { message: "JOPLIN_SERVER_URL must use HTTPS for remote servers. Localhost HTTP is allowed for development." }
   ).describe("JOPLIN_SERVER_URL"),
   ```

2. Add tests in [`tests/config.test.ts`](./tests/config.test.ts):
   - HTTPS remote URL: accepted
   - HTTP localhost: accepted
   - HTTP 127.0.0.1: accepted
   - HTTP remote URL: rejected
   - Invalid URL format: rejected

3. Document the HTTPS requirement in README and PROMPT.md.

**Acceptance criteria:**

- [ ] Remote HTTP URLs are rejected by config validation
- [ ] Localhost HTTP URLs are allowed for development
- [ ] Validation error message is clear about the HTTPS requirement
- [ ] `npm run test` passes with new config test cases

---

## MED-005 — Add Pagination Integration Test

**Affected file:** [`tests/data-client.test.ts:16-22`](./tests/data-client.test.ts:16)

**Problem description:**
[`fetchAllPages`](./src/pagination.ts:15) is mocked for all `getAll*` tests in the data client test suite. The integration between [`JoplinDataClient`](./src/data-client.ts) methods (like `getAllNotes()`, `getAllFolders()`, etc.) and the real pagination helper is never tested. If the pagination logic changes (e.g., page numbering, limit calculation, has_more detection), existing tests would not catch regressions.

```typescript
// tests/data-client.test.ts — pagination is always mocked:
vi.mock('../src/pagination.js', () => ({
  fetchAllPages: vi.fn(),
  buildPageParam: vi.fn(),
  clampLimit: vi.fn(),
}));
```

**Risk/impact:** MEDIUM — The pagination helper is a critical integration point. All list methods depend on it, but the contract between the data client and pagination is untested.

**Detailed steps to fix:**

1. Add at least one integration test that uses the real `fetchAllPages` with a mocked `fetch`:

   ```typescript
   it('fetches all pages using real pagination logic', async () => {
     // Mock fetch to return paginated responses
     let callCount = 0;
     global.fetch = vi.fn().mockImplementation(() => {
       callCount++;
       return Promise.resolve({
         ok: true,
         status: 200,
         json: () =>
           Promise.resolve({
             items: [{ id: `note-${callCount}`, title: `Note ${callCount}` }],
             has_more: callCount < 3,
             page: callCount,
           }),
       });
     });

     // Don't mock pagination — use the real module
     const client = new JoplinDataClient(41100, mockLogger);
     const notes = await client.getAllNotes();

     expect(notes).toHaveLength(3);
     expect(fetch).toHaveBeenCalledTimes(3);
   });
   ```

2. Test pagination boundary conditions:
   - Single-page result (has_more: false on first page)
   - Empty result (items: [])
   - Maximum pages limit behavior

3. Consider using a separate test file `tests/pagination-integration.test.ts` for these tests to avoid interfering with the mocked pagination in other tests.

**Acceptance criteria:**

- [ ] At least one test verifies pagination integration with real `fetchAllPages`
- [ ] Pagination boundary conditions are tested (single page, empty, multi-page)
- [ ] `npm run test` passes

---

## MED-006 — Test Config Boundary Values

**Affected file:** [`tests/config.test.ts`](./tests/config.test.ts)

**Problem description:**
The test suite for [`parseConfig()`](./src/config.ts:27) only covers happy-path valid configurations. Missing test coverage for:

- Invalid URL format for `JOPLIN_SERVER_URL`
- Empty strings for `JOPLIN_USERNAME` / `JOPLIN_PASSWORD`
- Port values: 0, -1, non-numeric strings, values above 65535
- Invalid `LOG_LEVEL` values (e.g., `"verbose"`, `"trace"`)
- Missing optional fields (port, logLevel, syncInterval) — verify defaults are applied
- Whitespace-only strings for required fields

**Risk/impact:** LOW-MEDIUM — Missing boundary tests mean config validation regressions could go undetected. Users could deploy with invalid configurations that pass validation incorrectly.

**Detailed steps to fix:**

1. Add parameterized tests for each config field using `describe.each` or `it.each`:

   ```typescript
   describe('JOPLIN_SERVER_URL', () => {
     it.each([
       ['missing', undefined],
       ['empty', ''],
       ['invalid format', 'not-a-url'],
       ['no protocol', 'example.com'],
     ])('rejects %s', (_, value) => {
       process.env.JOPLIN_SERVER_URL = value;
       expect(() => parseConfig()).toThrow();
     });
   });

   describe('JOPLIN_DATA_API_PORT', () => {
     it.each([
       ['zero', '0'],
       ['negative', '-1'],
       ['non-numeric', 'abc'],
       ['float', '41100.5'],
     ])('rejects %s', (_, value) => {
       process.env.JOPLIN_DATA_API_PORT = value;
       // Set required vars
       process.env.JOPLIN_SERVER_URL = 'https://example.com';
       process.env.JOPLIN_USERNAME = 'user';
       process.env.JOPLIN_PASSWORD = 'pass';
       expect(() => parseConfig()).toThrow();
     });
   });
   ```

2. Test default values when optional fields are omitted:

   ```typescript
   it('applies default port when JOPLIN_DATA_API_PORT is missing', () => {
     delete process.env.JOPLIN_DATA_API_PORT;
     const config = parseConfig();
     expect(config.dataApiPort).toBe(41100);
   });
   ```

3. Test `LOG_LEVEL` enum validation (only allows "debug", "info", "warn", "error", "silent").

4. Test `SYNC_INTERVAL_SECONDS` boundary values (0, negative, non-numeric).

**Acceptance criteria:**

- [ ] All config fields have test coverage for invalid/boundary values
- [ ] Default values are verified when optional fields are omitted
- [ ] Parameterized tests cover each config field with multiple invalid inputs
- [ ] `npm run test` passes

---

## MED-007 — Guard Against Multiple Periodic Sync Timers

**Affected file:** [`src/sync-manager.ts:51-68`](./src/sync-manager.ts:58)

**Problem description:**
Calling [`startPeriodicSync()`](./src/sync-manager.ts:51) multiple times creates multiple `setInterval` timers without clearing the previous one. The `timer` property is overwritten, leaking the previous interval handle:

```typescript
startPeriodicSync(): void {
  this.timer = setInterval(() => { ... }, intervalMs);
  this.timer.unref(); // Only the last timer is unref'd
}
```

If `startPeriodicSync()` is called twice, the first timer continues running but can never be stopped by `stopPeriodicSync()` (which only clears `this.timer`, now pointing to the second timer).

**Risk/impact:** MEDIUM — Double-sync could cause resource contention, duplicate sync operations, or unexpected behavior if `startPeriodicSync()` is ever called from multiple code paths. Currently only called once from `main()`, but defensive coding is warranted.

**Detailed steps to fix:**

1. Add a guard at the top of `startPeriodicSync()`:

   ```typescript
   startPeriodicSync(): void {
     if (this.timer) {
       this.logger.warn("Periodic sync already running, ignoring duplicate start");
       return;
     }
     const intervalMs = this.config.syncIntervalSeconds * 1000;
     this.timer = setInterval(() => {
       this.runSync().catch((error) => {
         this.logger.error({ err: error }, "Periodic sync failed");
         this.syncStatus = "error";
       });
     }, intervalMs);
     this.timer.unref();
     this.logger.info({ intervalSeconds: this.config.syncIntervalSeconds }, "Periodic sync started");
   }
   ```

2. Update `stopPeriodicSync()` to clear the timer and null the reference:

   ```typescript
   stopPeriodicSync(): void {
     if (this.timer) {
       clearInterval(this.timer);
       this.timer = null;
       this.logger.info("Periodic sync stopped");
     }
   }
   ```

3. Add tests in [`tests/sync-manager.test.ts`](./tests/sync-manager.test.ts):
   - Calling `startPeriodicSync()` twice creates only one timer
   - Second call logs a warning
   - `stopPeriodicSync()` clears the timer
   - Calling `startPeriodicSync()` after `stopPeriodicSync()` works correctly
   - `unref()` behavior (timer doesn't prevent process exit)

**Acceptance criteria:**

- [ ] Multiple `startPeriodicSync()` calls do not create duplicate timers
- [ ] Warning is logged on duplicate start attempt
- [ ] `stopPeriodicSync()` properly cleans up the timer
- [ ] Timer can be restarted after being stopped
- [ ] `npm run test` passes

---

## MED-008 — Update Sync Status on Periodic Sync Failure

**Affected file:** [`src/sync-manager.ts:58-62`](./src/sync-manager.ts:58)

**Problem description:**
When a periodic sync fails, the error is caught in the `.catch()` handler of the `setInterval` callback. However, the sync status is not updated to `"error"` in the error handling path. The status may remain stuck at `"syncing"` after a failure, providing misleading information to MCP clients querying sync status.

```typescript
this.timer = setInterval(() => {
  this.runSync().catch((error) => {
    this.logger.error({ err: error }, 'Periodic sync failed');
    // Missing: this.syncStatus = "error";
  });
}, intervalMs);
```

**Risk/impact:** LOW-MEDIUM — Incorrect sync status reporting could cause MCP clients to make decisions based on stale information. Not a security issue, but degrades operational visibility.

**Detailed steps to fix:**

1. Set `this.syncStatus = "error"` in the catch handler:

   ```typescript
   this.runSync().catch((error) => {
     this.logger.error({ err: error }, 'Periodic sync failed');
     this.syncStatus = 'error';
   });
   ```

2. Ensure the initial sync status transitions are also correct:
   - `"idle"` → `"syncing"` → `"idle"` (success)
   - `"idle"` → `"syncing"` → `"error"` (failure)
   - `"error"` → `"syncing"` → `"idle"` (recovery on next successful sync)

3. Add tests verifying status transitions:
   - Successful periodic sync transitions: idle → syncing → idle
   - Failed periodic sync transitions: idle → syncing → error
   - Recovery after failure: error → syncing → idle
   - Multiple consecutive failures: status remains error

**Acceptance criteria:**

- [ ] Sync status is set to `"error"` on periodic sync failure
- [ ] Sync status transitions are tested for all paths
- [ ] Status is correctly observable by MCP tools querying sync status
- [ ] `npm run test` passes

---

## MED-009 — Use `Promise.allSettled` in `readMultinote` for Partial Results

**Affected file:** [`src/mcp/tools.ts:60`](./src/mcp/tools.ts:60)

**Problem description:**
[`readMultinote`](./src/mcp/tools.ts:56) uses `Promise.all()` to fetch multiple notes. If any single note fetch fails (e.g., 404 for a deleted note, 403 for a notebook the user lost access to), the entire batch operation fails immediately, discarding all successfully fetched notes:

```typescript
const notes = await Promise.all(input.note_ids.map((id) => ctx.client.getNote(id)));
```

For a batch read operation, partial results are preferable — the user should receive the notes that could be fetched, along with information about which IDs failed.

**Risk/impact:** MEDIUM — Poor UX for batch operations. A single inaccessible note prevents reading all other accessible notes. This is especially problematic for clients that batch-fetch notes from search results.

**Detailed steps to fix:**

1. Replace `Promise.all` with `Promise.allSettled`:

   ```typescript
   const results = await Promise.allSettled(input.note_ids.map((id) => ctx.client.getNote(id)));
   ```

2. Process results to separate successes and failures:

   ```typescript
   const notes: Note[] = [];
   const errors: { id: string; error: string }[] = [];

   results.forEach((result, index) => {
     if (result.status === 'fulfilled') {
       notes.push(result.value);
     } else {
       errors.push({
         id: input.note_ids[index],
         error: result.reason instanceof Error ? result.reason.message : String(result.reason),
       });
     }
   });

   return { notes, errors };
   ```

3. Update the tool's return type to include error information.

4. Update the schema in [`mcp/schemas.ts`](./src/mcp/schemas.ts) if the return shape changes.

5. Add tests:
   - All notes succeed: returns all notes, empty errors array
   - Some notes fail: returns successful notes + error details for failed ones
   - All notes fail: returns empty notes array, all IDs in errors
   - Mixed success/failure with 404, 403, network errors

**Acceptance criteria:**

- [ ] `readMultinote` uses `Promise.allSettled` instead of `Promise.all`
- [ ] Partial results are returned when some fetches fail
- [ ] Error details include which note IDs failed and why
- [ ] `npm run test` passes

---

## MED-010 — Reduce Mock Overuse in Server Tests

**Affected file:** [`tests/server.test.ts`](./tests/server.test.ts)

**Problem description:**
The server test suite mocks 6 modules (`child_process`, `config`, `logger`, `data-client`, `sync-manager`, `tool-registry`). Tests primarily verify mock interaction patterns (e.g., "function X was called with Y") rather than actual behavior. Structural changes to the mocked modules may not break tests even if behavior changes — a classic "testing the mock" anti-pattern.

**Risk/impact:** MEDIUM — Low test confidence. A change that breaks runtime behavior (e.g., wrong argument order, missing error handling) may not be caught by tests if the mocks don't validate arguments precisely.

**Detailed steps to fix:**

1. Audit the current test suite and categorize tests:
   - **Unit tests** (keep heavy mocking): Verify individual function behavior
   - **Integration tests** (reduce mocking): Verify module interactions

2. Add at least one integration test that uses fewer mocks. For example:
   - Only mock `spawn` (child process boundary) and `fetch` (network boundary)
   - Use the real `createLogger`, `ToolRegistry`, and `JoplinDataClient`
   - Test the actual startup sequence with realistic mock data

3. Improve existing mock-based tests:
   - Use stricter argument matchers (`expect.objectContaining`, `expect.stringMatching`)
   - Verify mock calls include the correct number of arguments and correct types
   - Add comments explaining which real behavior each mock replaces

4. Consider a smoke test (in `scripts/smoke-test.sh`) that runs the actual server with a mock Joplin Data API and verifies MCP tool responses.

**Acceptance criteria:**

- [ ] At least one integration test uses ≤3 mocks
- [ ] Mock-based tests use stricter argument validation
- [ ] Test file has documentation explaining the mock strategy
- [ ] `npm run test` passes

---

## MED-011 — Centralize Error Handling Across Layers

**Affected files:**

- [`src/server.ts:161-164`](./src/server.ts:161)
- [`src/mcp/server.ts:38-68`](./src/mcp/server.ts:38)

**Problem description:**
Error handling is inconsistent across the codebase:

1. The top-level `main().catch()` handler in [`server.ts:161`](./src/server.ts:161) uses `console.error` instead of the structured logger:

   ```typescript
   main().catch((error) => {
     console.error('Fatal error:', error);
     process.exit(1);
   });
   ```

2. The MCP server's error handler (lines 38-68) catches `ZodError` and generic errors but the error formatting is manual string interpolation.

3. Other layers (data client, sync manager, CLI executor) each have their own error handling patterns with no shared utility.

**Risk/impact:** MEDIUM — Inconsistent error handling makes debugging harder, produces inconsistent log formats, and increases the risk of sensitive data leaking in error messages (see HIGH-006).

**Detailed steps to fix:**

1. Create a shared error handling utility (`src/error-handler.ts` or extend `src/errors.ts`):

   ```typescript
   export function formatErrorForClient(error: unknown): string {
     if (error instanceof ValidationError) return error.message;
     if (error instanceof NotFoundError) return 'Resource not found';
     if (error instanceof ConflictError) return 'Resource conflict';
     if (error instanceof Error) return 'Internal error';
     return 'Unknown error';
   }

   export function logError(logger: Logger, context: string, error: unknown): void {
     logger.error({ err: error, context }, `${context} failed`);
   }
   ```

2. Fix the top-level error handler to use a bootstrap logger (see MED-002).

3. Standardize the MCP error handler to use the shared formatting utility.

4. Audit all `catch` blocks and ensure:
   - Errors are logged with the structured logger (not `console.error`)
   - Client-facing error messages are sanitized
   - Full error details (stack traces) are available at DEBUG level

**Acceptance criteria:**

- [ ] No `console.error` calls in production code paths
- [ ] Shared error formatting utility exists and is used by all layers
- [ ] Client-facing errors are sanitized; full details logged at DEBUG
- [ ] `npm run test` passes

---

## MED-012 — Test Debug Log-Level Transport Branch

**Affected file:** [`src/logger.ts:13-15`](./src/logger.ts:13)

**Problem description:**
The `pino-pretty` transport configuration branch is conditionally enabled only when `logLevel === "debug"`:

```typescript
transport:
  config.logLevel === "debug"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
```

This branch has zero test coverage. If the transport configuration is broken (e.g., `pino-pretty` is not installed, or the options change incompatibly), it would only be caught manually when someone runs with `LOG_LEVEL=debug`.

**Risk/impact:** LOW — Limited blast radius (only affects debug mode). However, debug mode is critical for troubleshooting production issues, so it should be reliable.

**Detailed steps to fix:**

1. Add a test in [`tests/logger.test.ts`](./tests/logger.test.ts) that verifies:
   - When `logLevel` is `"debug"`, the transport object is configured with `{ target: "pino-pretty", options: { colorize: true } }`
   - When `logLevel` is `"info"` (or other non-debug level), transport is `undefined`

   Use Pino's public API to inspect the logger configuration rather than accessing internals:

   ```typescript
   it('configures pino-pretty transport when logLevel is debug', () => {
     const logger = createLogger({ ...baseConfig, logLevel: 'debug' });
     // Verify by checking that the logger produces pretty-printed output
     // or by inspecting pino's symbol properties for transport config
     expect(logger).toBeDefined();
     // More specific assertions depend on Pino's public introspection API
   });
   ```

2. If Pino doesn't expose transport configuration through its public API, consider testing behavior instead:
   - Write to the logger with debug level
   - Capture stdout (in test)
   - Verify the output format differs from JSON (pretty-printed)

3. Mark the test as integration-level since it tests Pino behavior, not just project code.

**Acceptance criteria:**

- [ ] Debug log-level transport branch is tested
- [ ] Test verifies pino-pretty is configured when logLevel is debug
- [ ] Test verifies transport is undefined for non-debug levels
- [ ] `npm run test` passes
