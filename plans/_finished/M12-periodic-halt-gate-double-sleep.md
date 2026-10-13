# M12 — Remove Doubled Idle Interval in the Periodic Halt Gate

> **Filing note (2026-10-08):** moved verbatim from
> `plans/M12-periodic-halt-gate-double-sleep.md` to
> `plans/_finished/M12-periodic-halt-gate-double-sleep.md` when the fix landed.
> **Finished (closed):** the double sleep is fixed — the redundant inner
> `sleep "${SYNC_INTERVAL_SECONDS}"` in the periodic halt gate
> (`entrypoint-combined.sh`, then-line `:890`) is deleted, so each loop
> iteration idles exactly one interval (the top-of-loop sleep) whether the
> halt gate fires or not. Evidence: gate at `entrypoint-combined.sh:888-891`;
> regression pin `tests/test-sync-failure-diagnostics.sh` Test 10b; closed in
> `plans/backlog.md` §5.
>
> **Citation-drift note (2026-10-08):** the body below predates the D4
> tag-aware refusal refactor. Its "Proposed Approach" and the acceptance
> criterion "exactly two log lines" describe the gate as two inline
> `log "ERROR"` calls; the live gate instead makes a single
> `log_halt_marker_refusal` call, whose helper emits that two-line refusal
> pair (backlog D4). The fix was deliberately minimal: delete only the inner
> sleep line, keep the `[ -f ... ]` test, the helper call and `continue`, and
> leave every other path byte-identical. Body analysis left unrewritten
> (record-not-rewrite); only the plan's relative markdown link targets were
> depth-adjusted (`../` → `../../`) for the move so they keep resolving. The
> log/refuse-then-continue invariant stands in spirit.

> Source: [`docs/code-review-testing-2026-09-21.md`](../../docs/code-review-testing-2026-09-21.md)
> finding **S6** (SUGGESTION).

## Problem

The periodic sync loop body starts with
`sleep "${SYNC_INTERVAL_SECONDS}"`
([`entrypoint-combined.sh:884`](../../entrypoint-combined.sh:884)). Once the halt
marker is present, the gate branch
([`entrypoint-combined.sh:888-892`](../../entrypoint-combined.sh:888)) logs the
refusal, **then performs another full `sleep "${SYNC_INTERVAL_SECONDS}"`
(line 890) before `continue`** — even though `continue` returns to the
top-of-loop sleep anyway.

Effect: with a marker present, the gate message repeats every
`2 × SYNC_INTERVAL_SECONDS` and each loop iteration idles twice as long.
Harmless (the loop refuses to sync either way), but the second sleep serves no
purpose and mildly obscures the loop invariant ("every iteration begins with
one interval sleep").

## Goal

One sleep per loop iteration, in one place: the top-of-loop sleep. The gate
branch logs and continues only.

## Proposed Approach

In the periodic loop inside the `setsid bash -c` block
([`entrypoint-combined.sh:862-940`](../../entrypoint-combined.sh:862)), change the
gate branch from:

```bash
if [ -f "${SYNC_HALT_MARKER}" ]; then
    log "ERROR" "Sync halt marker exists — refusing to sync (see ${SYNC_HALT_MARKER})"
    log "ERROR" "Remove ${SYNC_HALT_MARKER} to re-enable sync after investigating issue #27"
    sleep "${SYNC_INTERVAL_SECONDS}"
    continue
fi
```

to:

```bash
if [ "${SYNC_HALT_MARKER}" ]; then
    log "ERROR" "Sync halt marker exists — refusing to sync (see ${SYNC_HALT_MARKER})"
    log "ERROR" "Remove ${SYNC_HALT_MARKER} to re-enable sync after investigating issue #27"
    continue
fi
```

(Delete only the inner `sleep` line; keep the `[ -f ... ]` test — the
`[ "${SYNC_HALT_MARKER}" ]` form above is shown for brevity, not for adoption.)

## Acceptance Criteria

- The gate branch contains exactly two log lines and a `continue` — no `sleep`.
- With a halt marker present, the "refusing to sync" gate message appears once
  per `SYNC_INTERVAL_SECONDS` (not once per `2 ×`), and no sync runs.
- Loop behavior in the non-gated path is byte-identical.
- The structural test asserting the gate mechanism
  ([`tests/test-sync-failure-diagnostics.sh:93-101`](../../tests/test-sync-failure-diagnostics.sh:93),
  `grep -A5 "Sync halt marker exists" | grep -q "continue"`) still passes —
  removing the sleep does not affect that window.

## Verification

1. `bash tests/test-sync-failure-diagnostics.sh` → all pass (gate structure
   test intact).
2. `bash tests/test-check-sync-errors.sh` → unchanged.
3. Container test: create the marker
   (`docker exec joplin-mcp touch /home/joplin/.config/joplin/.sync-halt`),
   restart the container, and observe logs for ~2× the interval: the refusal
   message cadence is now one per interval, and no `[SYNC_START]` lines appear
   in the sync log.
4. `shellcheck entrypoint-combined.sh` (devcontainer/CI) — no new warnings.

## Non-goals

- Changing the halt-gate semantics on the initial-sync site
  ([`entrypoint-combined.sh:590-594`](../../entrypoint-combined.sh:590)) — it has
  no loop and correctly has no sleep.
- Any change to sync timing, interval defaults, or `SYNC_INTERVAL_SECONDS`
  handling.
