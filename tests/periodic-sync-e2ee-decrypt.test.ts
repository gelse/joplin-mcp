/**
 * Structural guards for the periodic-path post-sync E2EE decrypt (issue #29,
 * comment 6072403277) and its container-test harness.
 *
 * The fix lives in `entrypoint-combined.sh` (shell), which the unit suite
 * cannot execute; like `tests/docker-test-config.test.ts` and the grep-based
 * harnesses in `tests/test-sync-*.sh` (review 2026-09-21 S2), these are
 * deliberately structural text assertions. The real behavior is covered by:
 *   - `tests/test-periodic-e2ee-decrypt.sh` (verbatim block extraction with
 *     stubbed node/flock/sleep — run manually or via CI shell step),
 *   - `tests/container/e2ee-decrypt-on-resync.test.ts` (real periodic loop
 *     against a real Joplin Server; RUN_E2EE_REPRO_TESTS=1).
 *
 * Pinned invariants:
 *   1. A `run_periodic_e2ee_decrypt` function exists between the extraction
 *      markers, is `export -f`'d (the setsid loop child cannot see
 *      non-exported functions), and gates on JOPLIN_MASTER_PASSWORD.
 *   2. The periodic loop body calls it AFTER the periodic [SYNC_PASS] line —
 *      decrypt runs on every successful periodic sync, only there.
 *   3. The periodic helper NEVER halts: no SYNC_HALT_MARKER write and no
 *      START_PERIODIC_LOOP assignment inside it (halt semantics in the loop
 *      are M13's detect-and-halt scope).
 *   4. The boot M2-T1 block stays intact (its fail-closed markers, probes,
 *      and [E2EE_NO_MASTER_KEY] handling are NOT regressed by the fix).
 *   5. The resync harness: compose interpolates SYNC_INTERVAL_SECONDS
 *      (default 9999 = historical behavior), the runner exports a short
 *      interval for the recreated joplin-mcp, runs the phase-2 seeder and
 *      the resync repro as isolated vitest invocations (--no-deps so a
 *      pre-fix unhealthy E2EE healthcheck cannot block the run).
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRYPOINT = join(REPO_ROOT, 'entrypoint-combined.sh');
const COMPOSE_FILE = join(REPO_ROOT, 'docker-compose.test.yml');
const RUNNER_SCRIPT = join(REPO_ROOT, 'scripts', 'run-integration-tests.sh');
const SEEDER = join(REPO_ROOT, 'tests', 'container', 'fixtures', 'e2ee-seed.sh');

const entrypoint = readFileSync(ENTRYPOINT, 'utf-8');
const entrypointLines = entrypoint.split('\n');

function lineOf(pattern: RegExp, haystack: string = entrypoint): number {
  const idx = haystack.split('\n').findIndex((l) => pattern.test(l));
  return idx + 1; // 1-based; 0 = not found
}

/** Extract the text between the periodic-E2EE extraction markers. */
function periodicBlock(): string {
  const begin = lineOf(/# ----- periodic-E2EE block begin/);
  const end = lineOf(/# ----- periodic-E2EE block end -----/);
  expect(begin, 'periodic-E2EE begin marker missing from entrypoint-combined.sh').toBeGreaterThan(0);
  expect(end, 'periodic-E2EE end marker missing from entrypoint-combined.sh').toBeGreaterThan(begin);
  return entrypointLines.slice(begin, end - 1).join('\n');
}

describe('periodic post-sync E2EE decrypt structure (issue #29 comment 6072403277)', () => {
  it('defines run_periodic_e2ee_decrypt between the extraction markers', () => {
    const block = periodicBlock();
    expect(block).toContain('run_periodic_e2ee_decrypt() {');
  });

  it('gates the helper on JOPLIN_MASTER_PASSWORD (non-E2EE deployments pay nothing)', () => {
    const block = periodicBlock();
    // Line-based on real anchors: the block's header comment also mentions
    // the decrypt command, so raw indexOf would match prose, not code.
    const guardLine = lineOf(/if \[ -z "\$\{JOPLIN_MASTER_PASSWORD:-\}" \]; then/, block);
    const probeLine = lineOf(/local periodic_mk_probe_script=/, block);
    const decryptLine = lineOf(
      /flock -w 120 "\$\{SYNC_LOCK_FILE\}" -c 'joplin e2ee decrypt --force'/,
      block,
    );
    expect(guardLine).toBeGreaterThan(0);
    expect(probeLine).toBeGreaterThan(guardLine);
    expect(decryptLine).toBeGreaterThan(guardLine);
  });

  it('keeps the boot ordering inside the helper: master-key preflight before decrypt', () => {
    const block = periodicBlock();
    const mkLine = lineOf(/syncInfoCache/, block);
    const decryptLine = lineOf(/Running periodic post-sync E2EE decrypt/, block);
    expect(mkLine).toBeGreaterThan(0);
    expect(decryptLine).toBeGreaterThan(mkLine);
  });

  it('uses the same bounded retry as boot: 4 attempts × 5 s, flock-serialized, --force', () => {
    const block = periodicBlock();
    expect(block).toContain('decrypt_max_attempts=4');
    expect(block).toContain('decrypt_backoff_s=5');
    expect(block).toMatch(/flock -w 120 "\$\{SYNC_LOCK_FILE\}" -c 'joplin e2ee decrypt --force'/);
  });

  it('never halts from the periodic path: no halt marker write, no START_PERIODIC_LOOP', () => {
    const block = periodicBlock();
    expect(block).not.toContain('> "${SYNC_HALT_MARKER}"');
    expect(block).not.toContain('START_PERIODIC_LOOP=');
  });

  it('writes decrypt output only to e2ee-decrypt-*.log (no sync-log pollution)', () => {
    const block = periodicBlock();
    // The next cycle's check_sync_errors greps sync-stdout/stderr.log in
    // full; stale decrypt stderr there would false-FAIL a later clean sync.
    expect(block).toContain('e2ee-decrypt-stdout.log');
    expect(block).toContain('e2ee-decrypt-stderr.log');
    expect(block).not.toContain('sync-stdout.log');
    expect(block).not.toContain('sync-stderr.log');
  });

  it('exports the helper (and decrypt_stderr_summary) to the setsid loop child', () => {
    const exportLine = entrypointLines.find((l) => l.startsWith('export -f '));
    expect(exportLine).toBeDefined();
    expect(exportLine).toMatch(/\brun_periodic_e2ee_decrypt\b/);
    expect(exportLine).toMatch(/\bdecrypt_stderr_summary\b/);
    // The loop-side gate reads the password from the environment.
    const varExport = entrypointLines.find((l) => l.startsWith('export SYNC_INTERVAL_SECONDS'));
    expect(varExport).toBeDefined();
    expect(varExport).toMatch(/\bJOPLIN_MASTER_PASSWORD\b/);
  });

  it('the periodic loop body calls the helper after the periodic [SYNC_PASS] line', () => {
    const passLine = lineOf(/log_sync "PASS" "Periodic sync completed successfully"/);
    const callLine = lineOf(/run_periodic_e2ee_decrypt \|\| true/);
    const setsidLine = lineOf(/setsid bash -c '/);
    expect(passLine).toBeGreaterThan(0);
    expect(setsidLine).toBeGreaterThan(0);
    expect(callLine).toBeGreaterThan(setsidLine); // inside the loop string
    expect(callLine).toBeGreaterThan(passLine); // after the sync-pass log
    expect(callLine).toBeLessThan(lineOf(/check_deletion_circuit_breaker "Periodic"/));
  });

  it('keeps exactly two flock-wrapped decrypt call sites: boot block + periodic helper', () => {
    const calls = entrypoint.match(/flock -w 120 "\$\{SYNC_LOCK_FILE\}" -c 'joplin e2ee decrypt --force'/g);
    expect(calls?.length).toBe(2);
  });

  it('does not regress the boot M2-T1 fail-closed block', () => {
    expect(entrypoint).toContain('# ----- M2-T1: post-sync E2EE decrypt + verification gate (A) -----');
    expect(entrypoint).toContain('# ----- end M2-T1 block -----');
    // The boot-only fail-closed vocabulary stays boot-only (the periodic
    // helper logs SYNC_FAIL/SKIP instead of writing markers).
    expect(entrypoint).toContain('[E2EE_NO_MASTER_KEY]');
    expect(entrypoint).toContain('E2EE_DECRYPT_FAIL');
    expect(entrypoint).toContain('check_e2ee_state "Initial"');
  });
});

describe('decrypt-on-resync harness structure (issue #29 reproduction)', () => {
  it('compose interpolates SYNC_INTERVAL_SECONDS with the historical 9999 default', () => {
    const compose = readFileSync(COMPOSE_FILE, 'utf-8');
    expect(compose).toContain('SYNC_INTERVAL_SECONDS=${SYNC_INTERVAL_SECONDS:-9999}');
  });

  it('runner shortens the interval for the recreated joplin-mcp only', () => {
    const runner = readFileSync(RUNNER_SCRIPT, 'utf-8');
    // Overridable, short-by-default export, placed inside the e2ee branch
    // (after the first `up -d joplin-mcp`, before the --force-recreate).
    expect(runner).toContain('export SYNC_INTERVAL_SECONDS="${E2EE_RESYNC_SYNC_INTERVAL:-20}"');
    const exportLine = lineOf(/export SYNC_INTERVAL_SECONDS="\$\{E2EE_RESYNC_SYNC_INTERVAL:-20\}"/, runner);
    const recreateLine = lineOf(/up -d --force-recreate --wait --no-deps joplin-mcp/, runner);
    expect(exportLine).toBeGreaterThan(0);
    expect(recreateLine).toBeGreaterThan(exportLine);
  });

  it('runner seeds phase-2 remote fixtures AFTER joplin-mcp boots against the real server', () => {
    const runner = readFileSync(RUNNER_SCRIPT, 'utf-8');
    expect(runner).toContain('E2EE_RESYNC_NOTEBOOK_TITLE=ResyncNotebook-${E2EE_RESYNC_MARKER}');
    expect(runner).toContain('E2EE_RESYNC_NOTE_TITLE=ResyncNote-${E2EE_RESYNC_MARKER}');
    // The phase-2 seeder must run after the recreated container is healthy
    // (that is what makes the pair reachable ONLY via the periodic loop).
    const seedPhase2Line = lineOf(/E2EE_RESYNC_NOTEBOOK_TITLE=ResyncNotebook-/, runner);
    const recreateLine = lineOf(/up -d --force-recreate --wait --no-deps joplin-mcp/, runner);
    expect(seedPhase2Line).toBeGreaterThan(recreateLine);
  });

  it('runner executes the resync repro in an isolated vitest invocation with --no-deps', () => {
    const runner = readFileSync(RUNNER_SCRIPT, 'utf-8');
    expect(runner).toContain('tests/container/e2ee-decrypt-on-resync.test.ts');
    expect(runner).toMatch(/run --no-deps --rm \\\n\s+-e "RUN_E2EE_REPRO_TESTS=1" \\\n\s+-e "E2EE_RESYNC_MARKER=\$\{E2EE_RESYNC_MARKER:-\}"/);
  });

  it('seeder refuses to mark phase-2 fixtures synced unless verified encrypted on the server', () => {
    const seeder = readFileSync(SEEDER, 'utf-8');
    expect(seeder).toContain('.e2ee-resync-marker.json');
    // Anti-vacuous: marker write happens only after the keyless-profile
    // verification confirmed encryption_applied=1 on both fixtures.
    const verifyFailIdx = seeder.indexOf('phase-2 fixtures are NOT encrypted on the server');
    const markerWriteIdx = seeder.indexOf('cat > "${MARKER_DIR}/.e2ee-resync-marker.json"');
    expect(verifyFailIdx).toBeGreaterThan(-1);
    expect(markerWriteIdx).toBeGreaterThan(verifyFailIdx);
  });
});
