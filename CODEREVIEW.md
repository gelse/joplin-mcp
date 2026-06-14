# Code Review: joplin-api-mcp

**Repository:** [`joplin-api-mcp`](./package.json:2) · **Version:** 0.1.0 · **Review Date:** 2026-06-13

---

## Executive Summary

This code review analyzes a Node.js/TypeScript MCP (Model Context Protocol) server that provides a Joplin Data API bridge. The project uses Express.js-style patterns, Pino for logging, Zod for validation, Vitest for testing, and Docker for deployment.

**Overall assessment:** The project demonstrates solid engineering foundations — strong TypeScript configuration, clean separation of concerns, comprehensive documentation, and good Docker security practices. The six critical issues identified during review have all been resolved (see ✅ markers below), including security vulnerabilities, test coverage gaps, and dead code removal.

| Severity    | Count |
| ----------- | ----- |
| 🔴 Critical | 6     |
| 🟠 High     | 8     |
| 🟡 Medium   | 12    |
| 🟢 Low      | 14    |
| ℹ️ Info     | 12    |

---

## 🔴 Critical Issues

### 1. Unvalidated User-Supplied IDs Enable Path Traversal / Injection ✅ RESOLVED 2026-06-14

**Files:**

- [`src/data-client.ts:138,146,149,167,175,178,196,203,208-209,212-213,218-222,242`](./src/data-client.ts:138)
- [`src/mcp/tools.ts:42-47,49-54,56-64,66-71,120-145,147-155,166-173,175-182,188-195,197-204`](./src/mcp/tools.ts:42)

**Problem:** Every `getNote(id)`, `updateNote(id)`, `deleteNote(id)`, `getFolder(id)`, `getTag(id)`, etc. method in [`JoplinDataClient`](./src/data-client.ts:28) directly interpolates user-supplied `id` parameters into URL path segments without validation or encoding:

```typescript
// src/data-client.ts:138
async getNote(id: string): Promise<Note> {
  return this.request<Note>("GET", `/notes/${id}`);
}
```

These methods are called from every MCP tool handler in [`src/mcp/tools.ts`](./src/mcp/tools.ts:42) with IDs provided by the MCP client. A malicious or malformed ID like `../../secrets` could lead to path traversal.

**Recommendation:**

- Add a Zod schema or regex validator for Joplin IDs (expected format: 32-character hex strings, e.g., `/^[0-9a-f]{32}$/`)
- Apply the validation in [`JoplinDataClient`](./src/data-client.ts) methods or via a shared helper
- Alternatively, use `encodeURIComponent()` on all interpolated path segments

---

### 2. CLI Executor Accepts Unvalidated Arguments ✅ RESOLVED 2026-06-14

**File:** [`src/cli-executor.ts:27`](./src/cli-executor.ts:27)

**Problem:** The [`exec()`](./src/cli-executor.ts:26) method accepts an `args` array and passes it directly to `execFile("joplin", args, ...)`. While the `args` array mitigates shell injection compared to `exec()`, there is no validation of argument contents. If user input ever reaches this method through the current or future code path, it could enable command injection.

```typescript
async exec(args: string[], timeoutMs: number = 60_000): Promise<CliResult> {
  const cmd = ["joplin", ...args];  // args used directly
  // ...
  const { stdout, stderr } = await execFileAsync("joplin", args, { ... });
}
```

**Recommendation:**

- Add argument validation (reject args containing subcommands, shell metacharacters, or unexpected patterns)
- Consider using a command builder pattern that restricts which flags and values are accepted

---

### 3. Password Stored in Plain Memory in Config Object ✅ RESOLVED 2026-06-14

**File:** [`src/config.ts:6`](./src/config.ts:6)

**Problem:** The `joplinPassword` field is stored as a plain string in the config object after parsing. While Pino's `redact` feature avoids logging it, the value exists in plaintext in memory for the application's lifetime.

**Recommendation:**

- Consider using a `Symbol`-keyed property or a dedicated secrets abstraction that provides controlled access
- For containerized deployments, evaluate Docker secrets support rather than environment variables
- At minimum, ensure the config object is never serialized or exposed beyond the logger

---

### 4. `startDataApiServer()` Has No Direct Test Coverage ✅ RESOLVED 2026-06-14

**File:** [`src/server.ts:14-67`](./src/server.ts:14)

**Problem:** The [`startDataApiServer()`](./src/server.ts:14) function, which handles spawning the Joplin CLI process, collecting stderr, and polling the ping endpoint with a 30-attempt retry loop, is only exercised indirectly through [`main()`](./src/server.ts:69) in tests. All tests mock `spawn`, meaning the stderr collection logic, ping retry mechanism, and unexpected-exit handling are never directly verified.

**Recommendation:** Add a dedicated `describe('startDataApiServer')` test block covering:

- Successful ping on first attempt
- Ping retry with eventual success
- Ping exhaustion (maxAttempts reached)
- Unexpected child process exit
- Stderr collection and formatting

---

### 5. `src/mcp/tools.ts` Excluded from Coverage Without Thresholds ✅ RESOLVED 2026-06-14

**Files:**

- [`vitest.config.ts:11`](./vitest.config.ts:11)
- [`src/mcp/tools.ts:1-220`](./src/mcp/tools.ts:1)

**Problem:** The file [`src/mcp/tools.ts`](./src/mcp/tools.ts:1) — which contains all 16 MCP tool handlers including note/notebook CRUD, tagging, search, and sync — is explicitly excluded from coverage metrics with no explanatory comment. This is the core business logic of the MCP server. Additionally, no coverage thresholds are configured anywhere.

```typescript
// vitest.config.ts
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts'],
  exclude: ['src/mcp/tools.ts'],  // No comment explaining why
},
```

**Recommendation:**

- Remove the exclusion or add a detailed comment explaining the rationale
- Add coverage thresholds: `thresholds: { branches: 80, functions: 90, lines: 90, statements: 90 }`
- Add smoke tests that exercise tool handlers through the registry (as done for `list_notebooks`)

---

### 6. Dead Code: `SyncError` Class — Never Used, Never Tested ✅ RESOLVED 2026-06-14

**File:** [`src/errors.ts:18-26`](./src/errors.ts:18)

**Problem:** The [`SyncError`](./src/errors.ts:18) class is defined as a public export with a `cause` property but is never referenced anywhere in the source code and has zero test coverage. This is dead code that adds unnecessary surface area.

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

**Recommendation:** Either:

- Remove the unused `SyncError` class, or
- Use it in [`sync-manager.ts`](./src/sync-manager.ts) error handling and add corresponding tests

---

## 🟠 High Priority Issues

### 7. Credentials Logged in Plaintext at Startup

**Files:**

- [`entrypoint.sh:37-38`](./entrypoint.sh:37)
- [`src/logger.ts:4`](./src/logger.ts:4)

**Problem:** Two credential exposure vectors exist:

1. The entrypoint script logs `JOPLIN_USERNAME` at INFO level (line 37). `JOPLIN_PASSWORD` is not logged in the current version but was logged on line 38 historically.
2. The Pino logger's redact configuration only covers `joplinPassword` but not `joplinUsername` or `joplinServerUrl` (which could contain embedded credentials).

```bash
# entrypoint.sh:37
log "INFO" "Joplin Username: ${JOPLIN_USERNAME}"
```

```typescript
// src/logger.ts:4
const SECRETS: string[] = ['joplinPassword']; // Doesn't cover username or server URL
```

**Recommendation:**

- Remove the username log line from [`entrypoint.sh`](./entrypoint.sh:37)
- Add `"joplinUsername"` and `"joplinServerUrl"` to the [`SECRETS`](./src/logger.ts:4) array

---

### 8. Joplin CLI Installed Without Version Pinning

**File:** [`Dockerfile:33`](./Dockerfile:33)

**Problem:** `npm install -g pnpm joplin` pulls the latest version of Joplin CLI on every build. This introduces supply chain risk and non-reproducible builds.

**Recommendation:** Pin to a specific version:

```dockerfile
RUN npm install -g "pnpm@9" "joplin@X.Y.Z"
```

---

### 9. Joplin Data API Server Binds to All Network Interfaces

**File:** [`src/server.ts:18`](./src/server.ts:18)

**Problem:** The `spawn` call uses `--host 0.0.0.0`, binding the Joplin Data API server to all network interfaces. Combined with the port exposure in the Docker Compose file, this exposes the Data API to the container network and potentially beyond.

```typescript
const child = spawn("joplin", ["server", "start", "--host", "0.0.0.0", ...]);
```

**Recommendation:** Change to `--host 127.0.0.1` to restrict to localhost, since the MCP server communicates over stdio, not HTTP:

```typescript
const child = spawn("joplin", ["server", "start", "--host", "127.0.0.1", ...]);
```

---

### 10. Docker Compose Port Binding Exposes to All Interfaces

**File:** [`docker-compose.yml:6`](./docker-compose.yml:6)

**Problem:** The port mapping `${JOPLIN_DATA_API_PORT:-41100}:${JOPLIN_DATA_API_PORT:-41100}` defaults to `0.0.0.0:41100`, exposing the service to the host network. Combined with issue #9, the Data API is accessible from other machines on the network.

**Recommendation:** Bind to localhost only:

```yaml
ports:
  - '127.0.0.1:${JOPLIN_DATA_API_PORT:-41100}:${JOPLIN_DATA_API_PORT:-41100}'
```

---

### 11. Authentication Token Stored in Plain Memory Without Expiration Handling

**File:** [`src/data-client.ts:30`](./src/data-client.ts:30)

**Problem:** The `token` property is stored as a plain `string | null` with no encryption or secure storage. The token refresh mechanism (lines 88-94) only re-authenticates on 401 response but has no proactive expiration logic. Between the initial auth and a 401, the token lives in memory indefinitely.

```typescript
private token: string | null = null;
```

**Recommendation:**

- Add token expiration tracking (store expiry timestamp alongside the token)
- Proactively refresh the token before expiration
- Clear the token from memory if it cannot be refreshed

---

### 12. Error Messages Leak Internal API Structure

**Files:**

- [`src/data-client.ts:97-98,101-102`](./src/data-client.ts:97)

**Problem:** Error messages for 404, 409, and 400 responses include the full URL path, which can leak internal API structure to MCP clients:

```typescript
if (response.status === 404) throw new NotFoundError('resource', path); // path like /notes/abc-123
if (response.status === 409) throw new ConflictError('resource', path);
if (response.status === 400) {
  throw new ValidationError(`Bad request: ${path} — ${body}`);
}
```

**Recommendation:** Use sanitized resource identifiers in error messages. Log the full path at DEBUG level and return a generic resource reference to the caller.

---

### 13. MCP Schema String Fields Lack Constraints

**File:** [`src/mcp/schemas.ts:13,22,27,32,37,42,52,59,71,79,84,90,96,101`](./src/mcp/schemas.ts:13)

**Problem:** Multiple string fields (`note_id`, `notebook_id`, `tag_id`, `title`, `body`, `author`, `source_url`) have no length, format, or regex constraints. This could allow excessively large inputs, injection, or malformed data. Additionally, `source_url` fields (lines 46, 65) use `z.string()` instead of `z.string().url()`.

**Recommendation:**

- Add `.max()` constraints to string fields (e.g., `z.string().max(500)` for titles)
- Change `source_url` fields to `z.string().url().optional()`
- Add a Joplin ID validator: `z.string().regex(/^[0-9a-f]{32}$/)` for ID fields
- Apply schema validation in the tool handlers or data client before making API calls

---

### 14. Unsafe Type Assertion Bypasses TypeScript Safety

**File:** [`src/mcp/server.ts:24`](./src/mcp/server.ts:24)

**Problem:** The code uses `(tool.schema._def as any)?.shape ?? {}` to extract the Zod schema shape for the MCP SDK. This bypasses all TypeScript type checking and will silently return `{}` if the internal `_def` structure changes.

```typescript
server.tool(
  tool.name,
  tool.description,
  (tool.schema._def as any)?.shape ?? {},  // unsafe cast
  async (input: unknown) => { ... }
);
```

**Recommendation:** Use Zod's public API instead:

```typescript
import { z } from 'zod';
const shape = tool.schema instanceof z.ZodObject ? tool.schema.shape : {};
```

Or use [`z.input()`](https://github.com/colinhacks/zod#zinput) / type inference patterns.

---

### 15. Tests Use Fragile Mock Introspection for Exit Handler

**File:** [`tests/server.test.ts:185-194,236-245,445-454`](./tests/server.test.ts:185)

**Problem:** Three tests locate the `exitHandler` via `childProcess.on.mock.calls.find(...)` — searching through mock call arrays to find the handler registered via `.on('exit', handler)`. Any change to the order or number of `.on()` calls will silently break these tests.

**Recommendation:** Refactor [`startDataApiServer()`](./src/server.ts:14) to return or expose the exit handler, or use a named function that can be directly tested.

---

## 🟡 Medium Priority Issues

### 16. ESLint Rule Set Is Minimal

**File:** [`eslint.config.mjs:8-11`](./eslint.config.mjs:8)

**Problem:** Only two custom rules are configured beyond the recommended presets: `@typescript-eslint/no-unused-vars` (warn) and `@typescript-eslint/no-explicit-any` (warn). Missing important rules for a production TypeScript project:

- `@typescript-eslint/no-floating-promises` — unhandled promise rejections
- `@typescript-eslint/await-thenable` — awaiting non-promise values
- `@typescript-eslint/no-misused-promises` — promises in wrong positions
- `no-console` — prevents accidental console logging (currently used in [`server.ts:161`](./src/server.ts:161))

**Recommendation:** Add `@typescript-eslint/no-floating-promises: "error"` and `no-console: "warn"` at minimum. Consider fixing the `console.error` call in [`server.ts:161`](./src/server.ts:161) to use the structured logger.

### 17. Server Stdout Stream Not Consumed (Buffer Overflow Risk)

**File:** [`src/server.ts:18-19`](./src/server.ts:18)

**Problem:** [`spawn()`](./src/server.ts:18) is called with `stdio: ["ignore", "pipe", "pipe"]`, piping both stdout and stderr. While stderr is collected (lines 23-26), stdout is never consumed. If the Joplin CLI process writes enough data to stdout, the Node.js internal buffer could fill up, causing backpressure issues or the child process to hang.

**Recommendation:** Consume stdout in the same manner as stderr, or use `"ignore"` for stdout if it is known to be unused.

### 18. URL Validation Does Not Enforce HTTPS

**File:** [`src/config.ts:4`](./src/config.ts:4)

**Problem:** The `joplinServerUrl` Zod schema uses `z.string().url()` which accepts both HTTP and HTTPS. For production deployments syncing with a remote Joplin Server, HTTPS should be enforced.

**Recommendation:** Add a custom refinement:

```typescript
joplinServerUrl: z.string().url().refine(
  (url) => url.startsWith("https://"),
  "JOPLIN_SERVER_URL must use HTTPS in production"
),
```

### 19. Pagination Integration Not Tested

**File:** [`tests/data-client.test.ts:16-22`](./tests/data-client.test.ts:16)

**Problem:** [`fetchAllPages`](./src/pagination.ts:15) is mocked for all `getAll*` tests. The integration between [`JoplinDataClient`](./src/data-client.ts) methods and the real pagination helper is never tested. A change to the pagination logic would not be caught by existing tests.

**Recommendation:** Add at least one integration test using the real `fetchAllPages` with a mocked `fetch`.

### 20. Config Boundary Values Untested

**File:** [`tests/config.test.ts`](./tests/config.test.ts)

**Problem:** The test suite for [`parseConfig()`](./src/config.ts:27) does not cover boundary and invalid values such as:

- Invalid URL format for `JOPLIN_SERVER_URL`
- Empty strings for `JOPLIN_USERNAME` / `JOPLIN_PASSWORD`
- Port values of 0, -1, or non-numeric strings
- Invalid `LOG_LEVEL` values
- Missing optional fields (port, logLevel, syncInterval)

**Recommendation:** Add parameterized tests covering all boundary conditions for each config field.

### 21. Periodic Sync Timer Leak Not Tested

**File:** [`src/sync-manager.ts:58`](./src/sync-manager.ts:58)

**Problem:** Calling [`startPeriodicSync()`](./src/sync-manager.ts:51) multiple times creates multiple `setInterval` timers without clearing the previous one. The `timer` property is overwritten, leaking the previous interval. The `unref()` behavior (line 65-67) is also untested.

**Recommendation:** Add a guard to prevent starting the timer if already running:

```typescript
startPeriodicSync(): void {
  if (this.timer) {
    this.logger.warn("Periodic sync already running, skipping");
    return;
  }
  // ...
}
```

Add tests for multiple calls and timer cleanup on `stopPeriodicSync`.

### 22. Error Status Not Updated on Periodic Sync Failure

**File:** [`src/sync-manager.ts:58-62`](./src/sync-manager.ts:58)

**Problem:** When a periodic sync fails, the error is caught and logged but the internal `runSync` method is called indirectly. However, the error in the `setInterval` callback is caught with `.catch()` which doesn't propagate status updates. The sync status may remain "syncing" rather than being set to "error".

**Recommendation:** Ensure periodic sync failures update the sync status to `"error"`.

### 23. `Promise.all` in `readMultinote` Fails Fast on First Error

**File:** [`src/mcp/tools.ts:60`](./src/mcp/tools.ts:60)

**Problem:** [`readMultinote`](./src/mcp/tools.ts:56) uses `Promise.all()` to fetch multiple notes. If any single note fetch fails, the entire operation fails immediately, discarding all successfully fetched notes. For a batch read operation, partial results are preferable.

**Recommendation:** Use `Promise.allSettled()` and return a result containing both successful notes and error information:

```typescript
const results = await Promise.allSettled(input.note_ids.map((id) => ctx.client.getNote(id)));
```

### 24. Heavy Mocking Reduces Test Confidence

**File:** [`tests/server.test.ts`](./tests/server.test.ts)

**Problem:** The server test suite mocks 6 modules (`child_process`, `config`, `logger`, `data-client`, `sync-manager`, `tool-registry`). Tests primarily verify mock interaction patterns rather than actual behavior. Structural changes to the mocked modules may not break tests even if behavior changes.

**Recommendation:** Add integration tests that use fewer mocks (e.g., only mock `spawn` and the network, use real logger/registry). Consider a smoke test that runs through the actual startup sequence.

### 25. No Centralized Error Handling Boundary

**Files:**

- [`src/server.ts:161-164`](./src/server.ts:161)
- [`src/mcp/server.ts:38-68`](./src/mcp/server.ts:38)

**Problem:** Error handling is inconsistent across the codebase. The top-level `main().catch()` handler in [`server.ts:161`](./src/server.ts:161) uses `console.error` instead of the structured logger. The MCP server's error handler (line 38-68) catches `ZodError` and generic errors but there's no global error boundary pattern.

**Recommendation:** Use the structured logger for the top-level catch handler. Consider adding a centralized error handling utility that formats errors consistently across all layers.

### 26. Debug Log-Level Transport Branch Untested

**File:** [`src/logger.ts:13-15`](./src/logger.ts:13)

**Problem:** The `pino-pretty` transport configuration branch (only active when `logLevel === "debug"`) is never tested. A regression in transport configuration would only be caught manually.

**Recommendation:** Add a test for the debug logLevel branch that verifies transport configuration.

### 27. No Coverage Thresholds Configured

**File:** [`vitest.config.ts`](./vitest.config.ts)

**Problem:** No `thresholds` are configured in the Vitest coverage configuration. Coverage could drop without any automated signal.

**Recommendation:** Add coverage thresholds:

```typescript
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts'],
  // exclude: ['src/mcp/tools.ts'],  -- consider removing
  thresholds: {
    branches: 80,
    functions: 90,
    lines: 90,
    statements: 90,
  },
},
```

---

## 🟢 Low Priority Issues

### 28. Missing Package Metadata

**File:** [`package.json`](./package.json:1)

**Issues:**

- No `license` field (README states MIT, but `package.json` doesn't declare it)
- Missing `author`, `repository`, `keywords`, `bugs`, `homepage`
- No `.nvmrc` or `.node-version` file despite `engines.node >= 22`
- The `lint` script only covers `src/`, not `tests/`

**Recommendation:** Add `"license": "MIT"` to resolve the discrepancy with the README. Add `lint:all` script covering both `src/` and `tests/`.

### 29. `.npmrc` Redundant with `package.json`

**Files:**

- [`.npmrc`](./.npmrc:1)
- [`package.json:36-38`](./package.json:36)

**Problem:** `onlyBuiltDependencies=esbuild` is duplicated in both `.npmrc` and `package.json` under `pnpm.onlyBuiltDependencies`. This creates a maintenance risk.

**Recommendation:** Remove from `.npmrc` and keep only in `package.json` (the canonical location).

### 30. Missing Documentation

**Files:** Multiple

- [`vitest.config.ts:11`](./vitest.config.ts:11) — No comment explaining why `src/mcp/tools.ts` is excluded from coverage
- [`src/api-types.ts:1-181`](./src/api-types.ts:1) — No JSDoc on any interfaces or properties. Complex fields like `is_conflict`, `encryption_applied`, `markup_language` lack documentation
- [`src/errors.ts:1-66`](./src/errors.ts:1) — No JSDoc on any error classes
- [`src/pagination.ts:1-30`](./src/pagination.ts:1) — No JSDoc explaining pagination behavior
- [`src/data-client.ts:119-264`](./src/data-client.ts:119) — Public methods lack JSDoc with parameter and return value documentation
- No test file-level documentation in any of the 12 test files
- README missing `.env.example` reference in its project structure section
- README has no troubleshooting section

**Recommendation:** Add JSDoc to all public APIs. Add file-level documentation to test files. Add a troubleshooting section to README.

### 31. Port Validation Allows Arbitrary Positive Integers

**File:** [`src/config.ts:7-12`](./src/config.ts:7)

**Problem:** The port schema only validates that the value is a positive integer. It should validate the valid port range (1024-65535), since ports below 1024 typically require root privileges.

**Recommendation:** Add `.min(1024).max(65535)` to the port schema.

### 32. `Pagination` Interface Incomplete

**File:** [`src/api-types.ts:112-114`](./src/api-types.ts:112)

**Problem:** The [`Pagination`](./src/api-types.ts:112) interface only has `page` but Joplin's Data API also accepts `limit` as a pagination parameter.

**Recommendation:** Add `limit?: number` to the `Pagination` interface.

### 33. Entrypoint Has No Error Handling for Individual `joplin config` Commands

**File:** [`entrypoint.sh:44-47`](./entrypoint.sh:44)

**Problem:** While `set -euo pipefail` is active, there is no per-command error handling for the `joplin config` commands. If one config command fails, the entire script exits, but the error message may be opaque.

**Recommendation:** Add individual error messages for each config command, e.g.:

```bash
joplin config sync.target 10 || { log "ERROR" "Failed to set sync target"; exit 1; }
```

### 34. Docker Compose Missing `init: true`

**File:** [`docker-compose.yml`](./docker-compose.yml)

**Problem:** Without `init: true`, the Node.js process runs as PID 1 and won't properly handle signals. Zombie processes from the spawned Joplin CLI could accumulate.

**Recommendation:** Add `init: true` to the service definition.

### 35. Docker Compose Missing Resource Limits

**File:** [`docker-compose.yml`](./docker-compose.yml)

**Recommendation:** Add resource limits:

```yaml
deploy:
  resources:
    limits:
      cpus: '0.5'
      memory: 512M
```

### 36. Process Environment Variables Leaked to CLI Child Process

**File:** [`src/cli-executor.ts:34`](./src/cli-executor.ts:34)

**Problem:** `env: { ...process.env, HOME: process.env["HOME"] }` spreads the entire parent process environment into the Joplin CLI child process. This exposes all environment variables (including secrets) to the child process.

**Recommendation:** Use a minimal environment with only the required variables:

```typescript
env: { HOME: process.env["HOME"], PATH: process.env["PATH"] },
```

### 37. Test Suite Improvements

**Files:** Multiple test files

- **All server tests use 10-second timeout** — [`tests/server.test.ts`](./tests/server.test.ts): excessive for unit tests. Remove blanket timeout; set per-test only where needed.
- **Fake timer cleanup fragile** — If a test throws before `afterEach`, `vi.useRealTimers()` may not restore timers.
- **Inconsistent describe block naming** across the 12 test files
- **No shared test utilities** — each test file defines its own mock helpers
- **No CI-specific test configuration** — no `vitest.config.ci.ts` for CI environments
- **`errors.test.ts` tests 6 of 8 error classes** — `SyncError` and `CliError` (from errors.ts) are untested. Tests for basic properties but not `instanceof` checks, stack traces, or cause chains.
- **`logger.test.ts` second describe block** tests `pino` directly instead of through `createLogger()`, testing the library rather than project code
- **`pagination.test.ts`** — `buildPageParam` with page 0 or negative untested; `fetchAllPages` error on second page untested
- **`data-client.test.ts`** — `search` with only query (no type) untested; `getResource` binary/file download behavior not verified
- **`sync-manager.test.ts`** — `unref()` behavior not tested; multiple `startPeriodicSync` calls not tested
- **`cli-executor.test.ts`** — `maxBuffer` and `HOME` env var behavior not tested

### 38. ESLint Ignores Coverage Output

**File:** [`eslint.config.mjs:14`](./eslint.config.mjs:14)

**Problem:** The ignore list includes `dist/**`, `node_modules/**`, and `.pnpm-store/**` but not `coverage/`.

**Recommendation:** Add `'coverage/**'` to the ignore list.

### 39. Polling Uses `setTimeout` Without Exponential Backoff

**File:** [`src/server.ts:59`](./src/server.ts:59)

**Problem:** The ping polling in [`startDataApiServer()`](./src/server.ts:37) uses a fixed 1-second interval for all 30 attempts. For slow-starting containers or network delays, this is wasteful.

**Recommendation:** Consider implementing exponential backoff capped at a reasonable maximum (e.g., 5 seconds).

---

## ℹ️ Positive Findings

### Architecture & Design

- **Clean separation of concerns**: The project is well-organized into `data-client`, `cli-executor`, `sync-manager`, `mcp/`, `errors`, `config` layers with clear responsibilities
- **MCP tool abstraction pattern**: The `ToolRegistry` + `ToolHandler` pattern is clean and extensible. Adding a new tool requires adding a schema, handler, and registration entry
- **Serialized sync execution**: The sync manager's pending-sync queue pattern prevents concurrent sync operations while avoiding lost sync requests
- **Graceful shutdown**: The `SIGTERM`/`SIGINT` handlers properly stop sync, kill the child process, and clean up

### TypeScript Configuration

- **Strict mode**: `strict: true`, `esModuleInterop`, `forceConsistentCasingInFileNames`, `skipLibCheck` — all enabled
- **Proper ESM setup**: `module: "NodeNext"` and `moduleResolution: "NodeNext"` for Node.js 22 ESM
- **Declaration files**: `declaration: true` and `declarationMap: true` enabled
- **Build config separation**: `tsconfig.build.json` properly extends base config and excludes test files

### Docker & Infrastructure

- **Multi-stage build**: Builder stage compiles, runtime stage is minimal
- **Non-root user**: Dedicated `joplin` user with proper ownership
- **Minimal base image**: `node:22-bookworm-slim` with `--no-install-recommends`
- **`.dockerignore`**: Excludes `.env`, `.git`, `node_modules`, `tests`, `docs`, `*.md`
- **`.gitignore`**: Properly excludes secrets, build output, logs
- **Healthcheck**: Docker HEALTHCHECK configured for the ping endpoint
- **`onlyBuiltDependencies`**: pnpm security feature limiting build script execution to `esbuild`

### Testing

- **12 test files** covering most source modules
- **Good test patterns**: Use of `describe.each`, `it.each` for parameterized tests
- **Mock boundary control**: Mocks are mostly at module boundaries (file system, network, child process)
- **Zod validation tests**: Schema validation is thoroughly tested in `schemas.test.ts`

### Documentation

- **Comprehensive README** (204 lines): Architecture diagram, quick start, env vars, sync behavior, 16 MCP tools documented, development commands
- **Excellent PROMPT.md** (314 lines): Technical deep-dive covering architecture, implementation status, file structure, design decisions, testing strategy
- **Inline code comments**: Key design decisions documented (e.g., sync.conflictBehavior removal, serialized sync pattern)

### Security Practices (Implemented Well)

- Pino `redact` configuration for password masking in logs
- `set -euo pipefail` in entrypoint for strict error handling
- Passwordless sudo not used unnecessarily
- Zod schema validation for all environment variables at startup
- Authorization token not logged in request/response logging

---

## Summary Table

> ✅ **All 6 critical issues resolved as of 2026-06-14.**

| Category           | 🔴 Critical | 🟠 High | 🟡 Medium | 🟢 Low | ℹ️ Info |
| ------------------ | :---------: | :-----: | :-------: | :----: | :-----: |
| **Security**       |      3      |    3    |     1     |   1    |    3    |
| **Source Code**    |      1      |    2    |     4     |   4    |    3    |
| **Testing**        |      2      |    2    |     5     |   7    |    0    |
| **Configuration**  |      0      |    1    |     1     |   3    |    4    |
| **Infrastructure** |      0      |    2    |     1     |   3    |    2    |
| **Documentation**  |      0      |    0    |     0     |   2    |    3    |
| **Total**          |    **6**    |  **8**  |  **12**   | **14** | **12**  |

---

_Review compiled from configuration, source code, and test suite analysis reports. All line references verified against the current codebase at commit time._
