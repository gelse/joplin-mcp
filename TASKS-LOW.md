# 🟢 Low Priority Tasks

**Severity:** Low — nice-to-have improvements that enhance developer experience, documentation completeness, and long-term maintainability.
**Issue count:** 14
**Source:** [CODEREVIEW.md](./CODEREVIEW.md) sections 28–39

These issues cover package metadata, documentation gaps, validation tightening, Docker hardening, test suite polish, and minor configuration improvements. None block production use, but addressing them creates a more professional, maintainable project.

---

## LOW-001 — Add Missing Package Metadata

**Affected file:** [`package.json:1`](./package.json:1)

**Problem description:**
Several standard `package.json` fields are missing or incomplete:

- No `license` field — the [README](./README.md) states MIT, but [`package.json`](./package.json:1) doesn't declare it. This is a legal discrepancy; package registries and automated compliance tools rely on the `license` field.
- Missing `author`, `repository`, `keywords`, `bugs`, and `homepage` fields. These improve discoverability on npm and provide clear attribution.
- No `.nvmrc` or `.node-version` file despite [`package.json`](./package.json:1) declaring `engines.node >= 22`. Version managers (nvm, fnm, asdf) can't auto-select the correct Node version.
- The `lint` script only covers `src/`, not `tests/`:
  ```json
  "lint": "eslint src/"
  ```

**Risk/impact:** VERY LOW — No runtime or security impact. Affects only project metadata completeness and developer onboarding.

**Detailed steps to fix:**

1. Add the missing metadata fields to [`package.json`](./package.json:1):

   ```json
   "license": "MIT",
   "author": "Your Name <email@example.com>",
   "repository": {
     "type": "git",
     "url": "https://github.com/your-org/joplin-api-mcp.git"
   },
   "keywords": ["joplin", "mcp", "model-context-protocol", "notes", "api"],
   "bugs": {
     "url": "https://github.com/your-org/joplin-api-mcp/issues"
   },
   "homepage": "https://github.com/your-org/joplin-api-mcp#readme"
   ```

2. Create a [`.nvmrc`](./.nvmrc) file at the project root:

   ```
   22
   ```

3. Add a `lint:all` script to [`package.json`](./package.json:1):
   ```json
   "lint:all": "eslint src/ tests/"
   ```

**Acceptance criteria:**

- [ ] `package.json` includes `license`, `author`, `repository`, `keywords`, `bugs`, and `homepage`
- [ ] `.nvmrc` or `.node-version` exists at project root containing `22`
- [ ] `lint:all` script exists and lints both `src/` and `tests/`
- [ ] `npm run lint:all` passes

---

## LOW-002 — Remove Redundant `.npmrc` Configuration

**Affected files:**

- [`.npmrc:1`](./.npmrc:1)
- [`package.json:36-38`](./package.json:36)

**Problem description:**
The `onlyBuiltDependencies=esbuild` configuration is duplicated in both [`.npmrc`](./.npmrc:1) and [`package.json`](./package.json:36) under `pnpm.onlyBuiltDependencies`. Having two sources of truth creates a maintenance risk — a developer updating one and not the other leads to inconsistent behavior depending on which source pnpm reads.

**Risk/impact:** VERY LOW — No runtime impact. Minor maintenance risk if the two locations diverge.

**Detailed steps to fix:**

1. Remove `onlyBuiltDependencies=esbuild` from [`.npmrc`](./.npmrc:1).
2. Verify the setting remains in [`package.json`](./package.json:36) under `pnpm.onlyBuiltDependencies` (the canonical location for pnpm workspace settings).
3. Run `pnpm install` to confirm esbuild is still the only package allowed to run build scripts.

**Acceptance criteria:**

- [ ] `.npmrc` no longer contains `onlyBuiltDependencies`
- [ ] `package.json` retains `pnpm.onlyBuiltDependencies: ["esbuild"]`
- [ ] `pnpm install` completes without errors

---

## LOW-003 — Add JSDoc Documentation to Public APIs and Test Files

**Affected files:** Multiple

| File                                                     | Issue                                                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/api-types.ts:1-181`](./src/api-types.ts:1)         | No JSDoc on any interfaces or properties. Complex fields like `is_conflict`, `encryption_applied`, `markup_language` lack documentation. |
| [`src/errors.ts:1-66`](./src/errors.ts:1)                | No JSDoc on any error classes.                                                                                                           |
| [`src/pagination.ts:1-30`](./src/pagination.ts:1)        | No JSDoc explaining pagination behavior, `buildPageParam` semantics, or `fetchAllPages` strategy.                                        |
| [`src/data-client.ts:119-264`](./src/data-client.ts:119) | Public methods lack JSDoc with `@param` and `@returns` documentation.                                                                    |
| [`vitest.config.ts:11`](./vitest.config.ts:11)           | No comment explaining why `src/mcp/tools.ts` is excluded from coverage.                                                                  |
| All 12 test files                                        | No file-level documentation describing what each test file covers.                                                                       |
| [`README.md`](./README.md)                               | Missing `.env.example` reference in project structure section; no troubleshooting section.                                               |

**Risk/impact:** VERY LOW — No functional impact. Affects developer onboarding and API usability for consumers of the package.

**Detailed steps to fix:**

1. **`src/api-types.ts`:** Add JSDoc to all exported interfaces and their properties. Example:

   ```typescript
   /** Represents a Joplin note with full metadata. */
   export interface Note {
     /** Unique identifier (32-char hex string). */
     id: string;
     /** Note title. */
     title: string;
     /** Markdown body content. */
     body: string;
     /** Whether this note is a to-do list. */
     is_todo: boolean;
     /** Whether the note has a conflict copy on the sync target. */
     is_conflict: boolean;
     // ...
   }
   ```

2. **`src/errors.ts`:** Add JSDoc to each error class:

   ```typescript
   /** Thrown when the Joplin Data API returns an error response. */
   export class ApiError extends Error {
     constructor(
       /** HTTP status code. */
       public status: number,
       message: string,
     ) {
       super(message);
       this.name = 'ApiError';
     }
   }
   ```

3. **`src/pagination.ts`:** Add JSDoc explaining the pagination strategy:

   ```typescript
   /**
    * Builds a query parameter object for paginated API requests.
    * Returns an empty object when page is 1 (the default), avoiding
    * unnecessary query parameters.
    */
   export function buildPageParam(page: number): Pagination | Record<string, never>;
   ```

4. **`src/data-client.ts`:** Add JSDoc to all public methods with `@param` and `@returns`.

5. **`vitest.config.ts`:** Add a comment at line 11:

   ```typescript
   // Excluded: tools.ts is a thin registration layer; MCP tool schemas
   // and handlers are tested individually in tests/mcp/
   exclude: ['src/mcp/tools.ts'],
   ```

6. **Test files:** Add a brief file-level comment to each test file:

   ```typescript
   /**
    * Tests for JoplinDataClient — covers authentication token management,
    * CRUD operations, search, pagination, and error handling.
    */
   ```

7. **`README.md`:** Add `.env.example` to the project structure diagram. Add a "Troubleshooting" section covering common issues (connection refused, auth failures, Joplin CLI not found).

**Acceptance criteria:**

- [ ] All exported interfaces in `api-types.ts` have JSDoc
- [ ] All error classes in `errors.ts` have JSDoc
- [ ] `pagination.ts` exports have JSDoc
- [ ] All public methods in `data-client.ts` have JSDoc with `@param`/`@returns`
- [ ] `vitest.config.ts` has a comment explaining the coverage exclusion
- [ ] Each test file has a file-level doc comment
- [ ] README includes `.env.example` in project structure and a troubleshooting section

---

## LOW-004 — Tighten Port Validation to Valid Range

**Affected file:** [`src/config.ts:7-12`](./src/config.ts:7)

**Problem description:**
The Zod schema for `dataApiPort` only validates that the value is a positive integer:

```typescript
dataApiPort: z.coerce.number().int().positive(),
```

This allows ports 1–1023, which typically require root privileges on Linux. It also allows ports above 65535, which are invalid. The validation should restrict to the user-space port range 1024–65535.

**Risk/impact:** VERY LOW — Only affects misconfigured deployments. Ports below 1024 would fail at runtime with `EACCES` anyway. The schema should catch this at startup for a clearer error message.

**Detailed steps to fix:**

1. In [`src/config.ts`](./src/config.ts:7), change the port validation:

   ```typescript
   dataApiPort: z.coerce.number().int().min(1024).max(65535),
   ```

2. Add a corresponding test in [`tests/config.test.ts`](./tests/config.test.ts) for boundary values:
   - Port 1023 → should fail
   - Port 1024 → should pass
   - Port 65535 → should pass
   - Port 65536 → should fail

**Acceptance criteria:**

- [ ] Port schema uses `.min(1024).max(65535)`
- [ ] Config tests cover port boundary values (1023, 1024, 65535, 65536)
- [ ] `npm run test` passes

---

## LOW-005 — Add `limit` Field to `Pagination` Interface

**Affected file:** [`src/api-types.ts:112-114`](./src/api-types.ts:112)

**Problem description:**
The [`Pagination`](./src/api-types.ts:112) interface only declares a `page` field:

```typescript
export interface Pagination {
  page?: number;
}
```

Joplin's Data API also accepts a `limit` parameter to control page size. Without it in the interface, TypeScript consumers can't pass `limit` without type errors.

**Risk/impact:** VERY LOW — Workaround exists (type assertion or `as any`). Affects only TypeScript ergonomics for paginated API consumers.

**Detailed steps to fix:**

1. In [`src/api-types.ts`](./src/api-types.ts:112), add the `limit` field:

   ```typescript
   export interface Pagination {
     /** Page number (1-based). Default: 1. */
     page?: number;
     /** Number of items per page. Default: 100. */
     limit?: number;
   }
   ```

2. Verify no type errors in files that use `Pagination` (e.g., [`src/data-client.ts`](./src/data-client.ts)).

**Acceptance criteria:**

- [ ] `Pagination` interface includes `limit?: number`
- [ ] TypeScript compilation passes (`npm run build`)
- [ ] `npm run test` passes

---

## LOW-006 — Add Per-Command Error Handling to Entrypoint

**Affected file:** [`entrypoint.sh:44-47`](./entrypoint.sh:44)

**Problem description:**
The entrypoint script sets `joplin config` values without per-command error handling:

```bash
joplin config sync.target 10
joplin config sync.interval 0
joplin config api.enabled true
joplin config api.port "$DATA_API_PORT"
```

While `set -euo pipefail` is active (line 3), if any single `joplin config` command fails, the script exits immediately. However, the error message is opaque — the user sees only the last command's stderr without knowing which config key failed.

**Risk/impact:** VERY LOW — Affects only startup debugging when Joplin CLI config fails. The script still exits on error; the improvement is clearer error messages.

**Detailed steps to fix:**

1. In [`entrypoint.sh`](./entrypoint.sh:44), wrap each config command with error handling:

   ```bash
   log "INFO" "Configuring Joplin CLI..."
   joplin config sync.target 10 || { log "ERROR" "Failed to set sync.target"; exit 1; }
   joplin config sync.interval 0 || { log "ERROR" "Failed to set sync.interval"; exit 1; }
   joplin config api.enabled true || { log "ERROR" "Failed to set api.enabled"; exit 1; }
   joplin config api.port "$DATA_API_PORT" || { log "ERROR" "Failed to set api.port to $DATA_API_PORT"; exit 1; }
   ```

2. Verify the `log` function is defined before these commands (it is, at line 6).

**Acceptance criteria:**

- [ ] Each `joplin config` command has a `|| { log "ERROR" "..."; exit 1; }` guard
- [ ] Error messages identify which config key failed
- [ ] Docker build and smoke test succeed

---

## LOW-007 — Add `init: true` to Docker Compose Service

**Affected file:** [`docker-compose.yml`](./docker-compose.yml)

**Problem description:**
The service definition lacks `init: true`. Without an init process (like `tini`), the Node.js process runs as PID 1 inside the container. PID 1 has special responsibilities:

- It must reap zombie processes. The spawned Joplin CLI child process (`/usr/local/bin/joplin`) could become a zombie if not properly waited on.
- Signal handling differs for PID 1 — signals like SIGTERM may not propagate correctly.

Adding `init: true` runs the container with a minimal init process that handles signal forwarding and zombie reaping.

**Risk/impact:** VERY LOW — The current code does call `child.kill()` in the shutdown handler. However, if the Joplin CLI process exits abnormally between checks, it could become a zombie. The init process is a defense-in-depth measure.

**Detailed steps to fix:**

1. In [`docker-compose.yml`](./docker-compose.yml), add `init: true` to the service:
   ```yaml
   services:
     joplin-api-mcp:
       build: .
       init: true
       # ... rest of config
   ```

**Acceptance criteria:**

- [ ] `docker-compose.yml` service includes `init: true`
- [ ] `docker compose up` starts successfully
- [ ] Container shows PID 1 as `/sbin/docker-init` (or similar) instead of `node`

---

## LOW-008 — Add Resource Limits to Docker Compose

**Affected file:** [`docker-compose.yml`](./docker-compose.yml)

**Problem description:**
The service has no CPU or memory limits. In a shared Docker host environment, a runaway process (e.g., Joplin CLI consuming excessive memory during a large sync) could impact other containers. Resource limits provide a safety boundary.

**Risk/impact:** VERY LOW — Only relevant in resource-constrained multi-service Docker hosts. No impact on single-service deployments.

**Detailed steps to fix:**

1. In [`docker-compose.yml`](./docker-compose.yml), add a `deploy` section with resource limits:

   ```yaml
   services:
     joplin-api-mcp:
       build: .
       init: true
       deploy:
         resources:
           limits:
             cpus: '0.5'
             memory: 512M
       # ... rest of config
   ```

2. Note: `deploy.resources` is only enforced in Swarm mode by default. For `docker compose` (non-Swarm), add `mem_limit` and `cpus` at the service level for broader compatibility:
   ```yaml
   services:
     joplin-api-mcp:
       # ...
       deploy:
         resources:
           limits:
             cpus: '0.5'
             memory: 512M
       mem_limit: 512m
       cpus: 0.5
   ```

**Acceptance criteria:**

- [ ] `docker-compose.yml` includes resource limits (CPU and memory)
- [ ] `docker compose up` starts successfully with limits applied
- [ ] `docker stats` shows the configured limits

---

## LOW-009 — Minimize Environment Variables Passed to CLI Child Process

**Affected file:** [`src/cli-executor.ts:34`](./src/cli-executor.ts:34)

**Problem description:**
The Joplin CLI executor spreads the entire parent process environment into the child process:

```typescript
env: { ...process.env, HOME: process.env["HOME"] },
```

This exposes all environment variables — including `JOPLIN_PASSWORD`, `API_TOKEN`, and any other secrets present in the container's environment — to the Joplin CLI child process. While the CLI is trusted code, this violates the principle of least privilege. The child process only needs `HOME` (for config file location) and `PATH` (to locate binaries).

**Risk/impact:** LOW — The CLI process is trusted (same container), but unnecessary environment exposure is a bad security practice. If the CLI were ever compromised or replaced, it would have access to all secrets.

**Detailed steps to fix:**

1. In [`src/cli-executor.ts`](./src/cli-executor.ts:34), replace the spread with an explicit allowlist:

   ```typescript
   env: {
     HOME: process.env["HOME"],
     PATH: process.env["PATH"],
   },
   ```

2. Verify that the Joplin CLI still functions correctly — it needs `HOME` to find its config directory (`~/.config/joplin`).

3. Add a test in [`tests/cli-executor.test.ts`](./tests/cli-executor.test.ts) to verify that only `HOME` and `PATH` are passed to the child process.

**Acceptance criteria:**

- [ ] CLI executor only passes `HOME` and `PATH` to child process
- [ ] No `...process.env` spread in the `env` option
- [ ] Joplin CLI commands still work (smoke test passes)
- [ ] Test verifies the restricted environment

---

## LOW-010 — Polish Test Infrastructure (Timeouts, Timers, Naming, Utilities, CI)

**Affected files:** Multiple test files

**Problem description:**
Several test infrastructure issues reduce developer experience and test reliability:

1. **All server tests use 10-second blanket timeout** ([`tests/server.test.ts`](./tests/server.test.ts)) — `vitest.setConfig({ testTimeout: 10_000 })` at the file level is excessive for unit tests. Individual tests that actually need longer timeouts should declare them explicitly.

2. **Fake timer cleanup is fragile** — If a test using `vi.useFakeTimers()` throws before the `afterEach` hook runs, `vi.useRealTimers()` is never called, and all subsequent tests run with fake timers, causing confusing failures.

3. **Inconsistent `describe` block naming** across the 12 test files — some use the module name, others use descriptive phrases, with no consistent convention.

4. **No shared test utilities** — each test file defines its own mock helpers (e.g., mock config factories, mock child process factories). Common patterns are duplicated across files.

5. **No CI-specific test configuration** — no `vitest.config.ci.ts` for CI environments that might need different settings (e.g., reporters, timeout multipliers).

**Risk/impact:** VERY LOW — No production impact. Affects developer productivity and test reliability during development.

**Detailed steps to fix:**

1. **Remove blanket timeout:** In [`tests/server.test.ts`](./tests/server.test.ts), remove `vitest.setConfig({ testTimeout: 10_000 })`. Add `{ timeout: 10_000 }` only to the specific tests that need it (typically integration-style tests that spawn processes).

2. **Harden fake timer cleanup:** Use a try/finally pattern or a test helper:

   ```typescript
   // tests/helpers/timers.ts
   export function withFakeTimers() {
     beforeEach(() => vi.useFakeTimers());
     afterEach(() => vi.useRealTimers());
   }
   ```

   Or use Vitest's `vi.useFakeTimers()` inside individual tests with proper cleanup.

3. **Standardize describe naming:** Adopt a convention — e.g., describe blocks name the module/function under test:

   ```typescript
   describe('JoplinDataClient', () => { ... });
   describe('createLogger', () => { ... });
   describe('buildPageParam', () => { ... });
   ```

4. **Create shared test utilities:** Extract common mock factories into a `tests/helpers/` directory:

   ```typescript
   // tests/helpers/mocks.ts
   export function createMockConfig(overrides?: Partial<Config>): Config { ... }
   export function createMockChildProcess(): ChildProcess { ... }
   export function createMockFetch(response?: Partial<Response>): typeof fetch { ... }
   ```

5. **Add CI test config:** Create [`vitest.config.ci.ts`](./vitest.config.ci.ts):

   ```typescript
   import { defineConfig, mergeConfig } from 'vitest/config';
   import baseConfig from './vitest.config';

   export default mergeConfig(
     baseConfig,
     defineConfig({
       test: {
         reporters: ['default', 'junit'],
         outputFile: 'test-results.xml',
       },
     }),
   );
   ```

**Acceptance criteria:**

- [ ] No blanket `testTimeout` in `server.test.ts`
- [ ] Fake timer cleanup is robust (survives test failures)
- [ ] Describe blocks follow a consistent naming convention
- [ ] Shared test utilities exist in `tests/helpers/`
- [ ] `vitest.config.ci.ts` exists for CI environments
- [ ] `npm run test` passes

---

## LOW-011 — Add Missing Test Coverage for Error Classes, Logger, Pagination, and Data Client

**Affected files:**

- [`tests/errors.test.ts`](./tests/errors.test.ts)
- [`tests/logger.test.ts`](./tests/logger.test.ts)
- [`tests/pagination.test.ts`](./tests/pagination.test.ts)
- [`tests/data-client.test.ts`](./tests/data-client.test.ts)

**Problem description:**
Several test files have gaps in coverage:

1. **`errors.test.ts`** tests 6 of 8 error classes. `SyncError` and `CliError` are untested. Additionally, tests only check basic properties (name, message) but not `instanceof` checks, stack traces, or error cause chains.

2. **`logger.test.ts`** second describe block tests `pino` directly (the library) instead of testing through [`createLogger()`](./src/logger.ts:6). This tests pino's behavior rather than project code.

3. **`pagination.test.ts`** — `buildPageParam` with page 0 or negative numbers is untested. `fetchAllPages` error on the second page (after a successful first page) is untested.

4. **`data-client.test.ts`** — `search()` with only a query string (no `type` filter) is untested. `getResource()` binary/file download behavior is not verified.

**Risk/impact:** LOW — These are edge cases and secondary code paths. The core functionality is tested, but coverage gaps could hide bugs in less-common workflows.

**Detailed steps to fix:**

1. **`tests/errors.test.ts`:**
   - Add tests for `SyncError` and `CliError` (name, message, instanceof)
   - Add `instanceof` chain tests: `expect(new ApiError(500, 'msg')).toBeInstanceOf(ApiError)`
   - Test error cause chains where applicable

2. **`tests/logger.test.ts`:**
   - Refactor the second describe block to test through `createLogger()` — instantiate a logger and verify it produces output with the expected level and redaction behavior.

3. **`tests/pagination.test.ts`:**
   - Test `buildPageParam(0)` and `buildPageParam(-1)` — should they throw, or return sensible defaults?
   - Test `fetchAllPages` when page 1 succeeds but page 2 fails — verify proper error propagation.

4. **`tests/data-client.test.ts`:**
   - Test `search({ query: 'hello' })` without the `type` field.
   - Test `getResource()` with a mock binary response to verify proper handling of buffer/file data.

**Acceptance criteria:**

- [ ] `SyncError` and `CliError` are tested
- [ ] Error tests include `instanceof` assertions
- [ ] Logger tests use `createLogger()` rather than testing pino directly
- [ ] `buildPageParam` edge cases (0, negative) are tested
- [ ] `fetchAllPages` error on intermediate page is tested
- [ ] `search()` without `type` is tested
- [ ] `getResource()` binary handling is tested
- [ ] `npm run test` passes

---

## LOW-012 — Add Missing Test Coverage for Sync Manager and CLI Executor

**Affected files:**

- [`tests/sync-manager.test.ts`](./tests/sync-manager.test.ts)
- [`tests/cli-executor.test.ts`](./tests/cli-executor.test.ts)

**Problem description:**
Two additional test files have coverage gaps:

1. **`sync-manager.test.ts`** — The `unref()` behavior of the periodic sync timer is not tested. Multiple calls to `startPeriodicSync()` (idempotency / duplicate prevention) are not tested.

2. **`cli-executor.test.ts`** — The `maxBuffer` option (which limits stdout/stderr size) is not tested. The `HOME` environment variable behavior (verifying it's correctly passed) is not tested.

**Risk/impact:** LOW — These are edge cases and defensive behaviors. The primary sync and CLI execution paths are tested.

**Detailed steps to fix:**

1. **`tests/sync-manager.test.ts`:**
   - Test `unref()` behavior: verify that calling `startPeriodicSync()` creates a timer that doesn't prevent the process from exiting. This can be tested by checking that `setInterval` is called and the returned timer has `unref()` called on it.
   - Test multiple `startPeriodicSync()` calls: verify that calling it twice doesn't create duplicate timers or cause multiple concurrent syncs.

   ```typescript
   it('should not create duplicate timers on multiple startPeriodicSync calls', () => {
     manager.startPeriodicSync(60);
     manager.startPeriodicSync(60);
     expect(setInterval).toHaveBeenCalledTimes(1);
   });
   ```

2. **`tests/cli-executor.test.ts`:**
   - Test `maxBuffer`: verify it's passed through to `execFile` and that exceeding it causes an error.
   - Test `HOME` environment variable: verify it's correctly set in the spawn options.
   ```typescript
   it('should pass HOME to child process environment', async () => {
     const origHome = process.env.HOME;
     await executor.execute('version');
     const spawnCall = vi.mocked(execFile).mock.calls[0];
     expect(spawnCall[2]?.env?.HOME).toBe(origHome);
   });
   ```

**Acceptance criteria:**

- [ ] `unref()` behavior of sync timer is tested
- [ ] Multiple `startPeriodicSync()` calls are tested for idempotency
- [ ] `maxBuffer` option is tested in CLI executor
- [ ] `HOME` env var passing is tested in CLI executor
- [ ] `npm run test` passes

---

## LOW-013 — Add `coverage/` to ESLint Ignore List

**Affected file:** [`eslint.config.mjs:14`](./eslint.config.mjs:14)

**Problem description:**
The ESLint ignore list includes `dist/**`, `node_modules/**`, and `.pnpm-store/**` but not `coverage/`. After running tests with coverage, the `coverage/` directory contains generated HTML, JavaScript, and JSON files. ESLint may attempt to lint these generated files, producing noise and slowing down lint runs.

**Risk/impact:** VERY LOW — Only affects lint performance and noise. The generated coverage files would likely pass linting anyway, but they shouldn't be checked.

**Detailed steps to fix:**

1. In [`eslint.config.mjs`](./eslint.config.mjs:14), add `'coverage/**'` to the ignores array:
   ```javascript
   ignores: ['dist/**', 'node_modules/**', '.pnpm-store/**', 'coverage/**'],
   ```

**Acceptance criteria:**

- [ ] `coverage/**` is in the ESLint ignore list
- [ ] `npm run lint` does not check files in `coverage/`

---

## LOW-014 — Implement Exponential Backoff for Ping Polling

**Affected file:** [`src/server.ts:59`](./src/server.ts:59)

**Problem description:**
The ping polling loop in [`startDataApiServer()`](./src/server.ts:37) uses a fixed 1-second interval for all 30 retry attempts:

```typescript
await new Promise((r) => setTimeout(r, 1000));
```

For slow-starting containers or network delays, this is wasteful — it makes 30 rapid attempts when a backoff strategy would be more efficient. Conversely, for very slow starts, 30 seconds (30 × 1s) may not be enough.

Exponential backoff with a cap (e.g., starting at 200ms, doubling each attempt, capped at 5 seconds) would probe quickly at first and then patiently for slow starts.

**Risk/impact:** VERY LOW — The current fixed-interval polling works in practice for typical Joplin CLI startup times (1–3 seconds). Backoff is an optimization for edge cases and a best practice.

**Detailed steps to fix:**

1. In [`src/server.ts`](./src/server.ts:59), replace the fixed delay with exponential backoff:

   ```typescript
   const BASE_DELAY_MS = 200;
   const MAX_DELAY_MS = 5000;

   const check = async (attempt: number = 0): Promise<void> => {
     if (attempt >= MAX_RETRIES) {
       clearInterval(interval);
       reject(new Error(`Data API server did not become ready within ${MAX_RETRIES} attempts`));
       return;
     }
     try {
       const res = await fetch(`http://127.0.0.1:${port}/ping`);
       if (res.ok) {
         clearInterval(interval);
         resolve();
       } else {
         scheduleNext(attempt);
       }
     } catch {
       scheduleNext(attempt);
     }
   };

   const scheduleNext = (attempt: number) => {
     const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
     setTimeout(() => check(attempt + 1), delay);
   };
   ```

2. Update [`tests/server.test.ts`](./tests/server.test.ts) to verify the backoff behavior — mock timers and verify that delay increases with each attempt.

**Acceptance criteria:**

- [ ] Ping polling uses exponential backoff with a configurable base delay and max cap
- [ ] First retry is fast (~200ms), later retries are slower (up to 5s)
- [ ] Max retries are still enforced
- [ ] Tests verify backoff timing
- [ ] `npm run test` passes
