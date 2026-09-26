# M5 — Fix Vacuous Final-Sync Danger Check (Log Window Computed After the Sync)

> Source: [`docs/code-review-testing-2026-09-21.md`](../docs/code-review-testing-2026-09-21.md)
> finding **W2** (WARNING).

## Problem

In [`cleanup()`](../entrypoint-combined.sh:655) of
[`entrypoint-combined.sh`](../entrypoint-combined.sh:655), the shutdown final
sync runs first and **only afterwards** is the log window computed:

- [`entrypoint-combined.sh:661`](../entrypoint-combined.sh:661) —
  `flock ... -c 'joplin sync' > /dev/null 2>&1` (final sync, output discarded).
- [`entrypoint-combined.sh:664`](../entrypoint-combined.sh:664) —
  `LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}") + 1 ))` is computed
  **after** the sync, so `check_sync_danger "Final" "${LOG_TAIL_START}"`
  (line 666) tails from *after the last existing line* — an **empty window**.

Destructive signatures written by the final sync itself (exactly the scenario
[issue #27](https://github.com/gelse/joplin-mcp/issues/27) protects against)
can therefore never be detected on this path. The `sync-stdout.log` /
`sync-stderr.log` branches of [`check_sync_danger`](../entrypoint-combined.sh:117)
do not help either: the final sync redirects all output to `/dev/null`
(line 661), so those files still hold the *previous* sync's content.

The initial ([`entrypoint-combined.sh:426`](../entrypoint-combined.sh:426)) and
periodic ([`entrypoint-combined.sh:506`](../entrypoint-combined.sh:506)) paths
compute `LOG_TAIL_START` **before** the sync — the final path must match.

## Goal

Make the final-sync danger check meaningful: capture the log window before the
sync runs, and give the danger scan real sync output to scan.

## Proposed Approach

In the final-sync block of [`cleanup()`](../entrypoint-combined.sh:655):

1. Move the `LOG_TAIL_START` computation from line 664 to immediately before
   the sync (after the `PRE_SYNC_COUNT` capture at line 660), mirroring the
   initial path:
   ```bash
   LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
   ```
2. Redirect the final sync to the standard log files instead of `/dev/null`, so
   the stdout/stderr branches of `check_sync_danger` scan this sync's real
   output:
   ```bash
   flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin sync' \
       > "${LOG_DIR}/sync-stdout.log" 2> "${LOG_DIR}/sync-stderr.log" || SYNC_EXIT=$?
   ```
   This also restores failure diagnostics for the `else` branch
   ([`entrypoint-combined.sh:676`](../entrypoint-combined.sh:676)), which
   currently logs "Final sync failed" with no captured output.

## Acceptance Criteria

- `LOG_TAIL_START` for the final path is assigned **before** the `flock` sync
  invocation (same ordering as the initial and periodic sites).
- The final sync's stdout/stderr are captured to
  `${LOG_DIR}/sync-stdout.log` / `${LOG_DIR}/sync-stderr.log` (not `/dev/null`).
- A destructive signature produced by the final sync (e.g. `SQLITE_BUSY` /
  `Upgrading database from version 0` in log.txt within the window) yields a
  `[Final]` danger detection in the sync log.
- Shutdown behavior otherwise unchanged: no exit-code changes, no halt-marker
  writes added here (that is M9's scope).

## Verification

1. `bash tests/test-check-sync-errors.sh` still passes (function copies
   unchanged; the fix is caller-side).
2. Shell trace test (host, no container needed): stub `joplin` and `flock`,
   fake a `log.txt` that the stubbed sync appends a `SQLITE_BUSY` line to, run
   `cleanup` in a sandboxed harness — assert `check_sync_danger "Final"`
   returns 2 (detected), not 0 (vacuous pass).
3. Manual container test: `docker stop` a running stack with a halt-free
   profile; confirm the final-sync stderr lands in `sync-stderr.log`.
4. `shellcheck entrypoint-combined.sh` (devcontainer/CI) — no new warnings.
   Note: the new `|| SYNC_EXIT=$?` guard keeps the invocation `set -e`-safe.

## Non-goals

- Writing `SYNC_HALT_MARKER` on the final path (separate finding — M9).
- Changing detection patterns or `check_sync_danger` itself.
