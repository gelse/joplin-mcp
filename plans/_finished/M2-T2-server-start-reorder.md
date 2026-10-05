# M2-T2 — B2: server-start reorder (after sync+decrypt)

> **Filing note (2026-10-04):** moved verbatim from `plans/M2-T2-server-start-reorder.md`
> to `plans/_finished/M2-T2-server-start-reorder.md` in the finished-milestone
> filing batch. **Finished (closed):** descoped 2026-10-03 by user ratification
> (`plans/backlog.md` §1 verdict via §3 D1) after the M2-T1 run went GREEN alone;
> retained as historical record; residual value tracked as `plans/backlog.md` §5 F6.

> Subtask of **M2 — E2EE Encrypted Titles Fix (scope A + B2 + C)**.
> Belongs to the fix milestone (M2). Implementation starts in a fresh
> session from this file alone.

> **STATUS — DESCOPED, NOT REQUIRED (2026-10-03).** The user ratified
> dropping this task from the M2 critical path: `plans/backlog.md` §1
> verdict, ratified via §3 D1 (the user resolved D1 with "is ok",
> 2026-10-03). The amendment is recorded in
> `M1-e2ee-encrypted-titles-repro-test.md` ("## Amendment —
> 2026-10-03" section at end of file). Do NOT implement the reorder; this
> file is retained as the historical record.
>
> **Reason:** the M2-T1 run was GREEN with M2-T1 alone (outcome recorded in
> `plans/backlog.md` §1); by the M2-T1 §7 decision rule
> (`M2-T1-initial-sync-decrypt-and-verify.md:158`) GREEN ⇒ Gap 1 = NO
> mitigations needed ⇒ Spike 1 (§9 below) answered **YES** — the Data API
> re-reads the SQLite DB after out-of-process `e2ee decrypt` *(inference
> from the GREEN outcome; `plans/backlog.md` §2 R6)* — so the reorder is
> unnecessary for serving plaintext.
>
> **Residual value retained:** `plans/backlog.md` §5 **F6** — the reorder
> (or the §8 Risk 1 cold-start restart escape) remains the candidate
> response if the Decision-2 image-drift duty ever sees the repro go RED
> again on a future `joplin/server` image (Decision 2: `M1-e2ee-encrypted-titles-repro-test.md:37`;
> monitoring protocol: `M1-e2ee-encrypted-titles-repro-test.md:46-53`).
>
> Historical record: §9 Spike 1, §8 Risk 1, and §8 Risk 2 below remain
> unchanged as the record; see the dated annotations appended to them.

## 1. Header

- **Subtask ID:** M2-T2
- **Milestone:** M2 (fix)
- **Dependencies (other subtask IDs):** M2-T1 (M2-T1 must have inserted the decrypt block, so T2's "after sync+decrypt" anchor is well-defined).
- **What it delivers:** Reordered `entrypoint-combined.sh` so the api-port config + `nohup joplin server start` + curl health-wait + api.token extraction + server-probe block (currently `:330-426`) lives AFTER the sync+decrypt region — i.e. after M2-T1's decrypt block inside the initial-sync success branch (anchored next to `log_sync "PASS"`, ~`:474`) and after the `START_PERIODIC_LOOP=1` assignment (`:445`, which already ran by then) — and before the MCP server start (`:567-585` area). The periodic sync loop still starts based on the `START_PERIODIC_LOOP` value assigned at `:445` in the sync region (the moved block does not re-assign it), and the MCP server still starts last (after the moved block has extracted the api token).

## 2. Full problem context

GitHub issue #29 reports the combined container serves E2EE-encrypted
notebook titles as-is via `list_notebooks` despite `JOPLIN_MASTER_PASSWORD`
set. The reporter saw empty `title` fields (or `encryption_applied=1`
with non-empty `encryption_cipher_text`), `SYNC_PASS` despite encrypted
state, and a manual `joplin e2ee decrypt` that first failed
("DecryptionWorker: cannot start because no master key is currently
loaded") before succeeding — 204 items decrypted, plaintext served
without server restart.

**Root cause B (per the source plan's root-cause table):** the Data API
(`joplin server start`, `:333-335`) starts BEFORE any master key exists
on a fresh volume. It is long-running and never restarted. After M2-T1
runs `e2ee decrypt`, the SQLite DB is plaintext; but the Data API
process may still serve ciphertext (per Gap 1 — does it re-read on
disk? Unknown). B2 (this subtask) restarts the sequence so server start
follows sync+decrypt, eliminating the race entirely: when the Data API
starts, the SQLite DB is already plaintext (M2-T1 ran first).

## 3. Authoritative investigation evidence (with file:line)

- **entrypoint-combined.sh:329-335** — server-start block to move:
  ```sh
  log "INFO" "Configuring Joplin Data API to listen on 127.0.0.1:${JOPLIN_INTERNAL_PORT}..."
  joplin config api.port "${JOPLIN_INTERNAL_PORT}"

  log "INFO" "Starting Joplin Data API (127.0.0.1:${JOPLIN_INTERNAL_PORT})..."
  nohup joplin server start \
      > "${LOG_DIR}/joplin-server-stdout.log" 2> "${LOG_DIR}/joplin-server-stderr.log" &
  JOPLIN_SERVER_PID=$!
  ```
- **entrypoint-combined.sh:339-413** — health-wait + token extraction (depends on server start):
  - `:347-367` curl health-wait retry loop (30 attempts × 2s = up to 60s).
  - `:384-413` token extraction with retry + settings.json fallback.
- **entrypoint-combined.sh:417-426** — server-probe (`curl .../api/ping?token=...`):
  ```sh
  log "INFO" "Probing Joplin Server connectivity..."
  if curl -sf --connect-timeout 5 --max-time 10 "${JOPLIN_SERVER_URL}/api/ping?token=${JOPLIN_API_TOKEN}" -o /dev/null 2>/dev/null; then
      log "INFO" "Joplin Server is reachable at ${JOPLIN_SERVER_URL}"
  else
      log "WARN" "Joplin Server not reachable at ${JOPLIN_SERVER_URL} — sync may fail"
      log "WARN" "This is expected if the server is temporarily unavailable or the token is incorrect"
  fi
  ```
- **entrypoint-combined.sh:433-485** — the halt-gate + initial sync block. After M2-T1, this block now also contains the new decrypt step inside the initial-sync SUCCESS branch — after `check_sync_errors "Initial"` succeeds, next to `log_sync "PASS"` (~`:474`). The `START_PERIODIC_LOOP=1` assignment (`:445`) precedes it.
- **entrypoint-combined.sh:497-561** — the periodic sync loop start (executed only if `START_PERIODIC_LOOP=1`; runs in `setsid` background subshell).
- **entrypoint-combined.sh:567-585** — MCP server start. Depends on `JOPLIN_API_TOKEN` (set by `:415` `export JOPLIN_API_TOKEN` inside the moved block).
- **entrypoint-combined.sh:711-755** — liveness monitor (`wait -n -p`) and final cleanup. References `JOPLIN_SERVER_PID` (set by `:335`) and `MCP_PID` (set by `:577`). The move must not break this.
- **entrypoint-combined.sh:592-702** — cleanup() function. References `JOPLIN_SERVER_PID` (line 644), `SYNC_LOCK_FILE`, `SYNC_HALT_MARKER`, `JOPLIN_LOG_FILE`. All unaffected by the move.

## 4. Scope

**Files to modify:**
- `entrypoint-combined.sh` (reorder lines `:330-426` to after the sync+decrypt region — i.e. after M2-T1's decrypt block and the `START_PERIODIC_LOOP` assignment — and before the MCP server start).

**Files NOT to touch:**
- `src/` (M2 is entrypoint only).
- `Dockerfile.combined` (M2-T3 owns the healthcheck; this subtask only moves code).
- The halt-gate else branch (lines `:434-485`) itself — M2-T1 already extended it.
- The periodic loop body (lines `:490-557`).
- The MCP server-start block (lines `:567-585`).
- The liveness monitor (`:711-755`).
- The cleanup function (`:592-702`).

## 5. Exact behavior required

### Concrete new order of operations (final layout after M2-T1 + M2-T2)

1. Lines `:1-50` — header + log() function (UNCHANGED).
2. Lines `:52-110` — log_sync() and check_sync_errors() (UNCHANGED).
3. Lines `:112-149` — check_sync_danger() (UNCHANGED).
4. Lines `:151-238` — get_sync_item_count(), check_deletion_circuit_breaker() (UNCHANGED).
5. Lines `:240-309` — required-vars check, defaults, sync.target config, master password config (UNCHANGED).
6. Lines `:311-321` — env export (UNCHANGED).
7. **GAP — lines `:323-426` (the moved block) DELETED from here.**
8. Lines `:428-485` — halt-gate + initial sync (UNCHANGED structure; M2-T1 inserts the decrypt block inside the initial-sync success branch, next to `log_sync "PASS"` ~`:474` — after the `START_PERIODIC_LOOP=1` assignment at `:445`).
9. Lines `:487-561` — periodic loop start (UNCHANGED).
10. **MOVED — lines `:330-426` PASTED here** (after `:561`).
11. Lines `:565-585` — MCP server start (UNCHANGED).
12. Lines `:592-755` — cleanup() + liveness monitor (UNCHANGED).

### Concrete edits

In `entrypoint-combined.sh`:
- **CUT** lines `:329-426` (the entire block from `log "INFO" "Configuring Joplin Data API to listen on 127.0.0.1..."` through the `fi` that closes the `else` branch of the server-probe on `:426`).
- **PASTE** that block immediately after the periodic-loop-start block closes, i.e. after `:561` `log "INFO" "Periodic sync loop started (PID: ${SYNC_LOOP_PID:-none}, own process group)"` and BEFORE `:565` `# Start MCP HTTP server (Node.js, in background)`.
- Verify the relative line numbers in comments inside the moved block are no longer correct (e.g. `:330` is now somewhere around `:475`). **Either** delete the old `entrypoint-combined.sh:N-M` references in code comments that are no longer accurate, **or** update them to reflect the new positions. Cleaner: do a final `grep` pass and update line-number citations in code comments.

### Edge cases to handle

- **The `setsid bash -c '... &'` for the periodic loop** (`:503-557`) exports its own functions via `export -f log ...` (`:498`). The moved block does not need any of these exports because it's the foreground entrypoint bash process. **No change needed.**
- **`START_PERIODIC_LOOP=1` on `:445`** is set BEFORE the moved block executes (the moved block is pasted after the sync+decrypt region, i.e. after this assignment and after M2-T1's decrypt block, which may only override it to `0` fail-closed on failure). The moved block does not depend on `START_PERIODIC_LOOP`. **No change needed.**
- **The `trap 'cleanup SIGTERM' SIGTERM` (`:707-708`)** is set up before the moved block; `cleanup` references `JOPLIN_SERVER_PID` which is set inside the moved block. By the time a SIGTERM arrives, the moved block has executed (it's BEFORE the liveness monitor). **No change needed.**
- **The `wait -n -p` liveness monitor (`:717`)** references `JOPLIN_SERVER_PID` and `MCP_PID`. Both are set after the move (the moved block sets `JOPLIN_SERVER_PID`; MCP_PID is set on `:577`). **No change needed.**

## 6. Acceptance criteria

- `shellcheck entrypoint-combined.sh` → no new warnings (the moved block uses identical idioms; the new location is syntactically valid).
- The combined container's cold-start sequence (verified via `docker compose logs joplin-mcp`):
  1. "Configuring Joplin CLI sync target..." (`:292`)
  2. "Master password configured from environment" (or no log if unset, `:308`)
  3. "Performing initial sync..." (`:439`)
  4. (M2-T1) "Running post-sync E2EE decrypt..."
  5. (M2-T1) "E2EE decrypt complete; 0 encrypted items remaining"
  6. "Periodic sync loop started..."
  7. (NEW POSITION) "Configuring Joplin Data API to listen on 127.0.0.1:..."
  8. (NEW POSITION) "Starting Joplin Data API (127.0.0.1:...)..."
  9. (NEW POSITION) "Joplin Data API process started (PID: ...)"
  10. (NEW POSITION) "Data API is healthy (attempt N/M)"
  11. (NEW POSITION) "Joplin API token extracted from Joplin CLI config" (or "Using pre-set Joplin API token from environment")
  12. (NEW POSITION) "Probing Joplin Server connectivity..."
  13. "Starting MCP HTTP server on port 3000..."
  14. "joplin combined container is ready"
- Total cold-start time grows by 5–15s compared to the original layout (the moved block adds 5–15s; M2-T1's retry loop adds up to 20s but only on first boot).
- `tests/test-check-sync-errors.sh`, `tests/test-sync-failure-diagnostics.sh`, `tests/test-final-sync-danger-check.sh` → all green (none of them depend on the moved block's original position; the sync functions and the sync-call structure are unchanged).
- The M1-T3 repro test (`RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh`) → on M2-T1+T2 code, exits 0 (GREEN) — no assertion edits.

## 7. Verification commands

1. **Static check:** `shellcheck entrypoint-combined.sh` → no new warnings.
2. **Sequence check:** `RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh 2>&1 | grep -E '\[INFO\]|\[SYNC_|\[E2EE_'` → log lines appear in the order listed in Acceptance #2 above.
3. **Functional check (GREEN flip):** with M1-T3 in place and M2-T1+T2 code in entrypoint-combined.sh, the repro test passes. `RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh` → exit 0.
4. **Cleanup check:** `docker compose -f docker-compose.test.yml down` → clean shutdown (the liveness monitor + cleanup() handle the moved block identically to the original; no change in shutdown semantics).
5. **Restart safety:** `docker restart joplin-mcp` (where `joplin-mcp` is the running combined container) → the entrypoint re-runs from the top; the moved block re-executes; the same cold-start sequence runs. Verified by `docker logs joplin-mcp` showing the same sequence on the second boot.

## 8. Risks / gotchas

- **Risk 1 (Gap 1 — does `joplin server start` re-read the SQLite DB after out-of-process `e2ee decrypt`)?** This subtask assumes YES (it re-orders, not restart). If NO, the M2-T1+T2 fix is insufficient: the Data API may serve ciphertext regardless of sync+decrypt order. **Escape hatch:** supplement M2-T2 with an in-place restart of the server between sync and the moved block. Concrete addition: between the M2-T1 decrypt block and the moved block, add `kill "${JOPLIN_SERVER_PID}" 2>/dev/null || true; wait "${JOPLIN_SERVER_PID}" 2>/dev/null || true; rm -f /home/joplin/.config/joplin/.sync-flock` (the lock is released on process exit, so this is defensive). Then proceed with the moved block (which now includes the `nohup joplin server start` call). This adds ~2-5s to cold-start. **Justification for accepting this escape hatch as a B2 supplement (not a B1 re-introduction):** B1's "in-flight MCP request drops" concern applies to MID-RUN restarts, not cold-start. At cold-start, the MCP server has not yet started (it starts AFTER the moved block), so there are no in-flight MCP requests to drop. The supplement is therefore acceptable within B2's "no in-flight MCP request drops" constraint. **[2026-10-03: CLOSED — the plan's YES assumption held (M2-T1 run GREEN with M2-T1 alone; decision rule `M2-T1-initial-sync-decrypt-and-verify.md:158`); the escape hatch was not needed; retained as the `plans/backlog.md` §5 F6 candidate if a future image regresses the behavior.]**
- **Risk 2: line-number citations in code comments are stale after the move.** Many of the entrypoint's comments cite `:443`, `:347-367`, etc. (verified in this plan's evidence). After M2-T2, those line numbers are off by ~100 lines. **Mitigation:** do a final pass to update stale citations, OR (cleaner) replace the `:N-M` form with a function/anchor name. The latter is more durable but touches more lines. Pick the former: update stale citations only. **[2026-10-03: MOOT — the move does not happen (task descoped; see the status header); no citation pass is needed.]**
- **Risk 3: `wait -n -p` portability.** `wait -n -p WAIT_PID` is bash ≥ 5.1 (per the comment at `:712-714`); the image ships bash 5.2. The move does not affect this. **No change needed.**
- **Risk 4: Race between periodic loop and the moved block.** The periodic loop starts (`setsid bash -c ... &`) BEFORE the moved block (which is the api-port config + server start). The periodic loop's first action is `sleep ${SYNC_INTERVAL_SECONDS}` (`:506`); on a fresh volume with `SYNC_INTERVAL_SECONDS=300` (default), the loop sleeps 300s before its first sync. By the time it wakes, the moved block has executed (it runs in the foreground). **No race.** For test environments with `SYNC_INTERVAL_SECONDS=9999`, even safer. **No change needed.**
- **Risk 5: Reordering + M9 halt-marker interaction.** M9's final-sync halt-marker write on line 685 is inside the cleanup() function; it references `SYNC_HALT_MARKER`. The move does not change the cleanup function. **No interaction.**

## 9. Research spikes assigned

- **Spike 1 (~1h, CRITICAL): does `joplin server start` re-read the SQLite DB after out-of-process `e2ee decrypt`?** This is the question whose answer determines whether M2-T2 is sufficient. Reporter's experience suggests YES (API served plaintext without restart after manual decrypt), but unverified. **Test:** spin up a local combined container, sync, manually run `joplin e2ee decrypt` in another shell, then call `curl http://127.0.0.1:41184/folders` and check `title` is plaintext. **If YES** → M2-T2 as specified is sufficient. **If NO** → apply the Risk #1 escape hatch (in-place server restart between sync+decrypt and the moved block); document the rationale in the code comment. **[2026-10-03: ANSWERED YES — via the M2-T1 run, GREEN with M2-T1 alone *(inference from the GREEN outcome)*; recorded in `plans/backlog.md` §2 R6 and §1; M2-T2 is descoped (see status header), so neither branch of this spike executes as planned work.]**

## 10. Handoff note

The next subtask is **M2-T3 (sync-detection-and-healthcheck-hardening)**, which is independent of M2-T2's reorder (it edits different regions: `combined_pattern` on `:74` and `Dockerfile.combined:86-87`). M2-T3 can land in any order relative to M2-T2, but MUST land before M2-T4 (the flip-to-green verification).

The final subtask is **M2-T4 (flip-to-green-verification-and-docs)**, which runs M1-T3 with zero assertion edits and updates the README. M2-T4's success criterion: M1-T3 exits 0 with M2-T1+T2+T3 code; the symptom assertion (non-empty plaintext titles, `encryption_applied === 0`) passes.

## Non-goals

- No source-code changes.
- No Dockerfile changes (M2-T3).
- No README changes (M2-T4).
- No CI changes (M1-T5 already covered).
- No periodic-loop changes.
