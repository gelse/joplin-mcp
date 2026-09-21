# M8 — Structural Grep Tests Validate Text, Not Behavior: Record Decision

> Source: [`docs/code-review-testing-2026-09-21.md`](../docs/code-review-testing-2026-09-21.md)
> finding **S2** (SUGGESTION).
>
> **User decision (recorded):** the grep-based structural tests are
> **DELIBERATE** — accepted tech debt. This milestone is **low-priority
> documentation**, recording the decision so the trade-off is explicit.

## Problem

Group 1b of [`tests/test-sync-failure-diagnostics.sh:64-119`](../tests/test-sync-failure-diagnostics.sh:64)
asserts the entrypoint's **text** rather than its behavior, e.g.:

- `grep -q 'export -f.*check_sync_danger'` (line 71–72) — breaks on any export
  reordering, passes on a copy where the export is dead.
- `grep -A5 "Sync halt marker exists" | grep -q "continue"` (lines 93–94) —
  sensitive to unrelated line insertions near the gate.
- Occurrence-count checks such as the flock-site count at
  [`tests/test-sync-failure-diagnostics.sh:83-84`](../tests/test-sync-failure-diagnostics.sh:83).

Consequences: any refactor (renaming a variable, collapsing the export list)
breaks these tests with **no behavioral change**; conversely they would pass on
an entrypoint where the guarded code was dead. The genuinely behavioral tests
(Groups 3/4 of the harness, which invoke the copied functions against fixture
logs) are good and stay.

**Line-reference correction vs. the review doc:** the review cited an
"occurrence-count check at `:464-465`"; the file is 315 lines and the actual
flock occurrence check is at
[`tests/test-sync-failure-diagnostics.sh:83-84`](../tests/test-sync-failure-diagnostics.sh:83).
The cited lines do not exist in the current file.

## Goal

Record the deliberate acceptance of the structural-test brittleness so the
trade-off survives team churn, and point future refactors at the cheap
structural fix (sourced module, M7) that would retire most of these assertions
naturally.

## Proposed Approach

Documentation only:

- [`tests/test-sync-failure-diagnostics.sh`](../tests/test-sync-failure-diagnostics.sh:64):
  add a comment block above the Group 1b header: "These are STRUCTURAL tests —
  they validate entrypoint text, not behavior (deliberate, review 2026-09-21
  S2). They are intentionally brittle to refactors; if you restructure
  `entrypoint-combined.sh`, expect to update them. Behavioral coverage lives
  in Groups 3/4 here and in tests/test-check-sync-errors.sh."
- [`README.md`](../README.md): where the test suite is documented, add one
  sentence noting the structural-test layer is intentionally text-based and
  accepted as such.

## Acceptance Criteria

- The Group 1b header carries the deliberate/accepted note referencing review
  finding S2.
- No test changes; both shell harnesses produce identical results before and
  after.

## Verification

1. `bash tests/test-sync-failure-diagnostics.sh` → unchanged pass/fail counts.
2. `bash tests/test-check-sync-errors.sh` → unchanged pass/fail counts.
3. `grep -n "S2" tests/test-sync-failure-diagnostics.sh` finds the note.

## Non-goals

- Replacing the structural assertions with behavioral tests (rejected for now
  per user decision; revisit together with M7's optional sourced-module track,
  which would make the export assertions moot).
- Touching Groups 3/4 (behavioral — already correct).
