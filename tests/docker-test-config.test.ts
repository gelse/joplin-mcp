/**
 * Structural guards for the docker-based unit test infrastructure
 * (`make docker-test`), added so the unit suite can run on machines
 * without node/pnpm installed.
 *
 * Like `tests/integration-runner-config.test.ts` and the grep-based
 * harnesses in `tests/test-sync-*.sh` (review 2026-09-21 S2), these are
 * deliberately structural text assertions: the real behavior (a clean
 * docker build, a passing in-container vitest run) is verified by running
 * `make docker-test` on a machine with docker, not by unit tests.
 *
 * The guards pin four invariants:
 *   1. The Makefile exposes `docker-test` as a first-class, documented
 *      target that delegates to the runner script.
 *   2. The runner script builds the unit-test image, runs ONLY the unit
 *      suite (no integration stack, no docker socket, no compose file,
 *      RUN_INTEGRATION_TESTS never set), persists the JUnit report on the
 *      host, cleans up the container, and propagates the test exit code.
 *   3. The unit-test image pins pnpm (reproducible builds, the lockfile is
 *      lockfileVersion 9.0) and does NOT install docker.io — that belongs
 *      to the integration image (Dockerfile.tests).
 *   4. The image COPYs every repo file the unit suite reads at runtime, so
 *      the structural tests pass inside the container too.
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAKEFILE = join(REPO_ROOT, 'Makefile');
const RUNNER_SCRIPT = join(REPO_ROOT, 'scripts', 'run-unit-tests-docker.sh');
const UNIT_DOCKERFILE = join(REPO_ROOT, 'Dockerfile.unittests');

describe('docker unit test infrastructure config', () => {
  it('Makefile declares docker-test in .PHONY with a help comment and the runner script', () => {
    const makefile = readFileSync(MAKEFILE, 'utf-8');
    expect(makefile).toMatch(/^\.PHONY:.*\bdocker-test\b/m);
    expect(makefile).toMatch(/^docker-test:.*## .+/m);
    // The target's recipe must actually invoke the runner script.
    expect(makefile).toMatch(/^docker-test:.*\n\tbash scripts\/run-unit-tests-docker\.sh/m);
  });

  it('runner script is strict, builds the unit image, and cleans up via --rm', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf-8');
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('docker build');
    expect(script).toContain('Dockerfile.unittests');
    expect(script).toContain('--rm');
  });

  it('runner script persists reports on the host via a bind mount and prints the path', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf-8');
    // Create the host directory, bind-mount it over the container's
    // /app/reports (where the junit reporter writes), and echo the path.
    expect(script).toMatch(/mkdir -p "\$REPORTS_DIR"/);
    expect(script).toContain('-v "${REPORTS_DIR}:/app/reports"');
    expect(script).toMatch(/\$\{REPORTS_DIR\}\/junit\.xml/);
  });

  it('runner script captures and propagates the test exit code', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf-8');
    expect(script).toContain('|| TEST_EXIT=$?');
    expect(script).toMatch(/exit "\$TEST_EXIT"/);
  });

  it('runner script runs nothing but the unit suite', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf-8');
    // integration.test.ts self-skips unless RUN_INTEGRATION_TESTS is truthy;
    // the runner must never set it (no env assignment, no `docker run -e`),
    // and must never pass it through from the host via the bare `-e NAME`
    // / `--env NAME` form either.
    expect(script).not.toContain('RUN_INTEGRATION_TESTS=');
    expect(script).not.toMatch(/(?:^|\s)(?:-e|--env)\s+RUN_INTEGRATION_TESTS\b/);
    // The integration stack and the docker socket belong to the container
    // integration flow, not to unit tests.
    expect(script).not.toContain('docker-compose');
    expect(script).not.toContain('docker.sock');
    expect(script).not.toContain('/var/run/docker.sock');
  });

  it('unit-test image pins pnpm instead of pnpm@latest', () => {
    const dockerfile = readFileSync(UNIT_DOCKERFILE, 'utf-8');
    expect(dockerfile).not.toContain('pnpm@latest');
    expect(dockerfile).toMatch(/corepack prepare pnpm@\d+\.\d+\.\d+ --activate/);
  });

  it('unit-test image does not install docker.io or mount the docker socket', () => {
    const dockerfile = readFileSync(UNIT_DOCKERFILE, 'utf-8');
    // docker.io is only needed by the integration image (Dockerfile.tests);
    // the unit image has no reason for apt-get at all.
    expect(dockerfile).not.toContain('docker.io');
    expect(dockerfile).not.toContain('apt-get');
    expect(dockerfile).not.toContain('docker.sock');
  });

  it('unit-test image COPYs every file the unit suite reads at runtime', () => {
    const dockerfile = readFileSync(UNIT_DOCKERFILE, 'utf-8');
    // tests/integration-runner-config.test.ts reads these repo-root-relative
    // paths at runtime — without them the unit suite fails in-container.
    expect(dockerfile).toMatch(/^COPY\s+.*docker-compose\.test\.yml/m);
    expect(dockerfile).toMatch(/^COPY\s+.*entrypoint-combined\.sh/m);
    expect(dockerfile).toMatch(/^COPY scripts\/ scripts\//m);
    expect(dockerfile).toMatch(/^COPY tests\/ tests\//m);
    // This guard test itself reads the Makefile and the unit Dockerfile.
    expect(dockerfile).toMatch(/^COPY\s+.*Makefile/m);
    expect(dockerfile).toMatch(/^COPY\s+.*Dockerfile\.unittests/m);
  });

  it('unit-test image runs the unit suite via pnpm test', () => {
    const dockerfile = readFileSync(UNIT_DOCKERFILE, 'utf-8');
    expect(dockerfile).toContain('CMD ["pnpm", "run", "test"]');
  });
});
