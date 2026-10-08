# M2-T3 — C: sync error detection + E2EE-aware healthcheck

> **Filing note (2026-10-08):** moved from `plans/M2-T3-sync-detection-and-healthcheck-hardening.md`
> to `plans/_finished/M2-T3-sync-detection-and-healthcheck-hardening.md` in the 2026-10-08
> backlog-triage filing batch (body untouched; the file contains no markdown links, so no
> link re-depth was needed). **Finished:** delivered — landed in commit `451845c` ("Expand
> sync-error patterns and gate boot on E2EE state (M2-T3)"); resolved backlog Q1–Q6, Q8,
> Q9 and F1 (re-verified against the tree 2026-10-08).

> Subtask of **M2 — E2EE Encrypted Titles Fix (scope A + B2 + C)**.
> Belongs to the fix milestone (M2). Implementation starts in a fresh
> session from this file alone.

## 1. Header

- **Subtask ID:** M2-T3
- **Milestone:** M2 (fix)
- **Dependencies (other subtask IDs):** M2-T1 (the new decrypt block exposes failures that need to be detected; the expanded pattern catches them).
- **What it delivers:** (a) Expanded `combined_pattern` in `entrypoint-combined.sh:74` to catch the actual DecryptionWorker wording ("DecryptionWorker" + "no master key is currently loaded"); (b) A new post-sync encrypted-item check helper `check_e2ee_state()` that counts remaining `[Encrypted]` items and writes the halt marker if non-zero (alternative path for cases where `joplin e2ee decrypt` exits 0 but leaves items encrypted) (**[2026-10-04: SUPERSEDED — detection re-based on M2-T1's SQLite probe; see the SUPERSEDED note at `:112` and the Amendment below.]**); (c) E2EE-aware `HEALTHCHECK` in `Dockerfile.combined:86-87` that probes `/health/e2ee` (a new endpoint inside the combined container — see §5 for the design choice between shell-side and Node-side probe).

## 2. Full problem context

GitHub issue #29 reports the combined container serves E2EE-encrypted
notebook titles as-is via `list_notebooks` despite `JOPLIN_MASTER_PASSWORD`
set. The reporter saw empty `title` fields, `SYNC_PASS` despite encrypted
state (corroborated by `README.md:60`), and a manual `joplin e2ee decrypt`
that first failed ("DecryptionWorker: cannot start because no master key
is currently loaded") before succeeding — 204 items decrypted, plaintext
served without restart.

**Root cause C (per the source plan's root-cause table):**
- `check_sync_errors()` (`:71-110`) pattern-matches the literal string "Master key is not loaded" but NOT the actual DecryptionWorker wording "no master key is currently loaded" (verified: `grep "currently loaded|DecryptionWorker" entrypoint src tests` → zero hits in the current codebase). This is the detection blind spot that allowed the bug to ship silently.
- The `HEALTHCHECK` in `Dockerfile.combined:86-87` probes `/ping` and `/health` only — encryption-agnostic. A container that started but failed to decrypt items passes its healthcheck.

M2-T3 implements C: tighten the pattern, add the post-decrypt verification (which is the second leg of M2-T1's gate; this is the "redundant" check that catches partial-decrypt under contention), and the E2EE-aware healthcheck.

## 3. Authoritative investigation evidence (with file:line)

- **entrypoint-combined.sh:74** — current `combined_pattern`:
  ```sh
  local combined_pattern='\[error\]|There was some errors|Could not encrypt item|Master key is not loaded|SQLITE_BUSY|database is locked|Upgrading database from version 0|Current database version.*null'
  ```
  Missing: `DecryptionWorker`, `no master key is currently loaded`.
- **entrypoint-combined.sh:71-110** — `check_sync_errors()` function structure. The function uses `grep -i -q -E` (line 92, 97). Adding to `combined_pattern` is a one-line change.
- **entrypoint-combined.sh:157-170** — `get_sync_item_count()` uses `flock -w 60 "${SYNC_LOCK_FILE}"`. The new `check_e2ee_state()` (M2-T3) follows the same pattern: `flock -w 60` to serialize with concurrent syncs.
- **entrypoint-combined.sh:479-483** — existing call site for `check_deletion_circuit_breaker` after the initial sync. M2-T3's `check_e2ee_state` is called at the same site (or just after, in M2-T1's new block).
- **Dockerfile.combined:83-87** — current `HEALTHCHECK`:
  ```dockerfile
  # Health check: verify both MCP server and Data API are responding.
  # NOTE: Probes the default ports only; does not honour JOPLIN_DATA_API_PORT
  # or MCP_PORT overrides — matches core's existing healthcheck pattern.
  HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=90s \
      CMD curl -f http://127.0.0.1:41184/ping && curl -f http://127.0.0.1:3000/health || exit 1
  ```
  Encryption-agnostic. M2-T3 changes the `CMD` to additionally verify E2EE state.

## 4. Scope

**Files to modify:**
- `entrypoint-combined.sh` (two changes: `combined_pattern` on `:74`; new `check_e2ee_state()` function + its call site after M2-T1's decrypt block).
- `Dockerfile.combined` (HEALTHCHECK `CMD` update).

**Files NOT to touch:**
- `src/` (M2 is entrypoint + Dockerfile; matches Decision 1's scope).
- `docker-compose.test.yml` (test-stack healthcheck is separate; the `joplin-mcp` service's healthcheck in compose is for the test stack and can be left to mirror the Dockerfile; see Risks #4).
- `check_sync_danger()` (`:121-149`) — its pattern is for the destructive-migration case (issue #27); not in scope for issue #29.
- `get_sync_item_count()` (`:157-170`) — used for the deletion circuit-breaker; not modified by M2-T3 (M2-T3's `check_e2ee_state` is a separate helper that follows the same `flock` convention but queries a different surface).

## 5. Exact behavior required

### Change 1: expand `combined_pattern` (line 74)

Replace:
```sh
local combined_pattern='\[error\]|There was some errors|Could not encrypt item|Master key is not loaded|SQLITE_BUSY|database is locked|Upgrading database from version 0|Current database version.*null'
```
with:
```sh
local combined_pattern='\[error\]|There was some errors|Could not encrypt item|Master key is not loaded|no master key is currently loaded|DecryptionWorker|SQLITE_BUSY|database is locked|Upgrading database from version 0|Current database version.*null'
```

`grep -i -q -E` is case-insensitive by default; the new patterns are literal substrings of the actual log lines.

### Change 2: new `check_e2ee_state()` helper

Insert after `get_sync_item_count()` (after `:170`):

```bash
# -----------------------------------------------------------------------------
# Post-decrypt E2EE state check (M2-T3)
# Returns 0 if zero items are still encrypted; 2 if any remain (writes halt
# marker); 1 if the check could not be performed (warn, do not halt).
# Mirrors check_deletion_circuit_breaker's return-code contract: 0=PASS,
# 1=SKIP-WARN, 2=TRIP.
# Each `joplin ls` is flock-wrapped with SYNC_LOCK_FILE so it does not race
# a concurrent sync.
# -----------------------------------------------------------------------------
check_e2ee_state() {
    local label="$1"
    # JOPLIN_MASTER_PASSWORD not set ⇒ nothing to check.
    if [ -z "${JOPLIN_MASTER_PASSWORD:-}" ]; then
        return 0
    fi
    local enc_count
    if ! enc_count=$(flock -w 60 "${SYNC_LOCK_FILE}" joplin ls -l -n 99999 2>/dev/null | grep -c '\[Encrypted\]' || echo 0); then
        log "WARN" "[${label}] E2EE state probe failed (joplin ls error) — skipping"
        return 1
    fi
    if [ "${enc_count}" -gt 0 ]; then
        log "ERROR" "[${label}] ${enc_count} item(s) still encrypted after decrypt — writing halt marker"
        log "ERROR" "[${label}] See issue #29; remove ${SYNC_HALT_MARKER} after investigating"
        echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [E2EE_DECRYPT_INCOMPLETE] ${enc_count} item(s) still encrypted. See issue #29." > "${SYNC_HALT_MARKER}"
        return 2
    fi
    return 0
}
```

> **[2026-10-04: SUPERSEDED — the `[Encrypted]` grep in this draft (`:98`) is void.** Spike 1 answered NO: joplin 3.7.1 `joplin ls -l` emits no `[Encrypted]` marker (`plans/backlog.md` §2 R5; the answer is recorded in the probe comment `entrypoint-combined.sh:670-676`). Per the user-approved re-scope (Amendment at end of file), `check_e2ee_state()` must reuse M2-T1's implemented read-only SQLite probe — count rows with non-empty `encryption_cipher_text` via the node probe at `entrypoint-combined.sh:689-707`, with integer validation and fail-closed semantics as in the `case` at `entrypoint-combined.sh:714-728`. Draft text retained for the record.]

**Call site:** in M2-T1's new block (after the `REMAINING_ENC` check). The check is REDUNDANT with M2-T1's inline verification but covers the case where a periodic sync left items encrypted (e.g. server-side partial decrypt under contention). The redundancy is intentional defense-in-depth.

Add the function to the `export -f` list at `:498`:
```bash
export -f log log_sync check_sync_errors check_sync_danger get_sync_item_count check_deletion_circuit_breaker check_e2ee_state
```

### Change 3: E2EE-aware `HEALTHCHECK` in `Dockerfile.combined`

Replace the existing `HEALTHCHECK` block (`:86-87`) with:

```dockerfile
# Health check: MCP HTTP, Data API, AND E2EE state.
# - /ping (Data API) + /health (MCP) verify the processes are up.
# - /health/e2ee verifies zero items are still encrypted (issue #29
#   regression guard). Implemented as a tiny endpoint inside the Node
#   MCP server (see src/mcp/server.ts in a follow-up); for now, the
#   shell-side probe below (joplin ls -l | grep -c '\[Encrypted\]')
#   is the implementation. When the Node endpoint lands, switch the
#   CMD to `curl -f http://127.0.0.1:3000/health/e2ee` and drop the
#   shell probe.
# NOTE: Probes the default ports only; does not honour JOPLIN_DATA_API_PORT
# or MCP_PORT overrides — matches core's existing healthcheck pattern.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=120s \
    CMD bash -c 'curl -f http://127.0.0.1:41184/ping && curl -f http://127.0.0.1:3000/health && [ "$(joplin ls -l -n 99999 2>/dev/null | grep -c "\[Encrypted\]" || echo 0)" = "0" ] || exit 1'
```

> **[2026-10-04: SUPERSEDED — the `[Encrypted]` grep in this draft's HEALTHCHECK CMD (`:136`) is void for the same reason (R5; `entrypoint-combined.sh:670-676`).** Per the user-approved re-scope (Amendment at end of file), the healthcheck probe must reuse M2-T1's implemented read-only SQLite probe (`entrypoint-combined.sh:689-707`, integer validation + fail-closed `case` at `:714-728`). Draft text retained for the record.]

**Note on the `start-period` bump from 90s to 120s:** M2-T1 + M2-T2 add ≤ 35s to cold-start; bumping start-period absorbs the longer first-boot window. **[2026-10-03: the M2-T2 share of this rationale is void — T2 descoped (`plans/backlog.md` §1 / §3 D1); only M2-T1's ≤ 20s applies. Revisit the 90s→120s bump during M2-T3 execution (`plans/backlog.md` §4 Q5).]**

**Note on the `[Encrypted]` count check:** the `bash -c '...'` form inlines the comparison because `HEALTHCHECK CMD` is executed via `sh -c`, and the inline `$(...)` + `grep -c` work in both shells. If `joplin` is not on PATH for the `joplin` user (it's installed globally at `/usr/local/bin/joplin` per `Dockerfile.combined:47`), the shell will find it. Verified by the existing entrypoint's use of `joplin` without an absolute path.

**Note on the Node-side `/health/e2ee` endpoint as the design choice:** the shell-side probe is the chosen implementation for M2-T3 because (a) it stays within the entrypoint + Dockerfile scope (A+B2+C explicitly excludes src/ redesign), (b) the CLI is already the verified path the entrypoint uses for all E2EE operations, and (c) it requires no Node-side change. **Fallback (Risk #3):** if the shell probe proves fragile (e.g. `joplin` not on PATH in some env), implement a Node-side `/health/e2ee` endpoint in `src/mcp/server.ts` (out of scope for M2; document in `Risks/gotchas`).

## 6. Acceptance criteria

- `shellcheck entrypoint-combined.sh` → no new warnings (the new function follows existing `check_*` conventions).
- The new `check_e2ee_state` is exported and reachable from the periodic-loop subshell (per `export -f` update).
- After a sync that produces 0 encrypted items (the normal case post-M2-T1): `check_e2ee_state "Initial"` returns 0; no halt marker; periodic sync starts.
- After a sync that produces 0 items total (no fixtures on the server): `check_e2ee_state` returns 0 (0 -gt 0 is false).
- After a sync that produces ≥1 encrypted item (the bug case): `check_e2ee_state` returns 2; halt marker written with `[E2EE_DECRYPT_INCOMPLETE]` prefix; periodic sync NOT started (`START_PERIODIC_LOOP=0`).
- The expanded `combined_pattern` matches the actual DecryptionWorker log line. Manual test: `printf '2026-10-02 10:43:51: e2ee/utils: DecryptionWorker: cannot start because no master key is currently loaded\n' | grep -i -E 'no master key is currently loaded|DecryptionWorker'` → exit 0.
- The expanded `combined_pattern` still matches the original issue #27 destructive-migration patterns. Manual test: the existing `tests/test-check-sync-errors.sh` harness → green.
- `Dockerfile.combined`'s new `HEALTHCHECK` exits 0 on a healthy post-M2-T1+T2 container; exits 1 when `[Encrypted]` items remain. **[2026-10-03: read "post-M2-T1+T2" as "post-M2-T1" — T2 descoped (`plans/backlog.md` §1 / §3 D1).]**

## 7. Verification commands

1. **Static check:** `shellcheck entrypoint-combined.sh` → no new warnings.
2. **Pattern test:** the manual test in Acceptance #6 above (DecryptionWorker log line matches).
3. **Functional test (M1-T3 RED on M2-T3-only code, GREEN on M2-T1+T2+T3):** **[2026-10-03: read "M2-T1+T2+T3" as "M2-T1+M2-T3" — T2 descoped (`plans/backlog.md` §1 / §3 D1).]**
   - Apply only M2-T3 (do not apply M2-T1 or M2-T2): `RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh` → exit 1; the symptom is unchanged (no decrypt step), but the expanded `combined_pattern` now correctly matches the DecryptionWorker log if one is present. Verify the post-mortem log shows the pattern caught the failure. **[2026-10-03: T2 descoped — moot for this isolation step.]**
   - Apply M2-T1 + M2-T2 + M2-T3: `RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh` → exit 0 (GREEN); no assertion edits in M1-T3. **[2026-10-03: read as "Apply M2-T1 + M2-T3" — T2 descoped.]**
4. **Healthcheck test:** `docker inspect --format '{{json .State.Health}}' joplin-mcp` after a clean run → status `healthy`.
5. **Pattern regression:** `bash tests/test-check-sync-errors.sh` → all pass (the expanded pattern still matches the issue #27 destructive-migration patterns).

## 8. Risks / gotchas

- **Risk 1: `combined_pattern` over-matching.** The new patterns (`DecryptionWorker`, `no master key is currently loaded`) are substrings of legitimate log lines that may appear in non-error contexts. Mitigation: `grep -i -q -E` matches across the whole log file; if a legitimate log line happens to contain the substring, the check returns 1 (false positive). **Escape hatch:** anchor the patterns more precisely (e.g. `DecryptionWorker.*cannot start`, `DecryptionWorker: cannot start because no master key is currently loaded`) so only error contexts match. Update the pattern if false positives appear in CI.
- **Risk 2: `check_e2ee_state` performance.** `joplin ls -l -n 99999` enumerates all items. For a 10k-item profile, this is < 1s (CLI is fast for local reads). For a 100k-item profile, ~5-10s. The `flock -w 60` is generous. **Escape hatch:** if performance becomes an issue, use the SQLite-direct probe (Spike below) to count `SELECT COUNT(*) FROM items WHERE encryption_cipher_text != ''` — but that requires a Node helper, which is out of scope for M2-T3. **[2026-10-04: MOOT — the `joplin ls -l -n 99999` probe premise is void per R5 (no `[Encrypted]` marker exists to grep; backlog §2 R5), so this full-listing cost never arises; the replacement SQLite probe (`entrypoint-combined.sh:689-707`) has no such cost. Text kept.]**
- **Risk 3: Shell-side healthcheck fragility.** The `bash -c '... joplin ls -l -n 99999 ...'` form depends on `joplin` being on PATH for the `joplin` user. If the entrypoint's PATH does not include `/usr/local/bin` (where the CLI is installed per `Dockerfile.combined:47`), the healthcheck fails. **Escape hatch:** switch to absolute path `/usr/local/bin/joplin` in the HEALTHCHECK; or implement the Node-side `/health/e2ee` endpoint.
- **Risk 4: docker-compose.test.yml healthcheck.** The `joplin-mcp` service in compose uses `curl -f http://localhost:41184/ping && curl -f http://localhost:3000/health` (no E2EE probe). Update it to mirror the Dockerfile: `curl -f http://localhost:41184/ping && curl -f http://localhost:3000/health && [ "$(joplin ls -l -n 99999 2>/dev/null | grep -c "\[Encrypted\]" || echo 0)" = "0" ]` (in the test stack, the joplin CLI is in the `joplin-mcp` image at the same path; the test-runner service depends on `joplin-mcp` becoming healthy, so this is reachable from the test-runner via the joplin-mcp exec — no change needed; the test stack's healthcheck is on the joplin-mcp container itself, where `joplin` is on PATH). **Confirm by inspection of `docker-compose.test.yml:15-20` (the healthcheck block); update if the test environment differs.** **[Corrected 2026-10-04: the citation "`docker-compose.test.yml:15-20` (the healthcheck block)" is stale — `:15-20` are env/comment lines; the `joplin-mcp` service's healthcheck block is actually `docker-compose.test.yml:22-27` (verified). Old citation kept above.]**
- **Risk 5: `check_e2ee_state` + periodic loop interaction.** The function is exported via `export -f` so the periodic-loop subshell can call it. The subshell does not currently call it (M2-T3 does NOT add the call to the periodic loop). **Out of scope for M2-T3**; a future milestone could add a periodic `check_e2ee_state` call inside the loop body.

## 9. Research spikes assigned

- **Spike 1 (~15 min): confirm `joplin ls -l` emits `[Encrypted]` markers for encrypted items, and that the format is stable.** This is shared with M2-T1's verification gate; if M2-T1's spike answer is YES, this subtask is also fine. Fallback: SQLite-direct probe (Risk #2 escape hatch). **[2026-10-04: ANSWERED NO — joplin 3.7.1 `ls -l` emits no `[Encrypted]` marker (backlog §2 R5; recorded at `entrypoint-combined.sh:670-676`). The fallback this spike proposed (SQLite probe) is exactly what landed in M2-T1 (`entrypoint-combined.sh:689-707`) and is now the mandated basis for Changes 2 and 3 — see the Amendment at end of file.]**
- **Spike 2 (~15 min): confirm `joplin` is on PATH for the `joplin` user in the combined container** (used by the HEALTHCHECK CMD). Fallback: use absolute path `/usr/local/bin/joplin`.
- **Spike 3 (~30 min): do the existing test-check-sync-errors.sh tests pass with the expanded `combined_pattern`?** They are pattern-based; if any test relies on a non-match, it must be updated. The tests are designed to verify the patterns match the destructive signatures; an additional match is acceptable (returns 1 earlier, but the test only checks `combined_pattern.test(file_with_signature) === true`).

## 10. Handoff note

The next subtask is **M2-T4 (flip-to-green-verification-and-docs)**, which depends on M2-T1, M2-T2, and M2-T3. **[2026-10-03: read dependencies as "M2-T1 and M2-T3" — T2 descoped (`plans/backlog.md` §1 / §3 D1).]** M2-T4:
1. Builds the combined container with M2-T1+T2+T3 entrypoint. **[2026-10-03: read as "M2-T1+M2-T3 entrypoint" — T2 descoped.]**
2. Runs `RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh` → expect exit 0 (GREEN); no assertion edits in `tests/container/e2ee-encrypted-titles-repro.test.ts`.
3. Verifies the anti-vacuous gates still fire loudly when the seed is broken (re-run with seeder disabled → `SEED_GATE_FAILED`; re-run with seed-server unreachable → `FIXTURE_NOT_SYNCED`).
4. Updates `README.md` to convert the M1-T6 "Known gap" subsection into a "Resolved" subsection pointing to the M2 plan files.

M2-T4 closes the M1+M2 milestone.

## Non-goals

- No source-code changes.
- No `cli-executor.ts` whitelist changes (M2-T3 does not call `e2ee` from Node).
- No periodic-loop changes.
- No CHANGELOG.md changes (the release process owns changelog).

## Amendment — 2026-10-04: detection re-based on the M2-T1 SQLite probe (user-approved re-scope)

**Actor: the USER (approved 2026-10-04); applied by the documentation batch.** This
amendment re-scopes the detection method for **Change 2** (`check_e2ee_state()`, §5,
draft grep at `:98`) and **Change 3** (E2EE-aware `HEALTHCHECK`, §5, draft grep at
`:136`). Both must reuse M2-T1's implemented read-only SQLite probe instead of
`joplin ls -l` + grep: count rows with non-empty `encryption_cipher_text` via the node
probe at `entrypoint-combined.sh:689-707` (rationale `:666-688`), with integer
validation and fail-closed semantics as in the `case` at
`entrypoint-combined.sh:714-728`. The two superseded drafts are marked SUPERSEDED in
place (dated inline annotations after their code fences); their text is retained.

**Reason.** Spike 1 (§9, `:176`) answered **NO** — joplin 3.7.1 `joplin ls -l` emits
no `[Encrypted]` marker (`plans/backlog.md` §2 R5; the answer is recorded in the probe
comment `entrypoint-combined.sh:670-676`). A grep-based gate is impossible; the
fallback the drafts themselves named is the probe that actually landed in M2-T1.

**Line-number convention for this section:** `:N` references to this file refer to the
file's state BEFORE this amendment's inline annotations were inserted (the two
SUPERSEDED markers shift later lines by +1 / +2).

**Scope status after this amendment (nothing is implemented by it — documentation only):**
- **Change 1 (Q3)** — the `combined_pattern` expansion (`:64-75`) is unchanged by this
  amendment and remains **unimplemented** (backlog §4 Q3).
- **Changes 2 and 3** — re-based per this amendment; **unimplemented**. Open
  verification items carry over unchanged: Spike 2 (`joplin` on PATH for the
  HEALTHCHECK, `:177`; backlog §4 Q1), Spike 3 (existing shell tests vs the expanded
  pattern, `:178`; backlog §4 Q2), Risk 1 over-matching (`:168`; backlog §4 Q6),
  Risk 3 shell fragility (`:170`; backlog §4 Q8), and Risk 4 confirm-by-inspection
  (`:171`, now with the corrected `docker-compose.test.yml:22-27` pointer; backlog
  §4 Q9). The 90s→120s start-period rationale at `:139` already carries its
  2026-10-03 annotation and is left as-is.
- **Deferred review suggestions** — the two backlog §5 F1 items are queued to fold
  into the M2-T3 implementation dispatch (they are **NOT implemented here**):
  per-attempt stderr truncation in the retry loop (the per-attempt WARN at
  `entrypoint-combined.sh:657` surfaces none of `e2ee-decrypt-stderr.log`), and
  `--force` hardening of the bare `joplin e2ee decrypt` invocation
  (`entrypoint-combined.sh:652-653`).
