# M2-T1 — A: post-sync `joplin e2ee decrypt` + verification

> Subtask of **M2 — E2EE Encrypted Titles Fix (scope A + B2 + C)**.
> Belongs to the fix milestone (M2). Implementation starts in a fresh
> session from this file alone.

## 1. Header

- **Subtask ID:** M2-T1
- **Milestone:** M2 (fix)
- **Dependencies (other subtask IDs):** M1-T1..T6 (M1 fully shipped — repro test must exist before the fix lands, so the flip-to-green can be verified).
- **What it delivers:** A new `joplin e2ee decrypt` step + bounded retry loop + verification gate inserted in `entrypoint-combined.sh` inside the initial-sync SUCCESS branch — after the initial `flock ... joplin sync` (`:443`) has succeeded and `check_sync_errors "Initial"` returns success, next to the `log_sync "PASS"` line (~`:474`). `START_PERIODIC_LOOP=1` at `:445` has already executed; therefore the block must only ever override it to `0` (fail-closed) on decrypt/verify failure, plus write the halt marker. It must NOT set it to `1`. On decrypt failure or remaining encrypted items: writes the sync halt marker + logs loudly + fails the entrypoint.

## 2. Full problem context

GitHub issue #29 reports the combined container serves E2EE-encrypted
notebook titles as-is via `list_notebooks` despite `JOPLIN_MASTER_PASSWORD`
set. The reporter saw empty `title` fields (or `encryption_applied=1`
with non-empty `encryption_cipher_text`), `SYNC_PASS` despite encrypted
state (corroborated by `README.md:60` — "the sync process will
misleadingly report `SYNC_PASS`"), and a manual `joplin e2ee decrypt`
that first failed ("DecryptionWorker: cannot start because no master key
is currently loaded") before succeeding on retry. After manual decrypt,
204 items decrypted, the API served plaintext without restart.

**Root cause A (per the source plan's root-cause table):** the entrypoint
only stores the master password (`:306-309`) and runs `joplin sync`
(`:443`); it never triggers the DecryptionWorker, never waits for decrypt
to complete, never verifies. The reporter's manual `e2ee decrypt` is
exactly the missing step.

This subtask implements A: insert `joplin e2ee decrypt` + bounded retry
loop + verification gate inside the initial-sync SUCCESS branch, next to
the `log_sync "PASS"` line (~`:474`; exact anchor in §5). The verification gate reads the
post-decrypt state (`joplin ls -l` shows `[Encrypted]` markers per spike;
or `joplin status` shows remaining-encrypted count) and refuses to start
the periodic sync loop if any items remain encrypted.

## 3. Authoritative investigation evidence (with file:line)

- **entrypoint-combined.sh:443** — `flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin sync' > "${LOG_DIR}/sync-stdout.log" 2> "${LOG_DIR}/sync-stderr.log" || SYNC_EXIT=$?`. The new block sits downstream of this line, inside the initial-sync SUCCESS branch (exact anchor in §5).
- **entrypoint-combined.sh:306-309** — master-password config. After this, `joplin e2ee decrypt` (run in a fresh `joplin` invocation) will load the master key from config and trigger the DecryptionWorker. Per the source plan's "Strongly implied: no" note (`Master key triggers in-process?` spike), `joplin config encryption.masterPassword` does NOT trigger the DecryptionWorker — the explicit `e2ee decrypt` is required.
- **entrypoint-combined.sh:71-110** — `check_sync_errors()` and `combined_pattern`. The pattern (`:74`) currently does NOT include `DecryptionWorker` or `no master key is currently loaded`. **Gap 1 (M2-T2):** if `joplin e2ee decrypt` fails (master-key propagation timing), the resulting log may contain "DecryptionWorker: cannot start because no master key is currently loaded" — `check_sync_errors` would not detect it. **Solution in M2-T1:** retry loop absorbs transient timing; M2-T3 expands the pattern to catch persistent failures.
- **entrypoint-combined.sh:434-485** — the halt-gate else block. Insertion site is INSIDE this `else` branch, in its SUCCESS arm (after `check_sync_errors "Initial"` passes; exact anchor in §5).
- **entrypoint-combined.sh:445** — `START_PERIODIC_LOOP=1`. After the new decrypt step, this value must reflect the decrypt verification outcome: per the final design (see §6), the `=1` assignment at `:445` is left untouched and the new block runs AFTER it, so it can only override the value to 0 (fail-closed).

## 4. Scope

**Files to modify:**
- `entrypoint-combined.sh` (single insertion: the decrypt + bounded-retry + verification block inside the initial-sync SUCCESS branch of the halt gate, next to the `log_sync "PASS"` line (~`:474`); exact anchor in §5).

**Files NOT to touch:**
- `src/` (M2 is entrypoint + Dockerfile only; matches Decision 1's scope).
- `Dockerfile.combined` (M2-T3 owns the healthcheck change).
- `docker-compose.test.yml` (M1-T1).
- `check_sync_errors()` / `combined_pattern` (`:71-110`) — M2-T3 owns the pattern expansion; M2-T1's bounded retries + halt marker cover the immediate failure path.
- The periodic sync loop (`:497-561`) — untouched; the decrypt block lives in the initial-sync region only.
- The MCP server-start block (`:567-585`).
- `tests/test-check-sync-errors.sh` and the other shell tests (no pattern or function changes in this subtask).
- `README.md` (M1-T6 adds documentation; M2-T4 converts "Known gap" to "Resolved").

## 5. Exact behavior required

Insert this block in `entrypoint-combined.sh` as follows.

**Placement:** inside the initial-sync SUCCESS branch — after the `else` on
line 461, after `check_sync_errors "Initial"` returns success (line 463),
next to the `log_sync "PASS"` line (~`:474`). `START_PERIODIC_LOOP=1` at
`:445` has already executed; therefore the block must only ever override it
to `0` (fail-closed) on decrypt/verify failure, plus write the halt marker.
It must NOT set it to `1`. The new block MUST run only when the preceding
sync succeeded AND no error pattern was detected.

```bash
    # ----- M2-T1: post-sync E2EE decrypt + verification gate (A) -----
    # Placement: inside the initial-sync SUCCESS branch — after
    # `check_sync_errors "Initial"` returns success, next to the
    # `log_sync "PASS"` line (~:474). `START_PERIODIC_LOOP=1` at :445 has
    # already executed; this block must only ever override it to 0
    # (fail-closed) on decrypt/verify failure, plus write the halt marker.
    # It must NOT set it to 1.
    # After the initial sync, master keys are loaded but the DecryptionWorker
    # has not been triggered. `joplin config encryption.masterPassword` does
    # NOT trigger it (per issue #29: reporter needed explicit `e2ee decrypt`).
    # We trigger it here, bounded-retry to absorb master-key propagation
    # timing, then verify zero remaining encrypted items before starting the
    # periodic sync loop.
    DECRYPT_MAX_ATTEMPTS=4
    DECRYPT_BACKOFF_S=5
    DECRYPT_EXIT=1
    for dc in $(seq 1 ${DECRYPT_MAX_ATTEMPTS}); do
        log "INFO" "Running post-sync E2EE decrypt (attempt ${dc}/${DECRYPT_MAX_ATTEMPTS})…"
        if flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin e2ee decrypt' \
            > "${LOG_DIR}/e2ee-decrypt-stdout.log" 2> "${LOG_DIR}/e2ee-decrypt-stderr.log"; then
            DECRYPT_EXIT=0
            break
        fi
        log "WARN" "joplin e2ee decrypt attempt ${dc} failed — backing off ${DECRYPT_BACKOFF_S}s (master-key propagation timing per issue #29)"
        sleep "${DECRYPT_BACKOFF_S}"
    done

    if [ "${DECRYPT_EXIT}" -ne 0 ]; then
        log "ERROR" "E2EE decrypt failed after ${DECRYPT_MAX_ATTEMPTS} attempts — refusing to start periodic sync (issue #29)"
        echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [E2EE_DECRYPT_FAIL] decrypt did not complete after ${DECRYPT_MAX_ATTEMPTS} attempts. See issue #29." > "${SYNC_HALT_MARKER}"
        START_PERIODIC_LOOP=0
    else
        # Verify: zero items still encrypted. Probe via `joplin ls -l`; an
        # encrypted item carries the `[Encrypted]` marker. A non-zero count
        # means decrypt didn't actually complete (e.g. partial decryption
        # under contention). This is the verification gate.
        REMAINING_ENC=$(joplin ls -l -n 99999 2>/dev/null | grep -c '\[Encrypted\]' || echo 0)
        if [ "${REMAINING_ENC}" -gt 0 ]; then
            log "ERROR" "E2EE verification failed: ${REMAINING_ENC} item(s) still encrypted after decrypt (issue #29)"
            echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [E2EE_DECRYPT_INCOMPLETE] ${REMAINING_ENC} item(s) still encrypted after decrypt. See issue #29." > "${SYNC_HALT_MARKER}"
            START_PERIODIC_LOOP=0
        else
            log "INFO" "E2EE decrypt complete; 0 encrypted items remaining"
        fi
    fi
    # ----- end M2-T1 block -----
```

**Operational notes:**
- `flock -w 120` re-uses `SYNC_LOCK_FILE` so a concurrent `joplin sync` (none should exist in initial sync, but defensive) cannot race the decrypt.
- `DECRYPT_MAX_ATTEMPTS=4` × `DECRYPT_BACKOFF_S=5` = up to 20s; combined with sync 5–30s the total cold-start grows by ≤ 20s. Combined with M2-T2's cold-start (5–15s for the reordering), total worst-case first-boot delay is ~50s. **[2026-10-03: the combined-with-M2-T2 arithmetic is void — M2-T2 descoped (`plans/backlog.md` §1 / §3 D1 user ratification); the first-boot cost is M2-T1's ≤ 20s alone, per Risk 3 below.]**
- Logs are captured separately to `${LOG_DIR}/e2ee-decrypt-*.log` (the existing `/var/log/joplin` directory; created by the entrypoint at line 36).
- The `START_PERIODIC_LOOP` default `:502` is `: "${START_PERIODIC_LOOP:=0}"`; the new block only sets it to 0 (fail-closed). M2-T1 does NOT change the default — it only re-sets to 0 on failure.

**Spike-required behaviors (resolved before merge; if any spike answer is NO, fallback below):**
- **`joplin e2ee decrypt` reads the master password from `joplin config encryption.masterPassword` (no `-p` flag needed).** If NO → add `-p "${JOPLIN_MASTER_PASSWORD}"` to the invocation; also pipe the password via stdin (`echo "${JOPLIN_MASTER_PASSWORD}" | joplin e2ee decrypt -p -` if the CLI form is `-p -`).
- **`joplin ls -l` emits `[Encrypted]` markers for encrypted items.** If the format differs (e.g. no marker, marker is `[E]`, or only a `?` prefix) → use the verification-gate escape: count rows where `encryption_cipher_text` is non-empty via a Node-based probe (`node -e "const s=require('joplin/node_modules/sqlite3'); const db=new s.Database('…/database.sqlite',s.OPEN_READONLY,…) …"`) matching the `tests/container/sqlite-busy-repro.test.ts:306-340` LOCK_SCRIPT pattern.
- **`joplin e2ee decrypt` exit code semantics:** success = 0; partial decrypt = non-zero with stderr containing per-item errors. The bounded-retry loop handles the latter by re-attempting; after 4 attempts the gate fails.

## 6. Acceptance criteria

- On a fresh `joplin_data` volume with the M1 seed in place: initial sync → decrypt → 0 encrypted items → `START_PERIODIC_LOOP=1` → periodic sync runs.
- On a fresh volume with NO master password set (`JOPLIN_MASTER_PASSWORD` empty): initial sync runs (no decrypt needed) → `START_PERIODIC_LOOP=1` → periodic sync runs (the decrypt block is guarded by `if [ -n "${JOPLIN_MASTER_PASSWORD:-}" ]` semantics; see Risks #1 for the guard).
- On a fresh volume with the master password set but the seed server unreachable: initial sync fails → halt marker set by the existing failure branch → periodic sync NOT started. The new decrypt block does not interfere (it only runs in the success branch).
- On a fresh volume with the master password set, server reachable, and the server's master-key propagation delayed: initial sync succeeds → decrypt attempt 1 fails → retry succeeds → verification passes → periodic sync starts. Total: ≤ 20s extra cold-start.
- On a fresh volume with the master password set and the server returns 0 items to decrypt (server has no E2EE items): decrypt succeeds (no-op) → verification passes (0 `[Encrypted]` markers) → periodic sync starts.
- Verification count check produces a non-zero exit (`set -e` invariant; see Risks #3) when `grep -c` returns "0" (since 0 is success but the count must be checked as a number).

**Guard for the `START_PERIODIC_LOOP` assignment:** the new block's failure paths assign `START_PERIODIC_LOOP=0`. The existing `set -e` invariant in the entrypoint requires `START_PERIODIC_LOOP` to be assigned on all paths. The new block runs ONLY in the success branch (line 473-475), which already sets `START_PERIODIC_LOOP=1` (line 445). With M2-T1 added, the success branch becomes: `START_PERIODIC_LOOP=1` → decrypt block (overwrites to 0 on failure) → periodic loop. The `: "${START_PERIODIC_LOOP:=0}"` fail-safe on line 502 remains correct.

**Note:** `START_PERIODIC_LOOP=1` is assigned at `:445`, BEFORE the SYNC_EXIT if/else. The success branch of the if/else (line 473-475) only logs `log_sync "PASS"`. The new decrypt block therefore runs after `START_PERIODIC_LOOP=1` has already been assigned, and may only override it to `0` (fail-closed) on decrypt/verify failure — never to `1`.

## 7. Verification commands

1. **No-fix baseline (current code):** `RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh` → exit 1; symptom assertion fails (the M1 repro test is RED).
2. **With M2-T1 fix (no M2-T2/T3):** repeat (1) → still exit 1; the symptom is unchanged because the Data API (`joplin server start`) was started BEFORE sync+decrypt, so it serves the post-decrypt DB only if it re-reads after out-of-process `e2ee decrypt`. **This is the Gap 1 verification point:** if the test now passes, `joplin server start` re-reads (Gap 1 = NO mitigations needed); if still RED, M2-T2's reorder is required. **[2026-10-03 OUTCOME: GREEN observed with M2-T1 alone ⇒ Gap 1 = NO mitigations needed ⇒ M2-T2 descoped per `plans/backlog.md` §1 / §3 D1 (user ratification "is ok").]**
3. **Manual log inspection:** `docker compose -f docker-compose.test.yml logs joplin-mcp | grep -E 'E2EE|decrypt|Encrypted'` → shows the new log lines in order: `Running post-sync E2EE decrypt` → `E2EE decrypt complete; 0 encrypted items remaining` (or the failure path).
4. **shellcheck:** `shellcheck entrypoint-combined.sh` (devcontainer/CI) — no new warnings (the new block uses the same `flock`/`log` conventions as existing code).
5. **`tests/test-check-sync-errors.sh`:** unchanged (M2-T1 does not modify `check_sync_errors`); still green.

## 8. Risks / gotchas

- **Risk 1: JOPLIN_MASTER_PASSWORD unset.** If the env var is empty, the new block's verification gate would run with 0 master keys loaded → `joplin e2ee decrypt` is a no-op or fails immediately → retry loop burns ~20s → eventually the verification gate passes (0 encrypted items by accident, since no items were ever encrypted) → periodic sync starts. **Mitigation: guard the entire block with `if [ -n "${JOPLIN_MASTER_PASSWORD:-}" ]; then … fi`.** This makes the block a no-op for users who don't set the master password.
- **Risk 2: grep -c returns 0.** `set -e` with `grep -c` returning "0" is fine (exit 0; "0" is a valid match count of zero). But `grep -c` exits 1 if no matches. Mitigation: `REMAINING_ENC=$(... | grep -c '\[Encrypted\]' || echo 0)` — `|| echo 0` swallows the exit-1 case.
- **Risk 3: Cold-start delay.** M2-T1 adds ≤ 20s on first boot. Combined with M2-T2's 5–15s, total first-boot delay is ~50s. After first boot, periodic syncs do not run the decrypt block (it lives in the initial-sync region). **Acceptable per Decision 1.** **[2026-10-03: the combined-with-M2-T2 arithmetic is void — M2-T2 descoped (`plans/backlog.md` §1 / §3 D1); the delay is M2-T1's ≤ 20s alone.]**
- **Risk 4: Halt marker collateral.** When decrypt fails, M2-T1 writes the same `${SYNC_HALT_MARKER}` used by the issue #27 destructive-signature circuit-breaker. A user triaging the halt marker may be confused: was it issue #27 or issue #29? The marker text includes `[E2EE_DECRYPT_FAIL]` / `[E2EE_DECRYPT_INCOMPLETE]` prefix to disambiguate. Document in `M9-final-sync-halt-marker.md` if M2-T1 lands before M9's nomenclature conventions are finalised.
- **Risk 5: Combined-container entrypoint is shell, not Node.** `grep -c` + `awk` parsing is brittle to joplin output format changes (already a concern for the existing `check_sync_errors`). The escape hatch is the SQLite-based verification (Spike-required behaviors, second bullet). Document in the entrypoint comment.
- **Risk 6: Halt gate + decrypt block interaction.** The new block lives inside the halt-gate else branch (line 437). If the halt marker is present, the else branch is skipped and decrypt is never run. After the marker is removed, the next periodic sync runs but the decrypt block is NOT part of the periodic loop (intentional — periodic decrypt is a different concern; out of scope for M2). A subsequent restart re-runs the initial sync + decrypt.

## 9. Research spikes assigned

- **Spike 1 (~15 min): does `joplin e2ee decrypt` read the master password from `joplin config encryption.masterPassword` (no `-p` flag needed)?** If NO → add `-p "${JOPLIN_MASTER_PASSWORD}"` or pipe via stdin. Fallback documented in §5.
- **Spike 2 (~30 min): does `joplin config encryption.masterPassword` trigger the DecryptionWorker in-process?** Strongly implied NO (reporter's experience). If YES → A can degrade to "wait for worker + verify" without the explicit `e2ee decrypt` call. Fallback: keep the explicit `e2ee decrypt` (the robust choice); document the experimental confirmation.
- **Spike 3 (~15 min): does `joplin ls -l` output a `[Encrypted]` marker for encrypted items, and is the format stable across joplin 3.7.1?** If NO → verification gate uses a Node-based SQLite probe (Risks #5). Fallback documented.

## 10. Handoff note

The next subtask is **M2-T2 (server-start-reorder)**, which depends on this. M2-T2 moves the api-port + server-start + health-wait + api-token-extraction + server-probe block (`:330-426`) to AFTER the sync+decrypt region — i.e. after M2-T1's decrypt block in the initial-sync success branch and the `START_PERIODIC_LOOP` assignment — and before the MCP server start. **[2026-10-03: superseded — M2-T2 is descoped (`plans/backlog.md` §1 / §3 D1 user ratification; see the status header in `M2-T2-server-start-reorder.md`); the next subtask is M2-T3.]**

The next-next is **M2-T3 (sync-detection-and-healthcheck-hardening)**, which expands `check_sync_errors` patterns (add `DecryptionWorker` + `no master key is currently loaded`) and updates the Dockerfile.combined `HEALTHCHECK` to probe E2EE state.

The final subtask is **M2-T4 (flip-to-green-verification-and-docs)**, which re-runs the M1-T3 test with zero assertion edits and updates the README's "Known gap" subsection to a "Resolved" note.

## Non-goals

- No changes to `src/` (M2 is entrypoint + Dockerfile only; matches Decision 1's "stay within A+B2+C scope").
- No changes to `check_sync_errors` (M2-T3 owns that; M2-T1's bounded retries + halt-marker cover the immediate failure path).
- No changes to the periodic sync loop (M2-T1 only modifies the initial-sync region; the periodic loop at `:503-557` is untouched).
- No retry of `e2ee decrypt` triggered by the periodic loop (out of scope; would be a different milestone).

## Amendment — 2026-10-04: implementation divergences recorded (backlog §6 E2)

Recorded by the documentation batch. The historical §5 snippet (`:82-129`) and all
text above are preserved unedited. Line numbers for `entrypoint-combined.sh` refer to
the current working tree, which carries the M2-T1 implementation plus the D3
master-key preflight as uncommitted changes.

1. **Verification gate is the SQLite probe, not the planned `joplin ls -l | grep '\[Encrypted\]'`.** The planned grep gate (`:119`) is impossible: Spike 3 (`:176`) answered **NO** — joplin 3.7.1 `ls -l` emits no `[Encrypted]` marker (rationale recorded in the probe comment `entrypoint-combined.sh:666-688`; backlog §2 R5). As implemented, the gate counts rows with non-empty `encryption_cipher_text` across six tables (notes, folders, resources, tags, note_tags, revisions) via a read-only node/sqlite3 probe (`entrypoint-combined.sh:689-707`, invocation `:708`). §5's second Spike-required bullet (`:139`) pre-authorized exactly this fallback ("count rows where `encryption_cipher_text` is non-empty via a Node-based probe").
2. **A third fail-closed arm exists in implementation but not in the planned two-arm snippet (`:110-127`):** "probe failed / returned a non-integer" (`entrypoint-combined.sh:718-722`, `[E2EE_DECRYPT_INCOMPLETE]` marker at `:720`) — a failed probe or garbage output cannot produce an "integer expression expected" error and falls through to the fail-closed halt.
3. **Probe/decrypt stderr reaches `e2ee-decrypt-stderr.log`:** the verification-probe invocation appends to it (`:708`), the master-key-preflight probe invocation appends to it (`:628`), and the retry-loop `joplin e2ee decrypt` invocation writes (truncates) it per attempt (`:652-653`).
4. **The §6 acceptance scenario (`:148`, "verification passes (0 `[Encrypted]` markers)") is superseded in wording only** — semantics unchanged: the probe returns 0 and the 0-arm logs "E2EE decrypt complete; 0 encrypted items remaining" (`entrypoint-combined.sh:715-717`, message at `:716`).
5. **Structural note (beyond §5's scope):** the whole decrypt/verify block is wrapped in the D3 master-key preflight and its `if [ "${MASTER_KEY_COUNT}" != "0" ]` guard (`entrypoint-combined.sh:646`; retry loop proper `:650-659`, closing `fi` `:730`), itself inside the `if [ -n "${JOPLIN_MASTER_PASSWORD:-}" ]` master-password guard (`:553`) — cross-ref `entrypoint-combined.sh:542-732`.
