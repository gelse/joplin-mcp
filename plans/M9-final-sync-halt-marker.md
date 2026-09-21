# M9 — Write `SYNC_HALT_MARKER` on the Final-Sync Danger Trip

> Source: [`docs/code-review-testing-2026-09-21.md`](../docs/code-review-testing-2026-09-21.md)
> finding **S3** (SUGGESTION).

## Problem

On the initial and periodic paths, `check_sync_danger` returning 2 writes
`SYNC_HALT_MARKER`
([`entrypoint-combined.sh:444`](../entrypoint-combined.sh:444),
[`entrypoint-combined.sh:456`](../entrypoint-combined.sh:456),
[`entrypoint-combined.sh:521`](../entrypoint-combined.sh:521),
[`entrypoint-combined.sh:532`](../entrypoint-combined.sh:532)). On the
shutdown final path, a return of 2 only logs `ABORT`
([`entrypoint-combined.sh:667-669`](../entrypoint-combined.sh:667)) — **no
marker**.

The container is exiting, so this is mostly moot in the moment — but with
restart policies (`docker restart`, compose `restart: unless-stopped`, which
[`docker-compose.yml`](../docker-compose.yml:55) sets), the next boot loses
the "destructive sync detected" signal: the startup halt gate
([`entrypoint-combined.sh:419-422`](../entrypoint-combined.sh:419)) and the
loop gate ([`entrypoint-combined.sh:494-500`](../entrypoint-combined.sh:494))
never fire, and the destructive pattern repeats from scratch.

**Line-reference drift vs. review doc:** the review cited `:666-668`; the
`if [ "${DANGER_RC}" -eq 2 ]` block is at
[`entrypoint-combined.sh:667-669`](../entrypoint-combined.sh:667) in the
current tree.

## Goal

Make the halt-marker contract consistent across all three sync sites: any
destructive-signature detection writes the marker, regardless of path.

## Proposed Approach

In the final-sync danger branch
([`entrypoint-combined.sh:667-669`](../entrypoint-combined.sh:667)), add the
marker write using the exact line already used at the other sites:

```bash
if [ "${DANGER_RC}" -eq 2 ]; then
    log_sync "ABORT" "Destructive signature detected in final sync"
    echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [SYNC_ABORT] Destructive sync signature detected — sync halted. See issue #27." > "${SYNC_HALT_MARKER}"
fi
```

The marker lives on the profile volume
([`entrypoint-combined.sh:32`](../entrypoint-combined.sh:32)), so it survives
the restart that follows shutdown. Note this composes with M5 (real log
window + captured stdout/stderr): without M5, this branch is nearly
unreachable because the danger check scans an empty window.

## Acceptance Criteria

- A `check_sync_danger "Final"` return of 2 results in `SYNC_HALT_MARKER`
  existing on the profile volume.
- After a `docker restart` following such a trip, the startup halt gate logs
  "Sync halt marker exists — refusing to sync" and neither the initial sync
  nor the periodic loop performs a sync.
- Marker content matches the `[SYNC_ABORT]` convention of the other sites.
- The `else` branch ("Final sync failed") is unchanged.

## Verification

1. Harness-level (host): stub `joplin`/`flock` so the "final sync" appends a
   destructive signature to a fixture `log.txt`, invoke `cleanup` in a
   sandboxed shell, assert `SYNC_HALT_MARKER` exists and contains
   `[SYNC_ABORT]`.
2. Container-level: with `restart: unless-stopped`, inject a destructive
   signature into the final sync window, `docker stop` the container, confirm
   on the next boot: `docker exec joplin-mcp test -f
   /home/joplin/.config/joplin/.sync-halt` succeeds and logs show the
   refusing-to-sync gate message.
3. Regression: `bash tests/test-check-sync-errors.sh` unchanged; M5's
   verification still holds (final sync output captured).

## Non-goals

- Changing when the final sync runs or is skipped
  ([`entrypoint-combined.sh:658-682`](../entrypoint-combined.sh:658) gating is
  already correct: skipped when the marker exists or the Data API is dead).
- Circuit-breaker trip handling on the final path — the breaker already writes
  its own marker ([`entrypoint-combined.sh:218`](../entrypoint-combined.sh:218)).
