# 🔴 Critical Tasks

**Severity:** Critical — must be resolved before any production or public-facing deployment.
**Issue count:** 6 ✅ All resolved 2026-06-14
**Source:** [CODEREVIEW.md](./CODEREVIEW.md) sections 1–6

These vulnerabilities affect security, correctness, and test coverage of core application paths. Each task is self-contained with acceptance criteria to verify the fix independently.

---

## ✅ CRIT-001 — Validate User-Supplied IDs to Prevent Path Traversal / Injection — RESOLVED 2026-06-14

**Affected files:**

- [`src/data-client.ts:138,146,149,167,175,178,196,203,208-209,212-213,218-222,242`](./src/data-client.ts:138)
- [`src/mcp/tools.ts:42-47,49-54,56-64,66-71,120-145,147-155,166-173,175-182,188-195,197-204`](./src/mcp/tools.ts:42)

**Problem description:**
Every CRUD method in [`JoplinDataClient`](./src/data-client.ts:28) (`getNote(id)`, `updateNote(id)`, `deleteNote(id)`, `getFolder(id)`, `getTag(id)`, etc.) directly interpolates user-supplied `id` parameters into URL path segments without validation or encoding:

```typescript
// src/data-client.ts:138
async getNote(id: string): Promise<Note> {
  return this.request<Note>("GET", `/notes/${id}`);
}
```

These methods are called from every MCP tool handler in [`src/mcp/tools.ts`](./src/mcp/tools.ts:42) with IDs provided by the MCP client. A malicious or malformed ID like `../../secrets` or `../admin/config` could lead to path traversal, accessing unintended API endpoints.

**Risk/impact:** HIGH — An attacker controlling the MCP client could craft IDs that traverse the URL path, potentially accessing or manipulating resources outside the intended scope. This is a direct injection vector with no mitigating controls.

**Detailed steps to fix:**

1. Create a shared Joplin ID validator in a new or existing utility module. Joplin IDs are 32-character lowercase hexadecimal strings. Define the regex:

   ```typescript
   const JOPLIN_ID_REGEX = /^[0-9a-f]{32}$/;
   ```

2. Create a validation function that either returns the validated ID or throws:

   ```typescript
   export function validateJoplinId(id: string, context: string): string {
     if (!JOPLIN_ID_REGEX.test(id)) {
       throw new ValidationError(`Invalid Joplin ID format in ${context}: ${id}`);
     }
     return id;
   }
   ```

3. In [`JoplinDataClient`](./src/data-client.ts), apply validation at the top of every method that accepts an `id` parameter (`getNote`, `updateNote`, `deleteNote`, `getFolder`, `updateFolder`, `deleteFolder`, `getTag`, `updateTag`, `deleteTag`, `getResource`, `deleteResource`). Example:

   ```typescript
   async getNote(id: string): Promise<Note> {
     const validId = validateJoplinId(id, "getNote");
     return this.request<Note>("GET", `/notes/${validId}`);
   }
   ```

4. As a defense-in-depth measure, also apply `encodeURIComponent()` to the validated ID when constructing the URL path segment.

5. Add unit tests in [`tests/data-client.test.ts`](./tests/data-client.test.ts) verifying:
   - Valid 32-char hex IDs are accepted
   - IDs with path traversal patterns (`../`, `..\\`, `/etc/passwd`, null bytes) are rejected
   - IDs with wrong length, uppercase, or non-hex characters are rejected

**Acceptance criteria:**

- [x] `validateJoplinId()` utility exists and is tested independently
- [x] All ID-accepting methods in `JoplinDataClient` call the validator before URL construction
- [x] Path traversal payloads are rejected with a descriptive error
- [x] Existing tests continue to pass (update any tests using mock IDs to use valid 32-char hex format)
- [x] `npm run test` passes with no regressions

---

## ✅ CRIT-002 — Validate CLI Executor Arguments to Prevent Command Injection — RESOLVED 2026-06-14

**Affected file:** [`src/cli-executor.ts:27-40`](./src/cli-executor.ts:27)

**Problem description:**
The [`exec()`](./src/cli-executor.ts:26) method accepts an `args` array and passes it directly to `execFile("joplin", args, ...)`. While `execFile` mitigates shell injection compared to `exec()`, there is no validation of argument contents. If user input ever reaches this method through any code path (current or future), it could enable argument injection — passing unexpected flags, subcommands, or values to the Joplin CLI:

```typescript
async exec(args: string[], timeoutMs: number = 60_000): Promise<CliResult> {
  const cmd = ["joplin", ...args];
  // ...
  const { stdout, stderr } = await execFileAsync("joplin", args, { ... });
}
```

**Risk/impact:** MEDIUM-HIGH — While no user input currently flows to this method, it represents a latent injection surface. Any future feature that passes user-supplied data through `exec()` would inherit this vulnerability without additional review. Defense-in-depth is warranted for a CLI-wrapping boundary.

**Detailed steps to fix:**

1. Define an allowlist of permitted Joplin CLI subcommands and their valid flags:

   ```typescript
   const ALLOWED_COMMANDS: Record<string, string[]> = {
     sync: [],
     status: [],
     version: [],
   };
   ```

2. Add argument validation at the top of `exec()`:

   ```typescript
   async exec(args: string[], timeoutMs: number = 60_000): Promise<CliResult> {
     // Validate no shell metacharacters in any argument
     for (const arg of args) {
       if (/[;&|`$(){}[\]!#~<>*?\\"' ]/.test(arg)) {
         throw new Error(`Invalid character in CLI argument: ${arg}`);
       }
     }
     // If args[0] is a command, validate it's allowed
     if (args.length > 0 && !ALLOWED_COMMANDS[args[0]]) {
       throw new Error(`Unknown Joplin CLI command: ${args[0]}`);
     }
     // ...
   }
   ```

3. Consider restructuring to use a command-builder pattern where individual methods (`sync()`, `status()`) construct validated argument arrays internally, rather than accepting arbitrary `args`.

4. Add tests in [`tests/cli-executor.test.ts`](./tests/cli-executor.test.ts) verifying:
   - Valid commands/args are accepted
   - Shell metacharacters are rejected
   - Unknown commands are rejected
   - Empty args array is handled

**Acceptance criteria:**

- [x] Argument validation rejects shell metacharacters and unknown subcommands
- [x] Command-builder pattern or allowlist is in place for all CLI invocations
- [x] Test suite covers both allowed and rejected argument scenarios
- [x] `npm run test` passes

---

## ✅ CRIT-003 — Protect Password in Memory Beyond Logger Redaction — RESOLVED 2026-06-14

**Affected file:** [`src/config.ts:6,28-31,55`](./src/config.ts:6)

**Problem description:**
The `joplinPassword` field is stored as a plain string in the `Config` object after parsing from environment variables. While Pino's `redact` feature (in [`logger.ts:4,9-11`](./src/logger.ts:4)) prevents it from appearing in log output, the password value lives in plaintext in process memory for the entire application lifetime. Any code path that accesses `config.joplinPassword` — or any serialization of the config object — could accidentally expose the credential.

```typescript
// config.ts:6
joplinPassword: z.string().min(1).describe("JOPLIN_PASSWORD"),
```

Additionally, the config object is passed to `createLogger()` and logged at debug level in [`server.ts:77`](./src/server.ts:77), which could expose all config fields if the redact configuration is ever accidentally changed or bypassed.

**Risk/impact:** MEDIUM — For a containerized MCP server communicating over stdio, the attack surface for memory inspection is limited. However, if the process is ever debugged, core-dumped, or if config serialization is added in the future, the password would be exposed. This is a defense-in-depth concern.

**Detailed steps to fix:**

1. Create a `Secrets` abstraction that wraps sensitive values:

   ```typescript
   // src/secrets.ts
   const secretSymbol = Symbol('secret');

   export class Secret {
     private [secretSymbol]: string;
     constructor(value: string) {
       this[secretSymbol] = value;
     }
     /** Explicit accessor — discourages accidental logging/serialization */
     reveal(): string {
       return this[secretSymbol];
     }
     /** Prevent JSON serialization */
     toJSON(): string {
       return '***REDACTED***';
     }
   }
   ```

2. Update the `Config` type to use `Secret` for `joplinPassword` and `joplinUsername`:

   ```typescript
   export interface Config {
     joplinPassword: Secret;
     joplinUsername: Secret;
     // ...
   }
   ```

3. In [`parseConfig()`](./src/config.ts:27), wrap the parsed values:

   ```typescript
   return {
     ...result.data,
     joplinPassword: new Secret(result.data.joplinPassword),
     joplinUsername: new Secret(result.data.joplinUsername),
   };
   ```

4. Update all consumers (`JoplinDataClient`, `entrypoint.sh`, etc.) to use `.reveal()` when the raw value is needed for authentication.

5. Evaluate Docker secrets as an alternative to environment variables for production deployments. Document the trade-offs in the README.

6. Update the Pino redact configuration to also cover the `reveal` method name or the Secret class itself.

**Acceptance criteria:**

- [x] Password is no longer stored as a plain string in the `Config` type
- [x] Explicit `.reveal()` call is required to access the raw password value
- [x] `JSON.stringify(config)` does not expose the password (returns `"***REDACTED***"`)
- [x] Logger redaction continues to work correctly
- [x] All tests pass without regressions

---

## ✅ CRIT-004 — Add Direct Test Coverage for `startDataApiServer()` — RESOLVED 2026-06-14

**Affected file:** [`src/server.ts:14-67`](./src/server.ts:14)

**Problem description:**
The [`startDataApiServer()`](./src/server.ts:14) function handles spawning the Joplin CLI process, collecting stderr, and polling the ping endpoint with a 30-attempt retry loop. It is the most complex orchestration function in the codebase, yet it has zero direct test coverage. It is only exercised indirectly through [`main()`](./src/server.ts:69), and all tests mock `spawn`, meaning the stderr collection logic, ping retry mechanism, exit-handler registration, and unexpected-exit handling are never directly verified.

The function contains multiple critical paths:

- Successful ping on first attempt (line 44-48)
- Ping retry loop (lines 41-60)
- Ping exhaustion after `maxAttempts` (lines 53-57)
- Unexpected child process exit (lines 28-34)
- Stderr accumulation (lines 23-26)
- Process kill on exhaustion (line 54)

**Risk/impact:** MEDIUM — A regression in the retry logic, exit handling, or stderr collection could cause silent startup failures or incorrect error reporting. The function cannot be refactored safely without tests.

**Detailed steps to fix:**

1. Extract the ping-polling logic from `startDataApiServer()` into a separate `waitForPing()` helper function that takes a `fetch` function and `maxAttempts` as parameters. This enables testing the retry logic without mocking `spawn`:

   ```typescript
   async function waitForPing(
     fetchFn: typeof fetch,
     port: number,
     maxAttempts: number,
     onAttempt: () => void,
   ): Promise<void> {
     /* ... */
   }
   ```

2. Add a dedicated `describe('startDataApiServer')` block in [`tests/server.test.ts`](./tests/server.test.ts) with tests for:
   - **Successful ping on first attempt:** Mock `spawn` to return a process, mock `fetch` to return 200 OK immediately, verify `ready` resolves.
   - **Ping retry with eventual success:** Mock `fetch` to fail 3 times then succeed, verify `ready` resolves after the correct number of attempts.
   - **Ping exhaustion:** Mock `fetch` to always fail, verify `ready` rejects with the expected error message containing `maxAttempts`, verify `child.kill()` was called.
   - **Unexpected child process exit:** Emit `exit` with code 1 and no signal, verify `process.exit(1)` is called (or a fatal error is thrown).
   - **Stderr collection:** Write to the stderr stream, emit `exit` with code 1, verify stderr content appears in the error output.
   - **Normal exit on SIGTERM:** Verify exit with SIGTERM does not trigger fatal shutdown.

3. Ensure `process.exit` and `console.error` are mocked in tests to prevent actual process termination.

**Acceptance criteria:**

- [x] `waitForPing()` is independently testable as a pure function
- [x] `describe('startDataApiServer')` test block exists with all 6 scenarios
- [x] Each test verifies the specific behavior without relying on `main()` integration
- [x] `npm run test` passes with the new tests
- [x] Coverage report shows `startDataApiServer` lines are now covered

---

## ✅ CRIT-005 — Remove Coverage Exclusion for `src/mcp/tools.ts` and Add Thresholds — RESOLVED 2026-06-14

**Affected files:**

- [`vitest.config.ts:11`](./vitest.config.ts:11)
- [`src/mcp/tools.ts:1-220`](./src/mcp/tools.ts:1)

**Problem description:**
The file [`src/mcp/tools.ts`](./src/mcp/tools.ts:1) — containing all 16 MCP tool handlers for note/notebook CRUD, tagging, search, and sync — is explicitly excluded from coverage metrics without an explanatory comment. This is the core business logic of the MCP server. Additionally, no coverage thresholds are configured anywhere in [`vitest.config.ts`](./vitest.config.ts), meaning coverage could silently degrade.

```typescript
// vitest.config.ts:11
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts'],
  exclude: ['src/mcp/tools.ts'],  // No comment explaining why
},
```

**Risk/impact:** HIGH — Core business logic (all MCP tool handlers) has no coverage enforcement. A refactoring that silently breaks tool behavior would not be caught by coverage metrics. The exclusion removes accountability for the most user-facing part of the application.

**Detailed steps to fix:**

1. Remove the coverage exclusion for `src/mcp/tools.ts` from [`vitest.config.ts:11`](./vitest.config.ts:11), or if the exclusion is necessary, add a detailed comment explaining why (e.g., "Excluded because tool handlers are tested indirectly through tool-registry integration tests, and direct coverage measurements are misleading due to the handler-factory pattern").

2. Add coverage thresholds to [`vitest.config.ts`](./vitest.config.ts):

   ```typescript
   coverage: {
     provider: 'v8',
     include: ['src/**/*.ts'],
     exclude: ['src/mcp/tools.ts'],  // explain if kept
     thresholds: {
       branches: 80,
       functions: 90,
       lines: 90,
       statements: 90,
     },
   },
   ```

3. If `src/mcp/tools.ts` remains excluded, add smoke tests in [`tests/mcp/tools.test.ts`](./tests/mcp/tools.test.ts) that exercise each tool handler through the `ToolRegistry` (as already done for `list_notebooks`). This ensures the handlers are tested even if excluded from coverage metrics.

4. Run `npm run test:coverage` and verify the thresholds pass. If current coverage is below thresholds, incrementally raise coverage before enforcing the thresholds.

5. Optionally configure a lower threshold specifically for branches (e.g., 70) if 80 is not immediately achievable, with a follow-up task to raise it.

**Acceptance criteria:**

- [x] Either the exclusion is removed OR a clear explanatory comment is added
- [x] Coverage thresholds are configured and enforced in `vitest.config.ts`
- [x] `npm run test:coverage` passes the configured thresholds
- [x] If exclusion is kept, smoke tests exercise all 16 tool handlers through the registry

---

## ✅ CRIT-006 — Resolve Dead `SyncError` Code — RESOLVED 2026-06-14

**Affected file:** [`src/errors.ts:18-26`](./src/errors.ts:18)

**Problem description:**
The [`SyncError`](./src/errors.ts:18) class is defined as a public export with a `cause` property but is never referenced anywhere in the source code and has zero test coverage. This is dead code that:

- Adds unnecessary maintenance surface area (imports, exports, type definitions)
- Creates confusion for developers who encounter it in the public API
- Appears in the module's exported types but serves no purpose

```typescript
export class SyncError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}
```

**Risk/impact:** LOW — Dead code does not directly cause runtime issues, but it adds technical debt, increases the public API surface, and confuses maintenance. Every public export is a contract that must be maintained.

**Detailed steps to fix:**

**Option A (Recommended — Use it):** Integrate `SyncError` into [`sync-manager.ts`](./src/sync-manager.ts) error handling:

1. In `sync-manager.ts`, wrap sync operation errors in `SyncError`:

   ```typescript
   private async runSync(): Promise<void> {
     try {
       // ... sync logic ...
     } catch (error) {
       throw new SyncError("Synchronization failed", error instanceof Error ? error : undefined);
     }
   }
   ```

2. Add corresponding tests in [`tests/sync-manager.test.ts`](./tests/sync-manager.test.ts):
   - Verify `SyncError` is thrown on sync failure
   - Verify `cause` property preserves the original error
   - Verify `instanceof SyncError` works correctly

3. Add a test for `SyncError` in [`tests/errors.test.ts`](./tests/errors.test.ts):
   - Verify `name` is `'SyncError'`
   - Verify `message` is preserved
   - Verify `cause` is preserved
   - Verify `instanceof Error` and `instanceof SyncError`

**Option B (Remove it):** Delete the `SyncError` class and its export from [`src/errors.ts`](./src/errors.ts:18). Remove any imports of `SyncError` (there should be none).

**Acceptance criteria:**

- [x] `SyncError` is either used in sync-manager error handling with tests, or removed entirely
- [x] If removed: `grep -r "SyncError" src/` returns no results (except possibly in comments)
- [x] If used: `SyncError` is tested in both `errors.test.ts` and `sync-manager.test.ts`
- [x] `npm run test` passes
- [x] `npm run build` succeeds without errors
