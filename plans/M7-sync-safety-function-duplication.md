# M7 — Sync-Safety Function Duplication: Record Decision, Optional Sourced Module

> Source: [`docs/code-review-testing-2026-09-21.md`](../docs/code-review-testing-2026-09-21.md)
> finding **S1** (SUGGESTION).
>
> **User decision (recorded):** the duplication is **DELIBERATE** — the
> byte-identical copies in the test harness are accepted harness pragmatism for
> the issue #27 test setup (test independence from entrypoint refactors). This
> milestone is therefore **low-priority documentation + optional hardening**,
> not a mandated refactor.

## Problem

The three sync-safety functions —
[`check_sync_errors`](../entrypoint-combined.sh:71),
[`check_sync_danger`](../entrypoint-combined.sh:117),
[`get_sync_item_count`](../entrypoint-combined.sh:153), and
[`check_deletion_circuit_breaker`](../entrypoint-combined.sh:174) (~120 lines
total) — are maintained as byte-identical copies in
[`tests/test-check-sync-errors.sh:15-163`](../tests/test-check-sync-errors.sh:15)
(each block carries a "Copy ... exactly from entrypoint-combined.sh" comment).
If the entrypoint changes, the tests keep validating the **stale copy** and
pass vacuously. The copy pattern also forces the `export -f` machinery at
[`entrypoint-combined.sh:483-484`](../entrypoint-combined.sh:483) for the
`bash -c` sync-loop subshell, and keeps a large inline `setsid bash -c`
string.

**Accepted risk (per user decision):** until this lands (or indefinitely, if
the team prefers), drift between the entrypoint and the test copy is a known
gap. The mitigations below are documentation-first; the sourced-module
refactor is optional and explicitly not required.

## Goal

1. Make the deliberate-acceptance decision discoverable (comments at both copy
   sites and a lockstep-sync note in the docs), so future contributors do not
   "fix" the duplication blindly — or silently let it rot.
2. Optionally (follow-up, separately schedulable): extract the functions into a
   sourced shell module to remove the copy-paste class of defect entirely.

## Proposed Approach

### Documentation (this milestone)

- [`tests/test-check-sync-errors.sh`](../tests/test-check-sync-errors.sh:15):
  extend the existing header comment at the first copy with an explicit note:
  "Duplication of these functions is DELIBERATE (test independence, review
  2026-09-21 S1). If you change them in `entrypoint-combined.sh`, update the
  copies here in the same commit, or the tests validate stale logic."
- [`entrypoint-combined.sh`](../entrypoint-combined.sh:112): add a matching
  one-line note above `check_sync_danger`: "Tests duplicate these functions
  verbatim (tests/test-check-sync-errors.sh) — keep in lockstep."
- [`docs/code-review-testing-2026-09-21.md`](../docs/code-review-testing-2026-09-21.md):
  no change needed — the user confirmation is already recorded there.

### Optional hardening (follow-up, only if scheduled)

Move the six functions (`log`, `log_sync`, `check_sync_errors`,
`check_sync_danger`, `get_sync_item_count`,
`check_deletion_circuit_breaker`) into `scripts/sync-safety.sh` (mounted or
installed as `/usr/local/bin/sync-safety.sh` in the image), `source` it from
both [`entrypoint-combined.sh`](../entrypoint-combined.sh:1) and
[`tests/test-check-sync-errors.sh`](../tests/test-check-sync-errors.sh:1).
This makes the `export -f` list
([`entrypoint-combined.sh:484`](../entrypoint-combined.sh:484)) and the
structural grep tests asserting exports
([`tests/test-sync-failure-diagnostics.sh:70-119`](../tests/test-sync-failure-diagnostics.sh:70),
see M8) largely moot, and shrinks the inline `setsid bash -c` body.

## Acceptance Criteria

- Both copy sites carry the deliberate-duplication note naming review finding
  S1 and the lockstep-update obligation.
- No functional code changes; `bash tests/test-check-sync-errors.sh` output
  and pass counts unchanged.
- (Optional track only) a single `scripts/sync-safety.sh` exists; both
  consumers source it; no byte-identical copies remain; export list and
  comment at [`entrypoint-combined.sh:478-484`](../entrypoint-combined.sh:478)
  updated to match.

## Verification

1. `bash tests/test-check-sync-errors.sh` → all tests pass (unchanged counts).
2. `bash tests/test-sync-failure-diagnostics.sh` → all tests pass (structure
   assertions still match the entrypoint).
3. Grep check: `grep -n "DELIBERATE" tests/test-check-sync-errors.sh
   entrypoint-combined.sh` finds both notes.
4. (Optional track) `docker compose -f docker-compose.test.yml build` succeeds
   with the new module in the image; full gated test run green.

## Non-goals

- Unilaterally refactoring to the sourced module without scheduling (user
  decision recorded as accepted tech debt).
- Changing any detection logic or thresholds.
