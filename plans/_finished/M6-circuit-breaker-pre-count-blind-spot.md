# M6 — Circuit-Breaker Blind Spot: Distrust a Silently-Zero Pre-Sync Count

> Source: [`docs/code-review-testing-2026-09-21.md`](../docs/code-review-testing-2026-09-21.md)
> finding **W3** (WARNING).

## Problem

The deletion circuit-breaker
([`check_deletion_circuit_breaker`](../entrypoint-combined.sh:174)) applies its
suspicious-zero guard ([`entrypoint-combined.sh:197-207`](../entrypoint-combined.sh:197))
**only to the post-sync count**. A pre-sync measurement that silently returns
`0` — `joplin ls` failing with exit 0 and empty output, a failure mode the
in-function comment at
[`entrypoint-combined.sh:197-199`](../entrypoint-combined.sh:197) explicitly
acknowledges — sails through validation (`-ge 0` accepts `0`).

Failure sequence: pre-count silently `0` while the profile holds items → sync
deletes everything → post-count legitimately `0` → `deleted = 0 - 0 = 0` →
breaker passes. The exact data-loss scenario the breaker exists to catch slips
through, because the guard is asymmetric.

Related code: [`get_sync_item_count`](../entrypoint-combined.sh:153) can only
detect pipeline failures via `pipefail`; a clean-exit empty listing is
indistinguishable from a genuinely empty profile at that layer.

## Goal

Apply the same distrust to the pre-sync count that the post-sync count already
receives, so the breaker only ever compares two trusted measurements — and
skips (safely) when trust is impossible.

## Proposed Approach

In [`check_deletion_circuit_breaker`](../entrypoint-combined.sh:174), extend the
existing pre-count validation block
([`entrypoint-combined.sh:185-188`](../entrypoint-combined.sh:185)) with a
retry-once-then-skip rule for a pre-count of exactly `0`:

```bash
# Suspicious-zero guard for the PRE count: `joplin ls` can fail silently
# (exit 0, empty output) in either direction. A pre-count of 0 combined with
# a post-count of 0 would compute deleted = 0 and pass the breaker while a
# full wipe happened. Retry once; if still 0, skip — the breaker can only
# compare like-for-like trusted measurements, and skipping is the safe default.
if [ "${pre_count}" -eq 0 ]; then
    log "WARN" "[${label}] Pre-sync count is 0 — suspicious (possible joplin ls failure); cannot verify baseline, skipping deletion circuit-breaker check"
    return 1
fi
```

Design note: unlike the post-count guard (which retries, because a zero post
count after a nonzero pre count is itself informative), a zero **pre** count
has no trusted baseline to reconcile against. If the profile is genuinely
empty, `deleted` can be at most `post_count - 0`; skipping the check for one
sync is the conservative outcome, and the WARN makes the condition visible.
This mirrors the skip-with-WARN contract (`return 1`) already used for failed
counts, so no caller changes are needed — all call sites
([`entrypoint-combined.sh:466`](../entrypoint-combined.sh:466),
[`entrypoint-combined.sh:541`](../entrypoint-combined.sh:541),
[`entrypoint-combined.sh:671`](../entrypoint-combined.sh:671)) already invoke
the breaker in conditional contexts and treat `1` as skip.

## Acceptance Criteria

- Pre-count `0` → `return 1` (skip) with a WARN log line; never `return 0`.
- Post-count `0` with pre-count `> 0` → existing retry-then-skip behavior
  unchanged ([`entrypoint-combined.sh:200-207`](../entrypoint-combined.sh:200)).
- Pre-count `> 0`, post-count `> 0` → normal comparison unchanged.
- All invocations remain in conditional contexts (`set -e` invariant).
- Unit tests cover the new pre-count-zero case.

## Verification

Unit tests go in [`tests/test-check-sync-errors.sh`](../tests/test-check-sync-errors.sh)
(Group 4, breaker tests, which exercise the byte-identical function copy — see
M7 for the duplication caveat). Add cases mirroring the existing style:

- **Pre-count `0`, stub empty** → expect `1` (skip), no halt marker, WARN
  emitted. (Today this returns `0` — the bug.)
- **Pre-count `0`, post-count `> 0`** → expect `0` (items added; legitimate
  empty-baseline comparison still passes).
- **Pre-count `0` with `SYNC_MAX_DELETE_COUNT=-1`** → expect `0` (disable
  short-circuits before counting; unchanged).
- Re-run the full harness: `bash tests/test-check-sync-errors.sh` → all pass,
  including the existing tests 20–30 (no regression).

## Non-goals

- Changing `get_sync_item_count` (its contract — "skip" on pipeline failure —
  is correct; the silent-zero case is only observable at the breaker layer).
- Touching the byte-identical test-copy duplication (tracked separately as M7).
