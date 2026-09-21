# Code Review: `testing` branch (issue #27 SQLITE_BUSY fixes, circuit-breaker, repro harness)

- **Date:** 2026-09-21
- **Scope:** `git diff main...testing` — 15 commits, 21 files, +3,175/-65. Merge-base `c808d7e`.
- **Focus:** clean code / KISS, separation of concerns, single responsibility, error handling, duplication, testability.
- **Static review only** (no node/npx on host; tests not executed).

## Summary

The branch adds a defense-in-depth sync-safety layer to `entrypoint-combined.sh` (flock serialization, destructive-signature detection with halt marker, deletion circuit-breaker), a `SYNC_MAX_DELETE_COUNT` config knob, a 683-line destructive-migration repro test, and extensive shell-based unit/structure tests. Overall quality is solid: return-code contracts are documented, `set -e` invariants are handled explicitly, and the repro harness hardening is well-commented. Three WARNING-level issues were found, plus several suggestions.

**Verdict: NEEDS CHANGES** — 3 WARNING, 6 SUGGESTION.

## Findings

### WARNING

**W1 — `syncMaxDeleteCount` config is dead code; default duplicated across two runtimes**

- **Files:** `src/config.ts:44`, `tests/config.test.ts:181`
- **Problem:** `syncMaxDeleteCount` is added to the zod schema, validated, tested (6 test cases), and documented in the error help text — but nothing in `src/` ever reads it. The only consumer is `entrypoint-combined.sh`, which reads the raw env var with its own hardcoded default `100` (`entrypoint-combined.sh:252`) and its own ad-hoc validation. Consequences:
  - Two independent sources of truth for the default and validation semantics. The TS schema rejects `-2`, but the entrypoint's `[ "${SYNC_MAX_DELETE_COUNT}" -lt 0 ]` treats any negative value as "disabled" — the validated config and the actually-enforced behavior diverge.
  - The zod validation provides false assurance: a caller may believe `SYNC_MAX_DELETE_COUNT` is validated because `parseConfig()` runs, when in fact the shell consumes it unvalidated.
  - Violates single-responsibility/clean-code: `config.ts` now owns a setting it does not apply.
- **Suggestion:** Either (a) remove `syncMaxDeleteCount` from `src/config.ts` and its tests, documenting `SYNC_MAX_DELETE_COUNT` as a container-level (entrypoint) setting only (mirroring `.env.example`, which correctly frames it as entrypoint-level), or (b) actually consume the parsed value in `src/` — but given the enforcement point is the shell entrypoint, (a) is the KISS option. *(User confirmed this is an oversight, not deliberate.)*

**W2 — Final-sync danger check is vacuous: log window computed after the sync ran**

- **File:** `entrypoint-combined.sh:654-673` (offset computed at `:664`)
- **Problem:** In `cleanup()`, the final sync executes first, and only afterwards is `LOG_TAIL_START` computed as `$(wc -l < log.txt) + 1`. `check_sync_danger "Final" "${LOG_TAIL_START}"` therefore tails from *after the last existing line* — an empty window. Destructive signatures written by the final sync itself (exactly the scenario issue #27 protects against) can never be detected on this path. The `sync-stdout.log`/`sync-stderr.log` branches of `check_sync_danger` don't help either: the final sync redirects all output to `/dev/null`, so those files still hold the *previous* sync's content.
- **Suggestion:** Capture `LOG_TAIL_START` *before* `flock ... joplin sync`, mirroring the initial (`:426`) and periodic (`:506`) paths. Optionally also capture the final sync's stdout/stderr to the standard log files instead of `/dev/null` so the danger scan has real input.

**W3 — Deletion circuit-breaker is blind to a silently-failing *pre*-sync count**

- **Files:** `entrypoint-combined.sh:158-183` (`get_sync_item_count`), `:174-241` (`check_deletion_circuit_breaker`, suspicious-zero guard at `:204-215`)
- **Problem:** The suspicious-zero guard (F3) protects against `joplin ls` failing with exit 0 and empty output — but only on the *post*-sync measurement. If the **pre**-sync count silently returns 0 while the profile actually holds items, and the sync then deletes everything (post-count legitimately 0), the breaker computes `deleted = 0 - 0 = 0` and passes. The exact data-loss scenario the breaker exists to catch slips through, because the asymmetric guard only distrusts the post-count. The comment at `:214-216` acknowledges `joplin ls` can fail silently in either direction.
- **Suggestion:** Apply the same distrust to the pre-count: when `pre_count` is 0, retry once and skip the check (return 1) if it is still 0 — the breaker can only compare like-for-like trusted measurements, and skipping is the safe default.

### SUGGESTION

**S1 — Sync-safety logic triplicated; extract a sourced shell module**

- **Files:** `entrypoint-combined.sh:109-241`, `tests/test-check-sync-errors.sh:55-172`
- **Problem:** `check_sync_danger`, `get_sync_item_count`, and `check_deletion_circuit_breaker` (~120 lines) are maintained as byte-identical copies in the entrypoint and the unit-test script ("Copy ... exactly from entrypoint-combined.sh"). If the entrypoint changes, the tests keep validating the stale copy and pass vacuously. This was confirmed as deliberate harness pragmatism for issue #27, so it is not blocking — but there is a cheap structural fix that also addresses the export complexity.
- **Suggestion:** Move the three functions (plus `log`/`log_sync`/`check_sync_errors`) into e.g. `scripts/sync-safety.sh` (or `/usr/local/bin/sync-safety.sh` inside the image), `source` it from both the entrypoint and the test script. This removes the copy-paste, the `export -f` acrobatics required by the `bash -c` subshell loop (`entrypoint-combined.sh:478-484`), and shrinks the giant inline `setsid bash -c '...'` string — a direct separation-of-concerns win.

**S2 — Structural grep tests are brittle and validate implementation, not behavior**

- **File:** `tests/test-sync-failure-diagnostics.sh:64-118` (Group 1b)
- **Problem:** Tests like `grep -q 'export -f.*get_sync_item_count'`, `grep -A5 "Sync halt marker exists" | grep -q "continue"`, and the occurrence-count check at `:464-465` assert the entrypoint's *text*, not its behavior. Any refactor (renaming a variable, reordering lines, collapsing the export list) breaks them without any behavioral change; conversely they would pass on a copy of the entrypoint where the loop was dead code. Deliberate per user clarification — noted as accepted tech debt.
- **Suggestion:** Medium-term, replace the export/export -f assertions with the sourced-module approach from S1 (which makes the export questions moot) and keep only the genuinely behavioral tests (Groups 3/4, which are good).

**S3 — Final-sync danger trip does not write the halt marker (inconsistent contract)**

- **File:** `entrypoint-combined.sh:666-668`
- **Problem:** On the initial and periodic paths, `check_sync_danger` returning 2 writes `SYNC_HALT_MARKER`. On the final (shutdown) path a return of 2 only logs `ABORT` — no marker. Since the container is exiting this is mostly moot, but for restart policies (`docker restart`, compose `restart: unless-stopped`) the next boot loses the "destructive sync detected" signal and the halt gate at startup (`:273-276`) never fires.
- **Suggestion:** Write the marker on the final path too, for consistency with the other two call sites.

**S4 — Docker socket mounted into the test container**

- **Files:** `docker-compose.test.yml:38`, `Dockerfile.tests:16-19`
- **Problem:** Mounting `/var/run/docker.sock` grants the test-runner container root-equivalent control over the host daemon. Necessary for the repro harness (`docker exec` into the sibling container) and confined to the test compose file / gated CI job, but worth an explicit caveat.
- **Suggestion:** Add a comment in `docker-compose.test.yml` and/or the CI workflow noting the privilege implication and that the job is manually dispatched only (the workflow comment partially covers this — one line at the mount site would complete it).

**S5 — Fixed `container_name: joplin-mcp` in test compose prevents parallel/stacked runs**

- **File:** `docker-compose.test.yml:7`
- **Problem:** A hard container name collides with any other compose project using the same name (including a locally running production-ish stack) and with concurrent CI jobs on the same runner. It exists so the repro test can `docker exec` by name (`tests/container/sqlite-busy-repro.test.ts:31` defaults to `joplin-mcp`).
- **Suggestion:** Derive the target container from the compose project (e.g. `docker compose ps -q joplin-mcp` in `scripts/run-integration-tests.sh`, passed in as `JOPLIN_CONTAINER`) instead of a fixed name.

**S6 — Periodic halt gate doubles the sleep interval**

- **File:** `entrypoint-combined.sh:509-514`
- **Problem:** The loop body starts with `sleep "${SYNC_INTERVAL_SECONDS}"`; the halt-gate branch then does another full `sleep` before `continue`, so once the marker is present the gate message repeats every `2 × SYNC_INTERVAL_SECONDS` and the loop is idle twice as long per iteration. Harmless (the loop refuses to sync either way) but the second sleep serves no purpose and mildly obscures the loop invariant.
- **Suggestion:** Drop the inner `sleep`; `continue` alone returns to the top-of-loop sleep.

## Non-findings (verified, no issue)

- `get_sync_item_count` failure detection relies on `pipefail` — both the entrypoint (`entrypoint-combined.sh:2`) and the test copy (`tests/test-check-sync-errors.sh:3`) set `set -euo pipefail`, so the `flock | wc -l` pipeline correctly reports upstream failure.
- The `START_PERIODIC_LOOP` unbound-variable hazard under `set -u` is correctly handled with `: "${START_PERIODIC_LOOP:=0}"` (`entrypoint-combined.sh:486`).
- The repro test's capture-precondition assertions (`tests/container/sqlite-busy-repro.test.ts:584-591`) correctly prevent vacuous passes on empty/missing captures.
- `vitest` file-level gating via `describe.skip` plus the separate invocation in `scripts/run-integration-tests.sh` is consistent; the repro cannot leak into sibling suites.

## Escalated ambiguities (resolved)

Per review constraints, three patterns were escalated rather than assumed:

1. **Function copy-paste in `tests/test-check-sync-errors.sh`** → user confirmed: deliberate harness pragmatism (recorded as S1).
2. **Grep-based structural tests in `tests/test-sync-failure-diagnostics.sh`** → user confirmed: deliberate (recorded as S2).
3. **Dead `syncMaxDeleteCount` in `src/config.ts`** → user confirmed: an oversight, flag as WARNING (recorded as W1).
