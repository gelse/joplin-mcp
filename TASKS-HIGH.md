# 🟠 High Priority Tasks

**Severity:** High — should be resolved before production deployment; some are security-adjacent.
**Issue count:** 8
**Source:** [CODEREVIEW.md](./CODEREVIEW.md) sections 7–14

These issues represent significant security hardening, configuration integrity, and code safety concerns that — while not immediately exploitable in all deployment scenarios — would degrade the security posture if left unaddressed.

---

## HIGH-001 — Remove Plaintext Credential Logging

**Affected files:**

- [`entrypoint.sh:37-38`](./entrypoint.sh:37)
- [`src/logger.ts:4`](./src/logger.ts:4)

**Problem description:**
Two credential exposure vectors exist:

1. The entrypoint script logs `JOPLIN_USERNAME` at INFO level on line 37. While `JOPLIN_PASSWORD` is not logged in the current version, the username itself is sensitive in combination with other data:

   ```bash
   # entrypoint.sh:37
   log "INFO" "Joplin Username: ${JOPLIN_USERNAME}"
   ```

2. The Pino logger's redact configuration in [`logger.ts:4`](./src/logger.ts:4) only covers `joplinPassword` but not `joplinUsername` or `joplinServerUrl` (which could contain embedded credentials). A `console.log(config)` or debug-level dump would expose these values:

   ```typescript
   const SECRETS: string[] = ['joplinPassword']; // Incomplete
   ```

3. In [`server.ts:77`](./src/server.ts:77), the entire config is logged at debug level: `logger.debug({ config }, "Configuration loaded")`. If redact configuration is incorrect, this is a direct leak.

**Risk/impact:** MEDIUM-HIGH — Credential logging is a common source of secrets leakage in CI/CD logs, container logs, and monitoring systems. Username exposure combined with other reconnaissance could facilitate targeted attacks.

**Detailed steps to fix:**

1. **Remove username log from entrypoint:** Delete or comment out line 37 in [`entrypoint.sh`](./entrypoint.sh:37):

   ```bash
   # REMOVED: log "INFO" "Joplin Username: ${JOPLIN_USERNAME}"
   ```

2. **Expand redact configuration:** In [`logger.ts:4`](./src/logger.ts:4), add `joplinUsername` to the `SECRETS` array:

   ```typescript
   const SECRETS: string[] = ['joplinPassword', 'joplinUsername'];
   ```

3. **Audit all config logging:** Search for any `logger.*({ config` or `logger.*({.*config` patterns in the codebase and ensure sensitive fields are redacted. In [`server.ts:77`](./src/server.ts:77), the debug log of config is safe as long as redact paths are correct — verify this.

4. **Consider redacting `joplinServerUrl`** if URLs could contain embedded credentials (e.g., `https://user:pass@host`). Add `"joplinServerUrl"` to `SECRETS` as defense-in-depth.

5. **Add a pre-commit or CI check:** A simple grep for `JOPLIN_USERNAME` or `JOPLIN_PASSWORD` in shell scripts outside of validation logic should fail the build.

**Acceptance criteria:**

- [ ] `JOPLIN_USERNAME` is not logged in `entrypoint.sh`
- [ ] `joplinUsername` is in the Pino `SECRETS` redact array
- [ ] `joplinServerUrl` is evaluated for redaction (decision documented)
- [ ] Running with `LOG_LEVEL=debug` does not expose username or password in output
- [ ] `npm run test` passes

---

## HIGH-002 — Pin Joplin CLI Version in Dockerfile

**Affected file:** [`Dockerfile:33`](./Dockerfile:33)

**Problem description:**
The Dockerfile installs Joplin CLI without version pinning:

```dockerfile
RUN npm install -g pnpm joplin
```

This pulls the latest version of Joplin CLI on every build, introducing:

- **Supply chain risk:** A compromised or buggy upstream release is automatically adopted
- **Non-reproducible builds:** Two builds at different times may produce different images with different Joplin CLI versions
- **Silent behavioral changes:** API changes in the Joplin CLI could break the MCP server without any code change in this repository

**Risk/impact:** MEDIUM — The Joplin CLI is the backbone of this service. An unpinned dependency means every build is a gamble on upstream stability.

**Detailed steps to fix:**

1. Determine the currently working Joplin CLI version:

   ```bash
   docker run --rm node:22-bookworm-slim npm view joplin version
   ```

   Or check which version is currently in use in a running container.

2. Pin both `pnpm` and `joplin` to specific versions in [`Dockerfile:33`](./Dockerfile:33):

   ```dockerfile
   RUN npm install -g "pnpm@9" "joplin@X.Y.Z"
   ```

   Replace `X.Y.Z` with the current stable version.

3. Document the version pinning policy in README or PROMPT.md — explain that upgrades should be intentional and tested.

4. Consider using a `JOIN_CLI_VERSION` build argument for flexibility without sacrificing reproducibility:

   ```dockerfile
   ARG JOPLIN_CLI_VERSION=3.2.5
   RUN npm install -g "pnpm@9" "joplin@${JOPLIN_CLI_VERSION}"
   ```

5. Add a note in the maintenance documentation about the upgrade process: test with the new version, update the Dockerfile pin, and cut a release.

**Acceptance criteria:**

- [ ] `joplin` is pinned to a specific version in the Dockerfile
- [ ] `pnpm` is also pinned (e.g., `pnpm@9`)
- [ ] Build is reproducible — two consecutive builds produce identical Joplin CLI versions
- [ ] Documentation explains the version pinning policy

---

## HIGH-003 — Bind Joplin Data API to Localhost

**Affected file:** [`src/server.ts:18`](./src/server.ts:18)

**Problem description:**
The `spawn` call in [`startDataApiServer()`](./src/server.ts:14) uses `--host 0.0.0.0`, binding the Joplin Data API server to all network interfaces:

```typescript
const child = spawn(
  'joplin',
  ['server', 'start', '--host', '0.0.0.0', '--port', String(port), '--no-open'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
```

Since the MCP server communicates with the Data API over localhost (`http://127.0.0.1:${port}/ping` on line 44, and the `JoplinDataClient` connects to `127.0.0.1`), there is no reason to bind to all interfaces. Combined with the Docker port exposure (see HIGH-004), this makes the Data API accessible from the container network and potentially the host network.

**Risk/impact:** MEDIUM — Within a Docker network, other containers could potentially access the Data API if they share the same network. The Data API requires authentication, but defense-in-depth dictates that it should not be network-accessible at all.

**Detailed steps to fix:**

1. Change the `--host` value in [`server.ts:18`](./src/server.ts:18) from `0.0.0.0` to `127.0.0.1`:

   ```typescript
   const child = spawn(
     'joplin',
     ['server', 'start', '--host', '127.0.0.1', '--port', String(port), '--no-open'],
     {
       stdio: ['ignore', 'pipe', 'pipe'],
     },
   );
   ```

2. Verify the ping check on line 44 already uses `127.0.0.1` (it does: `http://127.0.0.1:${port}/ping`). No changes needed there.

3. Verify the `JoplinDataClient` connects to `127.0.0.1` (it does, via `this.baseUrl` construction). No changes needed there.

4. Update any test mocks that may reference `0.0.0.0` to use `127.0.0.1` instead.

5. Document the change and its security rationale in a code comment.

**Acceptance criteria:**

- [ ] Joplin Data API is spawned with `--host 127.0.0.1`
- [ ] Ping check and data client still connect successfully (no connectivity regression)
- [ ] `npm run test` passes
- [ ] Integration/smoke test verifies the Data API is not accessible from external network interfaces

---

## HIGH-004 — Restrict Docker Port Binding to Localhost

**Affected file:** [`docker-compose.yml:6`](./docker-compose.yml:6)

**Problem description:**
The Docker Compose port mapping defaults to exposing the service on all host network interfaces:

```yaml
ports:
  - '${JOPLIN_DATA_API_PORT:-41100}:${JOPLIN_DATA_API_PORT:-41100}'
```

This is equivalent to `0.0.0.0:41100:41100`. Combined with HIGH-003 (Joplin Data API binding to `0.0.0.0`), the Data API is accessible from other machines on the host's network. Even after fixing HIGH-003, the port mapping is unnecessarily permissive.

**Risk/impact:** MEDIUM — Exposing the Data API port to the host network increases the attack surface. While the API requires authentication, network-level access control is a fundamental security layer.

**Detailed steps to fix:**

1. Bind the port mapping to localhost only in [`docker-compose.yml:6`](./docker-compose.yml:6):

   ```yaml
   ports:
     - '127.0.0.1:${JOPLIN_DATA_API_PORT:-41100}:${JOPLIN_DATA_API_PORT:-41100}'
   ```

2. If the port is needed for health checks from other Docker services, use Docker's internal network instead of exposing it on the host:

   ```yaml
   expose:
     - '${JOPLIN_DATA_API_PORT:-41100}'
   ports:
     - '127.0.0.1:${JOPLIN_DATA_API_PORT:-41100}:${JOPLIN_DATA_API_PORT:-41100}'
   ```

3. Consider whether the port needs to be exposed at all. Since the MCP server communicates over stdio with the host, and the Data API is only used internally by the container, the port mapping could potentially be removed entirely. Verify whether the HEALTHCHECK in the Dockerfile or any external monitoring depends on the exposed port.

4. Document the decision in a comment in `docker-compose.yml`.

**Acceptance criteria:**

- [ ] Port mapping is restricted to `127.0.0.1` on the host side
- [ ] HEALTHCHECK continues to work (runs inside the container, not through port mapping)
- [ ] Service is not accessible from other machines on the network
- [ ] `docker compose up` succeeds with the new configuration

---

## HIGH-005 — Add Token Expiration Tracking and Proactive Refresh

**Affected file:** [`src/data-client.ts:30,88-94`](./src/data-client.ts:30)

**Problem description:**
The authentication token in [`JoplinDataClient`](./src/data-client.ts) is stored as a plain `string | null` with no expiration tracking:

```typescript
private token: string | null = null;
```

The token refresh mechanism (lines 88-94) only re-authenticates on a 401 response. Between the initial auth and a 401, the token sits in memory indefinitely. If the token has a server-side expiration (common for Joplin Server tokens), the client will continue using an expired token until a 401 is encountered, causing unnecessary failed requests.

**Risk/impact:** LOW-MEDIUM — Unnecessary 401 responses create noise in logs and add latency (one failed request per token expiry cycle). If the server changes its 401 behavior or if the token is revoked without a 401 response, the client could enter a broken state.

**Detailed steps to fix:**

1. Update the token storage to include expiration tracking:

   ```typescript
   private token: string | null = null;
   private tokenExpiresAt: number | null = null;
   ```

2. When authenticating, capture the token and calculate an expiry. If the Joplin API returns an `expires_in` field, use it. Otherwise, apply a conservative default (e.g., 55 minutes for a typical 1-hour token):

   ```typescript
   private async authenticate(): Promise<string> {
     // ... existing auth logic ...
     const token = /* parse from response */;
     this.token = token;
     this.tokenExpiresAt = Date.now() + (expiresInSeconds ?? 3300) * 1000; // default 55 min
     return token;
   }
   ```

3. Add a `getToken()` method that checks expiration before returning:

   ```typescript
   private async getToken(): Promise<string> {
     if (this.token && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt - 60_000) {
       return this.token; // valid with 1-minute buffer
     }
     return this.authenticate();
   }
   ```

4. Update `request()` to call `getToken()` instead of directly checking `this.token`.

5. Clear the token on logout or when refresh fails:

   ```typescript
   private clearToken(): void {
     this.token = null;
     this.tokenExpiresAt = null;
   }
   ```

6. Add tests in [`tests/data-client.test.ts`](./tests/data-client.test.ts):
   - Token is refreshed proactively when within 1 minute of expiry
   - Token is not refreshed when still valid
   - Token is cleared when refresh fails
   - Multiple concurrent requests share the same token refresh

**Acceptance criteria:**

- [ ] Token includes expiration tracking (`tokenExpiresAt`)
- [ ] Token is proactively refreshed before expiry
- [ ] Expired/revoked tokens are cleared from memory
- [ ] Tests cover token lifecycle (acquisition, valid use, proactive refresh, expiry, clearance)
- [ ] `npm run test` passes

---

## HIGH-006 — Sanitize Error Messages to Prevent API Structure Leakage

**Affected files:** [`src/data-client.ts:97-98,101-102`](./src/data-client.ts:97)

**Problem description:**
Error messages for 404, 409, and 400 HTTP responses include the full URL path, leaking internal API structure to MCP clients:

```typescript
if (response.status === 404) throw new NotFoundError('resource', path);
// path contains values like "/notes/some-id-123" exposing the internal API route structure
if (response.status === 409) throw new ConflictError('resource', path);
if (response.status === 400) {
  throw new ValidationError(`Bad request: ${path} — ${body}`);
  // Response body may also contain internal server details
}
```

These errors propagate through MCP tool handlers and are returned to the MCP client, giving attackers information about API routing, resource ID formats, and potentially server internals from the response body.

**Risk/impact:** MEDIUM — Information disclosure through error messages is a common reconnaissance vector. An attacker can map the internal API structure by observing error responses to crafted requests.

**Detailed steps to fix:**

1. Modify error construction in [`data-client.ts`](./src/data-client.ts) to sanitize the path:

   ```typescript
   if (response.status === 404) {
     // Extract resource type from path without exposing full path
     const resourceType = path.split('/')[1] || 'resource'; // e.g., "notes" from "/notes/abc123"
     throw new NotFoundError('resource', resourceType); // Only expose type, not full path
   }
   if (response.status === 409) {
     throw new ConflictError('resource', 'resource');
   }
   if (response.status === 400) {
     throw new ValidationError('Bad request');
   }
   ```

2. Log the full path and body at DEBUG level for debugging purposes:

   ```typescript
   this.logger.debug({ status, path, body }, 'Request failed');
   ```

3. Update the error classes in [`errors.ts`](./src/errors.ts) if needed to support separate message-for-user and detail-for-logs properties.

4. Verify that [`mcp/server.ts:38-68`](./src/mcp/server.ts:38) error handler does not inadvertently expose internal details through the MCP error response. The current handler already wraps errors in a generic format — confirm this is sufficient.

5. Add tests verifying that error messages returned to the client do not contain URL paths, IDs, or response bodies.

**Acceptance criteria:**

- [ ] Error messages exposed to MCP clients do not contain raw URL paths
- [ ] Full request details are logged at DEBUG level for diagnostics
- [ ] Error response format is consistent and does not leak internal structure
- [ ] `npm run test` passes
- [ ] Manual review of error responses confirms sanitization

---

## HIGH-007 — Add Constraints to MCP Schema String Fields

**Affected file:** [`src/mcp/schemas.ts:13,22,27,32,37,42,52,59,71,79,84,90,96,101`](./src/mcp/schemas.ts:13)

**Problem description:**
Multiple Zod schema string fields lack validation constraints:

- ID fields (`note_id`, `notebook_id`, `tag_id`): No regex pattern, allowing arbitrary strings where 32-char hex is expected
- Content fields (`title`, `body`, `author`): No `.max()` length constraint, allowing excessively large inputs that could cause memory issues
- URL fields (`source_url` on lines 46, 65): Use `z.string()` instead of `z.string().url()`, allowing non-URL values
- Missing format/pattern constraints on all string fields

This allows malicious or malformed MCP client inputs to pass schema validation and reach the data client layer, where they may cause unexpected behavior or errors.

**Risk/impact:** MEDIUM — While CRIT-001 addresses path traversal at the data client layer, adding constraints at the schema layer provides defense-in-depth. Unconstrained fields also degrade the MCP client experience by providing no input validation guidance.

**Detailed steps to fix:**

1. Create a shared Joplin ID regex validator (can be reused from CRIT-001):

   ```typescript
   const joplinId = z.string().regex(/^[0-9a-f]{32}$/, 'Expected 32-character hex ID');
   ```

2. Apply constraints to all ID fields:

   ```typescript
   // Before: note_id: z.string().optional()
   // After:
   note_id: joplinId.optional();
   notebook_id: joplinId.optional();
   tag_id: joplinId.optional();
   ```

3. Add `.max()` to content fields:

   ```typescript
   title: z.string().min(1).max(500);
   body: z.string().max(1_000_000); // 1MB text body
   author: z.string().max(200);
   ```

4. Change `source_url` fields to use URL validation:

   ```typescript
   // Before: source_url: z.string().optional()
   // After:
   source_url: z.string().url().optional();
   ```

5. Update test schemas in [`tests/mcp/schemas.test.ts`](./tests/mcp/schemas.test.ts) to validate the new constraints:
   - Valid and invalid IDs (wrong length, non-hex chars)
   - Strings exceeding max length
   - Invalid URL formats

6. Update the `ToolContext` interface in [`mcp/tools.ts`](./src/mcp/tools.ts) if schema changes affect tool signatures.

**Acceptance criteria:**

- [ ] ID fields validated with 32-char hex regex
- [ ] Content fields have `.max()` constraints
- [ ] `source_url` fields validated as actual URLs
- [ ] Schema validation rejects oversized/invalid inputs before they reach the data client
- [ ] `npm run test` passes with updated schema tests

---

## HIGH-008 — Replace Unsafe Type Assertion with Zod Public API

**Affected file:** [`src/mcp/server.ts:24`](./src/mcp/server.ts:24)

**Problem description:**
The code uses an unsafe type assertion to extract the Zod schema shape for the MCP SDK:

```typescript
server.tool(
  tool.name,
  tool.description,
  (tool.schema._def as any)?.shape ?? {},  // unsafe cast
  async (input: unknown) => { ... }
);
```

This bypasses all TypeScript type checking by:

1. Accessing the private `_def` property (underscore-prefixed, indicating internal API)
2. Casting to `any`, which disables type checking entirely
3. Falling back to `{}` silently if the internal structure changes

If Zod changes its internal `_def` structure in a future version, this code will silently produce an empty schema (`{}`), causing all MCP tool input validation to pass regardless of actual input. This would be a critical regression with no compile-time or runtime warning.

**Risk/impact:** MEDIUM-HIGH — A silent failure in schema extraction means all MCP tool inputs would bypass validation. Combined with the lack of tool-level tests (CRIT-005), this could go undetected through CI.

**Detailed steps to fix:**

1. Replace the unsafe assertion with Zod's public API in [`mcp/server.ts:24`](./src/mcp/server.ts:24):

   ```typescript
   import { z } from "zod";

   // Inside the for loop:
   const shape = tool.schema instanceof z.ZodObject ? tool.schema.shape : {};
   server.tool(
     tool.name,
     tool.description,
     shape,
     async (input: unknown) => { ... }
   );
   ```

2. If the MCP SDK requires a different format than `z.ZodObject.shape`, create a helper function in [`mcp/schemas.ts`](./src/mcp/schemas.ts):

   ```typescript
   export function extractSchemaShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
     if (schema instanceof z.ZodObject) {
       return schema.shape as Record<string, z.ZodTypeAny>;
     }
     return {};
   }
   ```

3. Consider using `z.input<typeof schema>` type inference instead of manual shape extraction if the MCP SDK supports typed generics.

4. Add a compile-time safety check: if the MCP SDK `server.tool()` signature allows typed parameters, use them to ensure the input type matches the schema type.

5. Add a test in [`tests/mcp/server.test.ts`](./tests/mcp/server.test.ts) that verifies:
   - A tool with a ZodObject schema correctly extracts the shape
   - A tool without a schema (or with a non-object schema) produces an empty shape
   - The extracted shape properly validates/rejects inputs

**Acceptance criteria:**

- [ ] No `as any` cast on `_def` property access
- [ ] Zod public API used (`instanceof z.ZodObject`, `.shape`)
- [ ] Empty/fallback case handled explicitly with a warning or error log
- [ ] Test verifies correct shape extraction and fallback behavior
- [ ] `npm run build` and `npm run test` pass
