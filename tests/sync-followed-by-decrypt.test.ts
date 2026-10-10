/**
 * Structural guards: EVERY sync completion path is followed by an E2EE
 * decrypt pass (issue #29 follow-up — testers still saw ciphertext after
 * sync, because two sync paths had no decrypt counterpart at all and the
 * periodic loop decrypted only on its fully-clean branch).
 *
 * The fix lives in `entrypoint-combined.sh` (shell), which the unit suite
 * cannot execute; like `tests/periodic-sync-e2ee-decrypt.test.ts`, these are
 * deliberately structural text assertions. The real behavior is covered by:
 *   - `tests/test-periodic-e2ee-decrypt.sh` (verbatim block extraction with
 *     stubbed node/flock/sleep — run manually or via CI shell step),
 *   - `tests/container/e2ee-decrypt-on-resync.test.ts` (real periodic loop
 *     against a real Joplin Server; RUN_E2EE_REPRO_TESTS=1 — unrun here).
 *
 * Pinned invariants (the sync → decrypt contract):
 *   1. Periodic loop: the decrypt call is a SIBLING of the SYNC_EXIT
 *      if/else (same indentation, after all its branches) — it runs on
 *      every cycle regardless of the sync exit code, check_sync_errors, or
 *      danger-check outcomes. Pre-fix it was nested inside the clean branch
 *      only, so a failed or error-flagged sync cycle never decrypted.
 *   2. Shutdown final sync: a decrypt call follows the final-sync if/else,
 *      inside the data-api-alive/no-halt-marker guard (the only context in
 *      which the final sync actually runs). Pre-fix this path had NO
 *      decrypt counterpart at all.
 *   3. Boot initial sync: the error branches (sync failed / errors logged
 *      despite exit 0) also run a decrypt pass before the M2-T1 success
 *      block. Pre-fix only the clean branch decrypted; the boot error
 *      branches deferred decryption to the (pre-fix unreliable) loop.
 *   4. Census: the entrypoint has exactly three `joplin sync` execution
 *      sites (boot, periodic loop, shutdown) — any new site must come with
 *      a decrypt counterpart and an update to these guards.
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRYPOINT = join(REPO_ROOT, 'entrypoint-combined.sh');

const entrypoint = readFileSync(ENTRYPOINT, 'utf-8');
const entrypointLines = entrypoint.split('\n');

/** Number of leading spaces of a line (the file uses spaces-only indent). */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** All 0-based line indices whose line satisfies the predicate. */
function indicesOf(predicate: (line: string, index: number) => boolean): number[] {
  const out: number[] = [];
  entrypointLines.forEach((l, i) => {
    if (predicate(l, i)) out.push(i);
  });
  return out;
}

/** First 1-based line number matching the pattern (0 = not found). */
function lineOf(pattern: RegExp, haystack: string = entrypoint): number {
  const idx = haystack.split('\n').findIndex((l) => pattern.test(l));
  return idx + 1;
}

/**
 * The setsid periodic-loop body: the lines between `setsid bash -c '` and
 * its closing `    ' &`.
 */
function setsidLoopBody(): string[] {
  const startIdx = entrypointLines.findIndex((l) => l.includes("setsid bash -c '"));
  expect(startIdx, 'setsid loop start not found').toBeGreaterThan(-1);
  const endIdx = entrypointLines.findIndex(
    (l, i) => i > startIdx && /^    ' &\s*$/.test(l),
  );
  expect(endIdx, 'setsid loop end not found').toBeGreaterThan(startIdx);
  return entrypointLines.slice(startIdx + 1, endIdx);
}

describe('every sync is followed by an E2EE decrypt pass (issue #29)', () => {
  const decryptCall = 'run_periodic_e2ee_decrypt || true';

  it('census: the entrypoint has exactly three joplin sync execution sites', () => {
    // Boot (:755) and shutdown (:1225) use a plain -c 'joplin sync'; the
    // loop body uses the quote-spliced form inside the setsid string. All
    // three contain the substring 'joplin sync'.
    const syncSites = indicesOf((l) => l.includes("'joplin sync'"));
    expect(syncSites.length).toBe(3);
  });

  it('GAP A — periodic loop: decrypt runs after EVERY sync outcome, not only the clean branch', () => {
    const body = setsidLoopBody();

    // Exactly one decrypt call inside the loop body.
    const callIdxs = body
      .map((l, i) => (l.trim() === decryptCall ? i : -1))
      .filter((i) => i >= 0);
    expect(callIdxs.length, 'expected exactly one decrypt call in the loop body').toBe(1);
    const callIdx = callIdxs[0]!;

    // SIBLING of the SYNC_EXIT if/else: same indentation as the `if` line,
    // i.e. NOT nested inside one of its branches. Pre-fix the call lived
    // inside the fully-clean else branch (deeper indentation), so any
    // nonzero sync exit or logged sync error skipped decryption entirely.
    const syncExitIfIdx = body.findIndex(
      (l) => l.trim() === 'if [ "${SYNC_EXIT}" -ne 0 ]; then',
    );
    expect(syncExitIfIdx, 'SYNC_EXIT if not found in loop body').toBeGreaterThan(-1);
    expect(indentOf(body[callIdx]!)).toBe(
      indentOf(body[syncExitIfIdx]!),
    );

    // And positioned after ALL of the if/else outcome handling (both
    // danger-check sites) but before the deletion breaker.
    const dangerIdxs = body
      .map((l, i) => (l.includes('check_sync_danger "Periodic"') ? i : -1))
      .filter((i) => i >= 0);
    expect(dangerIdxs.length).toBeGreaterThanOrEqual(2);
    expect(callIdx).toBeGreaterThan(dangerIdxs[dangerIdxs.length - 1]!);

    const breakerIdx = body.findIndex((l) =>
      l.includes('check_deletion_circuit_breaker "Periodic"'),
    );
    expect(breakerIdx).toBeGreaterThan(callIdx);
  });

  it('GAP B — shutdown: a decrypt pass follows the final sync (either exit-code branch)', () => {
    // The shutdown sync is the LAST plain `-c 'joplin sync'` flock site.
    const syncSites = indicesOf((l) => l.includes("-c 'joplin sync'"));
    const shutdownSyncIdx = syncSites[syncSites.length - 1]!;

    // The shutdown decrypt call is the LAST decrypt call in the file.
    const callSites = indicesOf((l) => l.trim() === decryptCall);
    expect(callSites.length, 'expected loop + shutdown decrypt calls').toBeGreaterThanOrEqual(2);
    const shutdownCallIdx = callSites[callSites.length - 1]!;

    // After the sync itself AND after both of its branches (the FAIL log is
    // the last statement of the failure branch).
    const finalFailIdx = entrypointLines.findIndex((l) =>
      l.includes('"Final sync failed (exit code:'),
    );
    expect(finalFailIdx).toBeGreaterThan(shutdownSyncIdx);
    expect(shutdownCallIdx).toBeGreaterThan(finalFailIdx);

    // Still inside the guard that owns the final sync (data API alive, no
    // halt marker) — a skipped final sync needs no decrypt counterpart.
    const guardIdx = entrypointLines.findIndex((l) =>
      l.includes('[ "${data_api_alive}" = true ]'),
    );
    const elifIdx = entrypointLines.findIndex((l) =>
      l.trim().startsWith('elif [ -f "${SYNC_HALT_MARKER}" ]; then'),
    );
    expect(shutdownCallIdx).toBeGreaterThan(guardIdx);
    expect(shutdownCallIdx).toBeLessThan(elifIdx);
  });

  it('boot — the initial-sync error branches also run a decrypt pass', () => {
    const bootSyncIdx = indicesOf((l) => l.includes("-c 'joplin sync'"))[0]!;
    const bootPassIdx = lineOf(/log_sync "PASS" "Initial sync completed successfully"/) - 1;
    const m2t1BeginIdx = lineOf(/# ----- M2-T1: post-sync E2EE decrypt \+ verification gate \(A\) -----/) - 1;

    expect(bootSyncIdx).toBeLessThan(bootPassIdx);
    expect(bootPassIdx).toBeLessThan(m2t1BeginIdx);

    // Between the boot sync and the success-branch M2-T1 block sit BOTH
    // error branches (sync failed / errors despite exit 0); each must end
    // with its own decrypt call. Pre-fix: zero calls in this window.
    const errBranchCalls = indicesOf(
      (l, i) => i > bootSyncIdx && i < m2t1BeginIdx && l.trim() === decryptCall,
    );
    expect(
      errBranchCalls.length,
      'expected a decrypt call in each boot error branch',
    ).toBeGreaterThanOrEqual(2);
  });

  it('boot — the clean branch keeps the fail-closed M2-T1 decrypt after the PASS line', () => {
    const bootPassIdx = lineOf(/log_sync "PASS" "Initial sync completed successfully"/);
    const m2t1BeginIdx = lineOf(/# ----- M2-T1: post-sync E2EE decrypt \+ verification gate \(A\) -----/);
    expect(m2t1BeginIdx).toBeGreaterThan(bootPassIdx);
  });
});
