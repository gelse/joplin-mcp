/**
 * Structural guards for the container-integration test infrastructure (M11).
 *
 * These are text assertions on `docker-compose.test.yml`,
 * `scripts/run-integration-tests.sh`, and the repro test's container
 * resolution. Like the grep-based harnesses in `tests/test-sync-*.sh`
 * (review 2026-09-21 S2), they are deliberately structural: real behavior
 * (compose up alongside a name collision, `docker exec` via the resolved ID)
 * requires a Docker daemon and is covered by the Docker-dependent verification
 * in `plans/M11-fixed-container-name-parallel-stacks.md`, not by unit tests.
 *
 * The guards pin four invariants:
 *   1. The test compose does not pin `container_name`, so parallel compose
 *      stacks are never blocked by a fixed name collision.
 *   2. The runner script resolves the container ID from the compose project
 *      (`compose ps -q -a`) and forwards it to the in-container vitest process.
 *   3. Resolution fails fast when the compose project yields no container: the
 *      old `${ID:-joplin-mcp}` fallback silently retargeted the destructive
 *      repro suite at whatever container owned the "joplin-mcp" name (e.g. a
 *      running dev stack) whenever `ps -q` came up empty.
 *   4. Direct vitest (without the runner script) keeps working: the repro test
 *      reads `JOPLIN_CONTAINER` with a `joplin-mcp` name fallback.
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = join(REPO_ROOT, 'docker-compose.test.yml');
const RUNNER_SCRIPT = join(REPO_ROOT, 'scripts', 'run-integration-tests.sh');
const REPRO_TEST = join(REPO_ROOT, 'tests', 'container', 'sqlite-busy-repro.test.ts');

describe('container test infrastructure config (M11)', () => {
  it('test compose does not pin a fixed container_name', () => {
    const compose = readFileSync(COMPOSE_FILE, 'utf-8');
    // A fixed container_name collides with other compose projects using the
    // same name (including the local dev stack). Compose generates a
    // project-scoped name instead; `compose ps -q -a` resolves it
    // unambiguously. The regex tolerates YAML-equivalent spellings (quoted
    // key and/or extra spacing before the colon).
    expect(compose).not.toMatch(/^\s*["']?container_name["']?\s*:/m);
  });

  it('test compose still reaches the MCP server via service-name DNS', () => {
    const compose = readFileSync(COMPOSE_FILE, 'utf-8');
    // Service-name DNS is project-scoped and independent of container_name,
    // so MCP_URL keeps working without a pinned container name.
    expect(compose).toContain('MCP_URL=http://joplin-mcp:3000/');
  });

  it('runner script resolves the container ID from the compose project and exports JOPLIN_CONTAINER', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf-8');
    // Resolve the ID via the compose service name. `-a` also resolves a
    // stopped container, so a service that exited between `up --wait` and
    // this line is still identified instead of being mistaken for "absent".
    expect(script).toContain('ps -q -a joplin-mcp');
    // Fail fast on empty resolution — the entire guard block must be present:
    // empty check, error on stderr, non-zero exit.
    expect(script).toMatch(
      /if \[ -z "\$JOPLIN_CONTAINER_ID" \]; then\s*\n\s*echo "ERROR: could not resolve joplin-mcp container [^"]*" >&2\s*\n\s*exit 1\s*\n\s*fi/,
    );
    // Deliberate contract change (review 2026-09-29): no name fallback. The
    // old `${JOPLIN_CONTAINER_ID:-joplin-mcp}` form silently redirected the
    // destructive repro suite at whatever container owned the "joplin-mcp"
    // name (e.g. a running dev stack) when resolution came up empty. It must
    // never return.
    expect(script).not.toMatch(/JOPLIN_CONTAINER_ID:-/);
    // Export the resolved ID verbatim (no default value in the expansion).
    expect(script).toContain('export JOPLIN_CONTAINER="$JOPLIN_CONTAINER_ID"');
    // ... and forward it into the test-runner container: vitest runs inside
    // `docker compose run`, where a host-side export alone does not reach it.
    expect(script.match(/-e "JOPLIN_CONTAINER=\$\{JOPLIN_CONTAINER\}"/g)?.length).toBe(2);
  });

  it('repro test keeps its JOPLIN_CONTAINER env override with joplin-mcp fallback', () => {
    const repro = readFileSync(REPRO_TEST, 'utf-8');
    // Guards the direct-vitest invocation path; the file itself is a non-goal
    // for M11 — this only pins the existing contract.
    expect(repro).toContain("process.env['JOPLIN_CONTAINER'] || 'joplin-mcp'");
  });
});
