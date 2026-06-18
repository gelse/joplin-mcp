# Software Bill of Materials (SBOM)

**Project**: `joplin-api` — Joplin MCP Server  
**Version**: 1.0.0  
**Generated**: 2026-06-18T08:24:13Z  
**Updated**: 2026-06-18T12:05:00Z (two-container architecture)  
**Package Manager**: pnpm 9 (lockfile v9.0)  
**Runtime**: Node.js 22 (bookworm-slim)

---

## 1. Project Overview

This project provides an MCP (Model Context Protocol) server that wraps the Joplin Data API, exposing 16 tools for note management. As of June 2026, it uses a **two-container architecture** for Docker deployments:

- **Container A (`joplin-core`)**: Stateful backend — runs Joplin CLI headless with the Data API (ClipperServer) on port 41184, backed by a persistent SQLite volume. A bash-based sync scheduler handles periodic sync against any Joplin Sync target (Joplin Server, Nextcloud, etc.).
- **Container B (`joplin-mcp`)**: Stateless MCP HTTP server — exposes the 16 MCP tools via StreamableHTTP transport on port 3000. Connects to joplin-core over the internal Docker network using `JOPLIN_CORE_URL`.

The original monolithic [`Dockerfile`](Dockerfile) and [`entrypoint.sh`](entrypoint.sh) are preserved for backward compatibility.

### 1.1 Architecture Summary

```
┌─────────────────────────────────────────────────┐
│ MCP Client (Claude Desktop / VS Code)            │
│   HTTP (StreamableHTTP) → port 3000              │
└──────────────┬──────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────┐
│ Container B: joplin-mcp (stateless)             │
│   entrypoint: entrypoint-mcp.sh                 │
│   entry point: src/mcp/entry.ts                 │
│   server.ts → createMCPServer()                 │
│     ToolRegistry (16 tools)                     │
│       ↓                                         │
│   data-client.ts → JoplinDataClient             │
│     HTTP requests to joplin-core (internal net) │
└──────────────┬──────────────────────────────────┘
               │ HTTP + Bearer Token
┌──────────────▼──────────────────────────────────┐
│ Container A: joplin-core (stateful)             │
│   entrypoint: entrypoint-core.sh                │
│   Joplin Data API (port 41184)                  │
│     ↓                                           │
│   Joplin CLI (joplin v3.6.2)                   │
│     ↓                                           │
│   SQLite DB (persistent volume)                 │
│   Bash Sync Scheduler (periodic joplin sync)    │
└─────────────────────────────────────────────────┘
```

---

## 2. Runtime Dependencies

Both containers share the same npm dependency tree. Container A uses it for the Joplin CLI and Data API infrastructure; Container B uses it for the MCP HTTP server.

### 2.1 Direct Runtime Dependencies

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | 1.29.0 | MIT | MCP protocol implementation (stdio + StreamableHTTP transport, tool registration) |
| [`pino`](https://www.npmjs.com/package/pino) | 9.14.0 | MIT | Structured JSON logging |
| [`pino-pretty`](https://www.npmjs.com/package/pino-pretty) | 11.3.0 | MIT | Human-readable log formatting for development |
| [`zod`](https://www.npmjs.com/package/zod) | 3.25.76 | MIT | Runtime schema validation for all MCP tool inputs |

### 2.2 Full Transitive Dependency Tree

#### 2.2.1 `@modelcontextprotocol/sdk@1.29.0` → 15 direct dependencies

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| `@hono/node-server` | 1.19.7 | MIT | Node.js HTTP server adapter for Hono |
| `ajv` | 8.17.1 | MIT | JSON Schema validation |
| `ajv-formats` | 3.0.1 | MIT | Format validators for ajv (uri, email, etc.) |
| `content-type` | 2.0.0 | MIT | HTTP Content-Type header parsing |
| `cors` | 2.8.5 | MIT | Cross-Origin Resource Sharing middleware |
| `cross-spawn` | 7.0.6 | MIT | Cross-platform child process spawning |
| `eventsource` | 3.0.7 | MIT | Server-Sent Events (SSE) client |
| `eventsource-parser` | 3.0.2 | MIT | SSE stream parser |
| `express` | 5.2.1 | MIT | HTTP server framework (used by MCP SDK internally) |
| `express-rate-limit` | 7.5.1 | MIT | Rate limiting middleware for Express |
| `hono` | 4.11.0 | MIT | Lightweight web framework |
| `jose` | 6.1.3 | MIT | JWT/JOSE standards implementation |
| `json-schema-typed` | 8.0.2 | Apache-2.0 | TypeScript types for JSON Schema |
| `pkce-challenge` | 5.0.1 | MIT | PKCE code challenge generator |
| `raw-body` | 3.0.2 | MIT | HTTP request body parsing |
| `zod-to-json-schema` | 3.25.2 | ISC | Zod schema → JSON Schema conversion |

##### Express@5.2.1 subtree (18 packages)

| Package | Version | License |
|---------|---------|---------|
| `accepts` | 2.0.0 | MIT |
| `body-parser` | 2.2.2 | MIT |
| `content-disposition` | 1.0.1 | MIT |
| `cookie` | 0.7.2 | MIT |
| `cookie-signature` | 1.2.2 | MIT |
| `debug` | 4.4.3 | MIT |
| `depd` | 2.0.0 | MIT |
| `encodeurl` | 2.0.0 | MIT |
| `escape-html` | 1.0.3 | MIT |
| `etag` | 1.8.1 | MIT |
| `finalhandler` | 2.1.1 | MIT |
| `fresh` | 2.0.0 | MIT |
| `http-errors` | 2.0.1 | MIT |
| `merge-descriptors` | 2.0.0 | MIT |
| `mime-types` | 3.0.2 | MIT |
| `on-finished` | 2.4.1 | MIT |
| `once` | 1.4.0 | ISC |
| `parseurl` | 1.3.3 | MIT |
| `proxy-addr` | 2.0.7 | MIT |
| `qs` | 6.15.2 | BSD-3-Clause |
| `range-parser` | 1.2.1 | MIT |
| `router` | 2.2.0 | MIT |
| `send` | 1.2.1 | MIT |
| `serve-static` | 2.2.1 | MIT |
| `statuses` | 2.0.2 | MIT |
| `type-is` | 2.1.0 | MIT |
| `vary` | 1.1.2 | MIT |

##### Additional transitive packages (shared)

| Package | Version | License |
|---------|---------|---------|
| `bytes` | 3.1.2 | MIT |
| `call-bind-apply-helpers` | 1.0.2 | MIT |
| `call-bound` | 1.0.4 | MIT |
| `dunder-proto` | 1.0.1 | MIT |
| `ee-first` | 1.1.1 | MIT |
| `es-define-property` | 1.0.1 | MIT |
| `es-errors` | 1.3.0 | MIT |
| `es-object-atoms` | 1.1.1 | MIT |
| `forwarded` | 0.2.0 | MIT |
| `function-bind` | 1.1.2 | MIT |
| `get-intrinsic` | 1.3.0 | MIT |
| `gopd` | 1.2.0 | MIT |
| `has-symbols` | 1.1.0 | MIT |
| `hasown` | 2.0.2 | MIT |
| `iconv-lite` | 0.7.2 | MIT |
| `ipaddr.js` | 1.9.1 | MIT |
| `math-intrinsics` | 1.1.0 | MIT |
| `media-typer` | 1.1.0 | MIT |
| `ms` | 2.1.3 | MIT |
| `negotiator` | 1.0.0 | MIT |
| `object-inspect` | 1.13.4 | MIT |
| `object-assign` | 4.1.1 | MIT |
| `path-to-regexp` | 8.4.2 | MIT |
| `setprototypeof` | 1.2.0 | ISC |
| `side-channel` | 1.1.0 | MIT |
| `side-channel-list` | 1.0.1 | MIT |
| `side-channel-map` | 1.0.1 | MIT |
| `side-channel-weakmap` | 1.0.2 | MIT |
| `toidentifier` | 1.0.1 | MIT |
| `unpipe` | 1.0.0 | MIT |
| `safer-buffer` | 2.1.2 | MIT |

##### AJV subtree

| Package | Version | License |
|---------|---------|---------|
| `fast-deep-equal` | 3.1.3 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `uri-js` | 4.4.1 | BSD-2-Clause |
| `punycode` | 2.3.1 | MIT |

##### Cross-spawn subtree

| Package | Version | License |
|---------|---------|---------|
| `path-key` | 3.1.1 | MIT |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `which` | 2.0.2 | ISC |
| `isexe` | 2.0.0 | ISC |

##### Eventsource subtree

| Package | Version | License |
|---------|---------|---------|
| `event-target-shim` | 6.0.2 | MIT |

#### 2.2.2 `pino@9.14.0` → 11 direct dependencies

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| `@pinojs/redact` | 0.4.0 | MIT | Log redaction for sensitive data |
| `atomic-sleep` | 1.0.0 | MIT | Non-blocking sleep |
| `on-exit-leak-free` | 2.1.2 | MIT | Process exit handler |
| `pino-abstract-transport` | 2.0.0 | MIT | Transport interface |
| `pino-std-serializers` | 7.1.0 | MIT | Standard log serializers |
| `process-warning` | 5.0.0 | MIT | Deprecation warnings |
| `quick-format-unescaped` | 4.0.4 | MIT | Fast printf-style formatting |
| `real-require` | 0.2.0 | MIT | Native module require |
| `safe-stable-stringify` | 2.5.0 | MIT | Safe JSON.stringify |
| `sonic-boom` | 4.2.1 | MIT | Fast file writer |
| `thread-stream` | 3.2.0 | MIT | Worker thread stream |

#### 2.2.3 `pino-pretty@11.3.0` → 14 direct dependencies

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| `colorette` | 2.0.20 | MIT | Terminal color support |
| `dateformat` | 4.6.3 | MIT | Date formatting |
| `fast-copy` | 3.0.2 | MIT | Deep object copy |
| `fast-safe-stringify` | 2.1.1 | MIT | Safe serialization |
| `help-me` | 5.0.0 | MIT | Help text generator |
| `joycon` | 3.1.1 | MIT | Configuration file loader |
| `minimist` | 1.2.8 | MIT | CLI argument parser |
| `pino-abstract-transport` | 2.0.0 | MIT | (shared with pino) |
| `pump` | 3.0.4 | MIT | Stream pipeline |
| `readable-stream` | 4.7.0 | MIT | Streams3 implementation |
| `secure-json-parse` | 2.7.0 | BSD-3-Clause | Safe JSON.parse |
| `sonic-boom` | 4.2.1 | MIT | (shared with pino) |
| `strip-json-comments` | 3.1.1 | MIT | Remove JSON comments |
| `split2` | 4.2.0 | ISC | Line splitter |

##### Readable-stream subtree

| Package | Version | License |
|---------|---------|---------|
| `abort-controller` | 3.0.0 | MIT |
| `buffer` | 6.0.3 | MIT |
| `events` | 3.3.0 | MIT |
| `process` | 0.11.10 | MIT |
| `string_decoder` | 1.3.0 | MIT |
| `safe-buffer` | 5.2.1 | MIT |
| `base64-js` | 1.5.1 | MIT |
| `ieee754` | 1.2.1 | BSD-3-Clause |
| `event-target-shim` | 6.0.2 | MIT |

##### Pump subtree

| Package | Version | License |
|---------|---------|---------|
| `end-of-stream` | 1.4.5 | MIT |

#### 2.2.4 `zod@3.25.76`

No transitive dependencies (self-contained).

### 2.3 Shared/Leaf Dependencies (no further children)

| Package | Version | License |
|---------|---------|---------|
| `wrappy` | 1.0.2 | ISC |

### 2.4 Runtime Dependency Summary

- **Total runtime packages**: ~97 unique packages
- **License breakdown**: MIT (~92), ISC (~3), BSD-3-Clause (~2), BSD-2-Clause (~1), Apache-2.0 (~1)
- **All runtime licenses are permissive** — no GPL, AGPL, or copyleft licenses

---

## 3. Development Dependencies

### 3.1 Direct Dev Dependencies

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| [`@eslint/js`](https://www.npmjs.com/package/@eslint/js) | 9.39.4 | MIT | ESLint core rules |
| [`@types/node`](https://www.npmjs.com/package/@types/node) | 22.19.20 | MIT | Node.js type definitions |
| [`@vitest/coverage-v8`](https://www.npmjs.com/package/@vitest/coverage-v8) | 2.1.9 | MIT | Code coverage (V8-based) |
| [`eslint`](https://www.npmjs.com/package/eslint) | 9.39.4 | MIT | JavaScript/TypeScript linter |
| [`prettier`](https://www.npmjs.com/package/prettier) | 3.8.3 | MIT | Code formatter |
| [`tsx`](https://www.npmjs.com/package/tsx) | 4.22.4 | MIT | TypeScript execute (dev server / hot reload) |
| [`typescript`](https://www.npmjs.com/package/typescript) | 5.9.3 | Apache-2.0 | TypeScript compiler |
| [`typescript-eslint`](https://www.npmjs.com/package/typescript-eslint) | 8.60.1 | MIT | TypeScript-aware ESLint plugin |
| [`vitest`](https://www.npmjs.com/package/vitest) | 2.1.9 | MIT | Test runner |

### 3.2 Key Transitive Dev Dependencies

#### ESLint@9.39.4 subtree (>40 packages)

| Package | Version | License |
|---------|---------|---------|
| `@eslint-community/eslint-utils` | 4.7.0 | MIT |
| `@eslint-community/regexpp` | 4.12.2 | MIT |
| `@eslint/config-array` | 0.21.1 | Apache-2.0 |
| `@eslint/config-helpers` | 0.3.1 | Apache-2.0 |
| `@eslint/core` | 0.15.4 | Apache-2.0 |
| `@eslint/eslintrc` | 3.3.3 | MIT |
| `@eslint/plugin-kit` | 0.4.1 | Apache-2.0 |
| `@humanfs/node` | 0.16.7 | Apache-2.0 |
| `@humanwhocodes/module-importer` | 1.0.1 | Apache-2.0 |
| `@humanwhocodes/retry` | 0.4.3 | Apache-2.0 |
| `@types/estree` | 1.0.9 | MIT |
| `@types/json-schema` | 7.0.15 | MIT |
| `ajv` | 6.12.6 | MIT |
| `chalk` | 4.1.2 | MIT |
| `escape-string-regexp` | 4.0.0 | MIT |
| `eslint-scope` | 8.4.0 | BSD-2-Clause |
| `eslint-visitor-keys` | 4.2.1 | Apache-2.0 |
| `espree` | 10.4.0 | BSD-2-Clause |
| `esquery` | 1.6.0 | BSD-3-Clause |
| `esutils` | 2.0.3 | BSD-2-Clause |
| `fast-deep-equal` | 3.1.3 | MIT |
| `file-entry-cache` | 10.1.2 | MIT |
| `find-up` | 5.0.0 | MIT |
| `flat-cache` | 6.1.9 | MIT |
| `flatted` | 3.3.3 | ISC |
| `glob-parent` | 6.0.2 | ISC |
| `ignore` | 7.0.5 | MIT |
| `imurmurhash` | 0.1.4 | MIT |
| `is-glob` | 4.0.3 | MIT |
| `json-stable-stringify-without-jsonify` | 1.0.1 | MIT |
| `lodash.merge` | 4.6.2 | MIT |
| `minimatch` | 3.1.2 | ISC |
| `natural-compare` | 1.4.0 | MIT |
| `optionator` | 0.9.4 | MIT |
| `levn` | 0.4.1 | MIT |
| `prelude-ls` | 1.2.1 | MIT |
| `type-check` | 0.4.0 | MIT |
| `word-wrap` | 1.2.5 | MIT |
| `keyv` | 5.3.5 | MIT |
| `@keyv/serialize` | 1.1.0 | MIT |
| `cacheable` | 1.10.5 | MIT |
| `hookified` | 1.9.0 | MIT |
| `keyv-file` | 6.0.3 | MIT |
| `locate-path` | 6.0.0 | MIT |
| `p-locate` | 5.0.0 | MIT |
| `p-limit` | 3.1.0 | MIT |
| `yocto-queue` | 0.1.0 | MIT |
| `parent-module` | 1.0.1 | MIT |
| `callsites` | 3.1.0 | MIT |
| `resolve-from` | 4.0.0 | MIT |

#### TypeScript-ESLint@8.60.1 subtree

| Package | Version | License |
|---------|---------|---------|
| `@typescript-eslint/eslint-plugin` | 8.60.1 | MIT |
| `@typescript-eslint/parser` | 8.60.1 | BSD-2-Clause |
| `@typescript-eslint/typescript-estree` | 8.60.1 | BSD-2-Clause |
| `@typescript-eslint/utils` | 8.60.1 | MIT |
| `@typescript-eslint/scope-manager` | 8.60.1 | MIT |
| `@typescript-eslint/types` | 8.60.1 | MIT |
| `@typescript-eslint/visitor-keys` | 8.60.1 | MIT |
| `ts-api-utils` | 2.5.0 | MIT |

#### Vitest@2.1.9 subtree

| Package | Version | License |
|---------|---------|---------|
| `@vitest/expect` | 2.1.9 | MIT |
| `@vitest/mocker` | 2.1.9 | MIT |
| `@vitest/pretty-format` | 2.1.9 | MIT |
| `@vitest/runner` | 2.1.9 | MIT |
| `@vitest/snapshot` | 2.1.9 | MIT |
| `@vitest/spy` | 2.1.9 | MIT |
| `@vitest/utils` | 2.1.9 | MIT |
| `chai` | 5.3.3 | MIT |
| `assertion-error` | 2.0.1 | MIT |
| `check-error` | 2.1.1 | MIT |
| `deep-eql` | 5.0.2 | MIT |
| `loupe` | 3.1.3 | MIT |
| `pathval` | 2.0.0 | MIT |
| `vite` | 5.4.21 | MIT |
| `esbuild` | 0.21.5 | MIT |
| `rollup` | 4.61.1 | MIT |
| `postcss` | 8.5.15 | MIT |
| `vite-node` | 2.1.9 | MIT |
| `tinybench` | 2.9.0 | MIT |
| `tinyexec` | 0.3.2 | MIT |
| `tinyglobby` | 0.2.17 | MIT |
| `tinypool` | 1.1.1 | MIT |
| `tinyrainbow` | 1.2.0 | MIT |
| `tinyspy` | 3.0.2 | MIT |
| `expect-type` | 1.3.0 | Apache-2.0 |
| `std-env` | 3.10.0 | MIT |
| `why-is-node-running` | 2.3.0 | MIT |
| `siginfo` | 2.0.0 | ISC |
| `stackback` | 0.0.2 | MIT |
| `pathe` | 1.1.2 | MIT |
| `magic-string` | 0.30.21 | MIT |
| `@jridgewell/sourcemap-codec` | 1.5.5 | MIT |
| `es-module-lexer` | 1.7.0 | MIT |
| `cac` | 6.7.14 | MIT |
| `nanoid` | 3.3.12 | MIT |
| `picocolors` | 1.1.1 | ISC |
| `source-map-js` | 1.2.1 | BSD-3-Clause |
| `fdir` | 6.5.0 | MIT |
| `picomatch` | 4.0.4 | MIT |
| `@rollup/rollup-linux-x64-gnu` | 4.61.1 | MIT |
| `@rollup/rollup-linux-x64-musl` | 4.61.1 | MIT |
| (+ 22 other platform-specific optional Rollup packages) | | |

#### @vitest/coverage-v8@2.1.9 subtree

| Package | Version | License |
|---------|---------|---------|
| `istanbul-lib-coverage` | 3.2.2 | BSD-3-Clause |
| `istanbul-lib-report` | 3.0.1 | BSD-3-Clause |
| `istanbul-lib-source-maps` | 5.0.6 | BSD-3-Clause |
| `istanbul-reports` | 3.2.0 | BSD-3-Clause |
| `test-exclude` | 7.0.2 | ISC |
| `@istanbuljs/schema` | 0.1.6 | MIT |
| `html-escaper` | 2.0.2 | MIT |
| `make-dir` | 4.0.0 | MIT |
| `semver` | 7.8.2 | ISC |
| `supports-color` | 7.2.0 | MIT |
| `has-flag` | 4.0.0 | MIT |
| `glob` | 10.5.0 | ISC |
| `foreground-child` | 3.3.1 | ISC |
| `signal-exit` | 4.1.0 | ISC |
| `jackspeak` | 4.1.1 | BlueOak-1.0.0 |
| `minimatch` | 10.2.5 | ISC |
| `brace-expansion` | 2.0.2 | MIT |
| `balanced-match` | 1.0.2 | MIT |
| `path-scurry` | 2.0.1 | BlueOak-1.0.0 |
| `lru-cache` | 11.2.1 | ISC |
| `package-json-from-dist` | 1.0.1 | BlueOak-1.0.0 |
| `@isaacs/fs-minipass` | 4.0.1 | ISC |
| `minipass` | 7.1.2 | ISC |

#### tsx@4.22.4

| Package | Version | License |
|---------|---------|---------|
| `esbuild` | 0.28.0 | MIT |
| `@esbuild/linux-x64` | 0.28.0 | MIT |
| (+ 12 other platform-specific optional esbuild packages) | | |

### 3.3 CI/CD Pipeline Dependencies

| Action | Version | Purpose |
|--------|---------|---------|
| [`actions/checkout`](https://github.com/actions/checkout) | v4 | Clone repository |
| [`actions/upload-artifact`](https://github.com/actions/upload-artifact) | v4 | Upload test results |
| [`dorny/test-reporter`](https://github.com/dorny/test-reporter) | v1 | Publish JUnit test reports |

**CI runtime**: `ubuntu-latest` (GitHub Actions)

---

## 4. Container & System Components

### 4.1 Docker Base Images

| Image | Container | Digest/Version | Purpose |
|-------|-----------|---------------|---------|
| `node:22-bookworm-slim` | Both (builder) | Node.js 22 LTS | Compile TypeScript, run tests |
| `node:22-bookworm-slim` | joplin-core (prod) | Node.js 22 LTS | Runtime execution — Joplin CLI + Data API |
| `node:22-bookworm-slim` | joplin-mcp (prod) | Node.js 22 LTS | Runtime execution — MCP HTTP server |

**Base OS**: Debian 12 "Bookworm" (slim variant — minimal footprint)

### 4.2 Container A: joplin-core

**Dockerfile**: [`Dockerfile.core`](Dockerfile.core)  
**Entrypoint**: [`entrypoint-core.sh`](entrypoint-core.sh)  
**Role**: Stateful backend — Joplin CLI headless, Data API, bash sync scheduler

#### System Packages (apt-get)

| Package | Purpose | Privacy Note |
|---------|---------|-------------|
| `libsecret-1-0` | Joplin CLI credential storage (Linux keychain) | Stores auth tokens in OS keyring; no network |
| `ca-certificates` | TLS certificate validation for Joplin Server HTTPS | Required for secure connections; no telemetry |
| `curl` | Health checks and potential network operations | Localhost; no telemetry |
| `socat` | Socket relay utility | Localhost; no telemetry |

#### Global npm Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `pnpm` | 9.x | Package manager (dependency installation) |
| `joplin` (CLI) | 3.6.2 | Joplin CLI — core data access layer; all API calls go through the `joplin` command |

#### npm Dependencies from package.json

All production npm dependencies from [`package.json`](package.json) (see Section 2) are installed in the builder stage and compiled. The production stage copies the built `dist/` and installs production-only dependencies.

#### Container Configuration

| Setting | Value |
|---------|-------|
| Runtime user | `joplin` (non-root, UID/GID via `useradd`) |
| Healthcheck | `curl -f http://localhost:41185/ping` every 30s |
| Resource limits | CPU: 1.0, Memory: 512M |
| Exposed port | 41184 (Data API, internal Docker network) |
| Entrypoint | [`entrypoint-core.sh`](entrypoint-core.sh) → starts Joplin Data API + bash sync scheduler |
| Persistent volume | `joplin_data` at `/home/joplin/.config/joplin` (SQLite database) |

### 4.3 Container B: joplin-mcp

**Dockerfile**: [`Dockerfile.mcp`](Dockerfile.mcp)  
**Entrypoint**: [`entrypoint-mcp.sh`](entrypoint-mcp.sh)  
**Entry point**: [`src/mcp/entry.ts`](src/mcp/entry.ts) (compiled to `dist/mcp/entry.js`)  
**Role**: Stateless MCP HTTP server — exposes 16 tools via StreamableHTTP transport

#### System Packages (apt-get)

| Package | Purpose | Privacy Note |
|---------|---------|-------------|
| `ca-certificates` | TLS certificate validation for HTTPS connections to joplin-core | Local network only |
| `curl` | Health checks | Localhost; no telemetry |

#### Global npm Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `pnpm` | 9.x | Package manager (production dependency installation) |

#### npm Dependencies from package.json

All production npm dependencies from [`package.json`](package.json) (see Section 2) are installed. The MCP server uses `@modelcontextprotocol/sdk` for StreamableHTTP transport, `pino` for logging, and `zod` for input validation.

#### Container Configuration

| Setting | Value |
|---------|-------|
| Runtime user | `mcp` (non-root, UID/GID via `useradd`) |
| Healthcheck | `curl -f http://localhost:3000/health` every 30s |
| Resource limits | CPU: 1.0, Memory: 512M |
| Exposed port | 3000 (MCP HTTP, mapped to host) |
| Entrypoint | [`entrypoint-mcp.sh`](entrypoint-mcp.sh) → `node dist/mcp/entry.js` (compiled TypeScript MCP HTTP server) |

---

## External Runtime Components

### supergateway (External — Not a Project Dependency)

**supergateway is NOT a dependency of this project.** It does not appear in [`package.json`](package.json), [`pnpm-lock.yaml`](pnpm-lock.yaml), any Dockerfile, [`docker-compose.yml`](docker-compose.yml), or any source file. There are zero references to it in the codebase.

**What it is:** [`supergateway`](https://www.npmjs.com/package/supergateway) is an npm package maintained by Supermachine AI that wraps stdio-based MCP servers and exposes them over HTTP (Streamable HTTP transport) on a local port. It spawns the MCP server as a child process over stdio, then bridges the communication to HTTP.

**How it gets involved:** supergateway is injected externally by the user's MCP client configuration (e.g., VS Code `mcp.json`, Claude Desktop config) when the client is configured to connect over HTTP (`streamableHttp` transport) instead of stdio. The MCP client installs and runs supergateway, which then spawns this project's stdio server — entirely outside the control of this project.

> **Note:** With the two-container architecture, the recommended deployment uses joplin-mcp's native StreamableHTTP transport (port 3000), which eliminates the need for supergateway entirely. The monolithic mode (stdio) may still involve supergateway if the client uses HTTP transport.

**Typical log output:**
```
[supergateway] Starting...
[supergateway] Supergateway is supported by Supermachine (hosted MCPs) - https://supermachine.ai
[supergateway]   - outputTransport: streamableHttp
[supergateway] Running stateless server
[supergateway]   - port: 8080
[supergateway]   - stdio: node dist/server.js
```

- The `supermachine.ai` banner is informational text from the supergateway npm package — it does **not** establish any network connection from this project.
- supergateway opens a **local-only** HTTP listener on port 8080.
- This project itself makes **zero outbound connections** to supermachine.ai or any third party.

#### Privacy & Security Assessment

| Aspect | Assessment |
|--------|------------|
| Network scope | 🟡 Local only — HTTP listener bound to localhost:8080 |
| Outbound connections | 🟢 None — this project initiates no connections to supermachine.ai |
| Package auditability | ⚠️ **Review needed** — `supergateway` is closed-source and has not been independently audited |
| Data exposure | 🟢 No data sent to third parties by this project |

> ⚠️ **Privacy recommendation**: The `supergateway` package is closed-source and maintained by a third party (Supermachine AI). While the banner text is informational and only a local HTTP listener is opened, the package itself has not been independently audited. Privacy-conscious users should:
> - **Use the two-container deployment** — joplin-mcp provides native StreamableHTTP, bypassing supergateway entirely
> - **Or connect over stdio directly** — bypasses supergateway as well (see below)
> - **Or audit the package independently** — review the `supergateway` code before use
> - This project sends **zero data** to supermachine.ai or any third party regardless of transport

#### How to Eliminate supergateway

**Option 1: Two-container deployment (recommended)** — joplin-mcp exposes a native HTTP endpoint on port 3000; no supergateway needed.

**Option 2: Stdio transport** — Configure the MCP client to use `stdio` transport directly instead of `streamableHttp`. This removes supergateway from the equation entirely.

**VS Code `mcp.json` example (stdio)**:
```json
{
  "servers": {
    "joplin-api": {
      "command": "node",
      "args": ["dist/server.js"],
      "env": {
        "JOPLIN_API_TOKEN": "...",
        "JOPLIN_SERVER_URL": "..."
      }
    }
  }
}
```

When connecting over stdio, the MCP client communicates directly with the server via stdin/stdout JSON-RPC — no supergateway, no HTTP layer, no third-party wrapper.

---

## 5. Privacy & Security Assessment

### 5.1 Network Communication Analysis

| Component | Network Scope | Details |
|-----------|--------------|---------|
| joplin-mcp (entry.ts) | **Local only** | HTTP server on port 3000; internal Docker network communication to joplin-core |
| JoplinDataClient (data-client.ts) | **Local only** | HTTP to `JOPLIN_CORE_URL` (internal Docker network) |
| Joplin Data API (joplin-core) | **Internal only** | HTTP on port 41184; bound to `0.0.0.0` within Docker network |
| Joplin CLI (joplin-core) | **Local process** | Spawned as child process; no network |
| Bash Sync Scheduler (joplin-core) | **Indirect** | Triggers `joplin sync` which connects to configured Joplin Sync target; not initiated by this codebase directly |
| Healthcheck (joplin-core) | **Local only** | `curl localhost:41185/ping` |
| Healthcheck (joplin-mcp) | **Local only** | `curl localhost:3000/health` |

### 5.2 Dependency Privacy Risk Classification

> **🟢 = No network / Pure computation**  
> **🟡 = Local network only**  
> **🔴 = External network capable**  
> **⚠️ = Known telemetry concern**

#### Runtime Dependencies

| Dependency | Risk | Notes |
|------------|------|-------|
| `@modelcontextprotocol/sdk` | 🟡 | StreamableHTTP transport in joplin-mcp; bound to localhost/Docker network; stdio-only in monolithic mode; no telemetry |
| `pino` / `pino-pretty` | 🟢 | Writes to stdout/stderr only; configurable redaction via `@pinojs/redact` |
| `zod` | 🟢 | Pure validation; no I/O |
| `express` (transitive) | 🟡 | Used internally by MCP SDK for HTTP server; bound to localhost/Docker network only |
| `jose` (transitive) | 🟢 | Cryptographic operations only; no network |
| `cross-spawn` (transitive) | 🟢 | Child process management; no network |
| `eventsource` (transitive) | 🔴 | SSE client capable of outbound connections; not actively used in this configuration |
| `ajv` (transitive) | 🟢 | JSON Schema validation; no I/O |
| All other transitive deps | 🟢 | Pure utility/processing libraries |

#### Development Dependencies

| Dependency | Risk | Notes |
|------------|------|-------|
| `eslint` | 🟢 | Local file analysis only |
| `prettier` | 🟢 | Local file formatting only |
| `typescript` | 🟢 | Local compilation only |
| `vitest` | 🟢 | Local test execution only |
| `tsx` | 🟢 | Local dev server; hot reload via file watching |
| `esbuild` | 🟢 | Local bundling only |

### 5.3 Data Flow & Sensitive Data Handling

| Data Type | Storage | Transmission | Protection |
|-----------|---------|-------------|------------|
| Joplin API Token | Environment variable (`JOPLIN_API_TOKEN`) | HTTP `Authorization: Bearer` header (joplin-mcp → joplin-core) | [`GuardedString`](src/guarded-string.ts) class masks value in logs; token auto-extracted by `entrypoint-core.sh` |
| Joplin Server URL | Environment variable | Used for Joplin CLI sync | Validated by config schema; must use HTTPS in production |
| Note Content | In-memory during MCP tool execution | Returned to MCP client via HTTP (joplin-mcp) or stdio (monolithic) | Not persisted by this application; Joplin CLI manages storage in SQLite volume |
| Log Output | stdout/stderr (both containers) | Configurable log level | Sensitive data masked by `GuardedString.toString()` |

### 5.4 Security Best Practices

| Practice | Implementation |
|----------|---------------|
| Non-root users | Container A runs as `joplin` user; Container B runs as `mcp` user (both uid != 0) |
| Minimal base image | `node:22-bookworm-slim` — reduced attack surface |
| No exposed ports (joplin-core) | Data API on internal Docker network only; not mapped to host by default |
| Exposed port (joplin-mcp) | Port 3000 mapped to host for MCP client access |
| Input validation | All 16 MCP tools use Zod schemas for input validation |
| ID sanitization | [`validateId()`](src/data-client.ts:59) rejects non-alphanumeric IDs |
| CLI argument sanitization | [`validateArgs()`](src/cli-executor.ts:65) blocks shell metacharacters (`;`, `|`, `&`, `$`, `` ` ``, `(`, `)`) |
| Token management | Auto-extraction from Joplin CLI in entrypoint-core.sh; auto-refresh on expiry |
| Rate limiting | Serial request queue in `JoplinDataClient` prevents API overload |
| Frozen lockfile | `pnpm install --frozen-lockfile` ensures reproducible builds in both containers |
| Container isolation | Separate containers for stateful backend and stateless frontend; independent healthchecks |

---

## 6. License Summary

### 6.1 Runtime License Distribution

| License | Count | Packages (selected) |
|---------|-------|---------------------|
| MIT | ~92 | `@modelcontextprotocol/sdk`, `pino`, `zod`, `express`, `jose`, `hono`, `ajv`, `cross-spawn`, etc. |
| ISC | ~3 | `zod-to-json-schema`, `once`, `wrappy` |
| BSD-3-Clause | ~2 | `qs`, `secure-json-parse` |
| BSD-2-Clause | ~1 | `uri-js` |
| Apache-2.0 | ~1 | `json-schema-typed` |

### 6.2 Development License Distribution

| License | Count | Packages (selected) |
|---------|-------|---------------------|
| MIT | ~75 | `eslint`, `prettier`, `vitest`, `tsx`, `esbuild`, `rollup`, `chai`, etc. |
| Apache-2.0 | ~8 | `typescript`, `@eslint/config-array`, `@humanfs/node`, `@humanwhocodes/retry`, etc. |
| ISC | ~7 | `glob`, `semver`, `minimatch`, `lru-cache`, `flatted`, `siginfo`, `which` |
| BSD-3-Clause | ~4 | `istanbul-lib-coverage`, `istanbul-lib-report`, `esquery`, `source-map-js` |
| BSD-2-Clause | ~3 | `eslint-scope`, `espree`, `esutils` |
| BlueOak-1.0.0 | ~3 | `jackspeak`, `path-scurry`, `package-json-from-dist` |

### 6.3 License Compliance

- ✅ **All licenses are permissive** (MIT, ISC, BSD, Apache-2.0, BlueOak)
- ✅ **No copyleft licenses** (no GPL, LGPL, AGPL, MPL)
- ✅ **No proprietary/commercial restrictions**
- ✅ **All packages are publicly available on npm**

---

## 7. Build Artifacts

### 7.1 TypeScript Compilation

| Setting | Value |
|---------|-------|
| Target | `ES2022` |
| Module | `NodeNext` |
| Module Resolution | `NodeNext` |
| Out Directory | `dist/` |
| Source Maps | Enabled |
| Strict Mode | Enabled |
| Skip Library Check | Enabled (build config only) |

### 7.2 Ignored from Build/Package

| Pattern | Reason |
|---------|--------|
| `node_modules/` | Installed at deploy time |
| `.git/` | Version control |
| `.pnpm-store/` | pnpm cache |
| `docs/`, `tasks/` | Documentation only |
| `.env`, `**/.env.*` | Secrets |
| `dist/` | Rebuilt per environment |
| `.devcontainer/` | Dev tooling |
| `*.md` | Documentation |
| `.roo/` | IDE configuration |

---

## 8. Dependency Update Cadence

| Mechanism | Frequency |
|-----------|-----------|
| Dependabot | Not currently configured |
| CI Tests | Every push/PR to `main` |
| Manual Review | Per release cycle |

**Recommendation**: Configure Dependabot or Renovate for automated dependency updates, especially for security patches in `express`, `cross-spawn`, and `jose`.

---

## 9. Verification

This SBOM was generated by:

1. Extracting direct dependencies from [`package.json`](package.json)
2. Resolving the full transitive tree from [`pnpm-lock.yaml`](pnpm-lock.yaml) (v9.0 lockfile, 3,398 lines)
3. Cataloging system packages from [`Dockerfile.core`](Dockerfile.core) and [`Dockerfile.mcp`](Dockerfile.mcp)
4. Identifying CI dependencies from [`.github/workflows/test.yml`](.github/workflows/test.yml)
5. Reviewing all source files in [`src/`](src/) for runtime imports and data flow

**Verification command** (run in project root):
```bash
pnpm ls --depth=99 --prod    # List all production dependencies
pnpm ls --depth=99 --dev     # List all dev dependencies
```

---

*Document maintained as part of the [`joplin-api`](https://github.com/werner/joplin-api) project. Update when dependencies change.*
