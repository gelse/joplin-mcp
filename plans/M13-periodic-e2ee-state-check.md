# M13 — Periodic E2EE State Check Inside the Sync Loop

> Source: [`plans/backlog.md`](backlog.md) §1 (Live plans) **F2 → M13** (deferred by M2-T3 Risk 5; now planned).
> Refines the scope hinted at in [`plans/_finished/M2-T3-sync-detection-and-healthcheck-hardening.md`](_finished/M2-T3-sync-detection-and-healthcheck-hardening.md) §8
> Risk 5 (`M2-T3:176` in the pre-filing copy).
> Implementation starts in a fresh session from this file alone.

## Problem

The post-decrypt E2EE state check
[`check_e2ee_state()`](../entrypoint-combined.sh:272)
is implemented and called once, immediately after the initial-sync decrypt
block ([`entrypoint-combined.sh:842`](../entrypoint-combined.sh:842)). It is
**not** called from the periodic sync loop body
([`entrypoint-combined.sh:883-935`](../entrypoint-combined.sh:883)). Between
the initial check and the next periodic sync, the local SQLite database can
acquire new encrypted rows — a server-side partial decrypt under contention,
a newly-arrived encrypted item from the sync target, or an out-of-band
manual mutation of `database.sqlite`. The container will then happily serve
ciphertext again, with the encryption-aware `HEALTHCHECK`
([`Dockerfile.combined:86-87`](../Dockerfile.combined:86)) only catching
the symptom on the next 30 s probe tick — and the periodic sync itself will
write to the DB without ever noticing.

The function is already exported for the loop body
([`entrypoint-combined.sh:876`](../entrypoint-combined.sh:876), with the
comment "not yet called by the loop body … per M2-T3 Risk 5 / backlog F2");
the wiring is half-done and waits for a milestone to land the other half.

## Goal

Call [`check_e2ee_state()`](../entrypoint-combined.sh:272) once per periodic
sync iteration, fail-closed on detection of remaining encrypted items or on
probe failure, dovetailing with the existing halt gate. The periodic sync
loop body grows by exactly one call; no new state, no new probe logic, no
new exports.

## Proposed Approach

In the periodic `setsid bash -c '…' &
` block ([`entrypoint-combined.sh:882-935`](../entrypoint-combined.sh:882)),
insert one `check_e2ee_state "Periodic"` call **after** the deletion
circuit-breaker call ([`entrypoint-combined.sh:932-933`](../entrypoint-combined.sh:932))
and before the loop's `done` close (`entrypoint-combined.sh:934`).

### Exact insertion (current tree)

After
[`entrypoint-combined.sh:933`](../entrypoint-combined.sh:933)
(the `check_deletion_circuit_breaker "Periodic" …` line), insert:

```bash
            # ----- M13: periodic E2EE state check (backlog F2) -----
            # Defense-in-depth: cover encrypted items that arrive or
            # become encrypted between the initial check
            # (entrypoint-combined.sh:842) and this iteration. The
            # helper already writes the [E2EE_DECRYPT_INCOMPLETE]
            # halt marker on TRIP (rc=2); the NEXT iteration's halt
            # gate (entrypoint-combined.sh:888-892) will then refuse
            # to sync, matching the initial-sync failure semantics.
            # This iteration's sync has already run; the marker
            # prevents the next one. Same return-code contract as
            # every other check_* call site: 0=PASS, 1=SKIP-WARN
            # (reserved; not currently produced), 2=TRIP.
            E2EE_STATE_RC=0
            check_e2ee_state "Periodic" || E2EE_STATE_RC=$?
            if [ "${E2EE_STATE_RC}" -eq 2 ]; then
                log "ERROR" "Periodic E2EE state check tripped — halt marker written; next iteration will refuse to sync"
            fi
```

No other changes. The helper's existing
`flock -w 60` against [`SYNC_LOCK_FILE`](../entrypoint-combined.sh:33) (set
at `:304`) serializes against a concurrent `joplin sync`; the call runs after
sync completes, so no race. The helper's existing
`if [ -z "${JOPLIN_MASTER_PASSWORD:-}" ]; then return 0; fi`
early-return ([`entrypoint-combined.sh:276-278`](../entrypoint-combined.sh:276))
covers the no-master-password case identically to the initial-sync call.

### Trip policy mid-loop

On TRIP (rc 2), the helper has already written the
`[E2EE_DECRYPT_INCOMPLETE]` halt marker with the count or "probe failed"
reason ([`entrypoint-combined.sh:315-323`](../entrypoint-combined.sh:315)).
The current iteration's `joplin sync` has already run; the marker prevents
the **next** iteration from syncing (the gate at
[`entrypoint-combined.sh:888-892`](../entrypoint-combined.sh:888) reads it
before sleeping; it never reaches `joplin sync` again). Operator workflow
unchanged: investigate via the marker, remove it to retry — the next
iteration's `check_e2ee_state` call is the re-validation.

### Frequency

One call per iteration, after every successful or failed sync. Cost: one
flock-locked SQLite probe of six tables
([`entrypoint-combined.sh:280-298`](../entrypoint-combined.sh:280)); verified
in-image as < 1 s on the pinned 3.7.1 CLI / SQLite at the M2-T3 commit
`451845c` (record in the run report cited under M2-T4 Step 2; same probe
runs in the HEALTHCHECK with a 5 s `busy_timeout` and a 10 s
`--timeout`).

### Interaction with M12 (periodic halt-gate double sleep)

Out of scope for M13. M12's defect lived at
[`entrypoint-combined.sh:888-892`](../entrypoint-combined.sh:888) (gate) and
the inner sleep at `:890`; M13 inserts after `:933`, well below the gate.
M12's fix landed 2026-10-08 (plan filed under `plans/_finished/`): it
shortened the wait between gate refusal and the loop's `continue` — it
does not change M13's call cadence or its post-probe control flow.

## Acceptance Criteria

- The periodic sync loop body contains exactly one new
  [`check_e2ee_state "Periodic"`](../entrypoint-combined.sh:272) call,
  placed after the deletion circuit-breaker call and before the loop's
  `  done` close (current line `:933` → insertion at `:934`; subsequent
  lines shift by +17).
- A new structural grep test in
  [`tests/test-check-sync-errors.sh`](../tests/test-check-sync-errors.sh)
  (Group 5 expanded, or a new Group 7) asserts the periodic loop calls
  `check_e2ee_state`. The grep is:
  ```bash
  run_test "check_e2ee_state is called from the periodic loop" 0 \
      bash -c 'awk "/setsid bash -c/{flag=1; next} flag && /check_e2ee_state/{found=1; exit} END{exit !found}" "$1"' _ "${ENTRYPOINT}"
  ```
  (`flag` starts inside the `setsid bash -c '...'` heredoc, `found`
  flips true the first time `check_e2ee_state` appears before `END`.)
- The pre-existing structural test at
  [`tests/test-check-sync-errors.sh:781`](../tests/test-check-sync-errors.sh:781)
  ("check_e2ee_state present in export -f list") still passes
  byte-identically — M13 adds no new function or export.
- All existing shell harnesses stay green:
  `bash tests/test-check-sync-errors.sh`,
  `bash tests/test-sync-failure-diagnostics.sh`,
  `bash tests/test-sync-halt-tag-aware.sh`,
  `bash tests/test-final-sync-danger-check.sh`,
  `bash tests/test-e2ee-master-key-preflight.sh`.
- The vitest unit suite stays green (`node_modules/.bin/vitest run` →
  428 passed / 14 skipped). No `src/` change.
- Manual verification (post-merge, gated CI): in the
  `RUN_E2EE_REPRO_TESTS=1` stack, observe
  `reports/container/joplin-mcp.log` for `[Periodic] E2EE state check
  passed; 0 encrypted items remaining` between iterations on a clean
  fixture.

## Verification

1. **Structural grep (per Acceptance above).** Add the test to
   `tests/test-check-sync-errors.sh` Group 7 and run
   `bash tests/test-check-sync-errors.sh` → all pass.
2. **Unit suite.** `node_modules/.bin/vitest run` → 428 passed / 14
   skipped (the count locked by the project's bookkeeping rule; no
   `src/` change ⇒ no count change).
3. **Shell suites.** All five `tests/test-*.sh` scripts above → green.
4. **In-image behavioural check.** `RUN_E2EE_REPRO_TESTS=1 bash
   scripts/run-integration-tests.sh` → exit 0; tail
   `reports/container/joplin-mcp.log` and confirm a
   `[Periodic] E2EE state check passed` line appears after the first
   `joplin sync` of the periodic loop (one per iteration).
5. **Halt-mark trip (manual verification only, gated CI).** In a fresh
   `RUN_E2EE_REPRO_TESTS=1` run, between iterations manually inject a
   ciphertext update via
   `docker exec joplin-mcp bash -c '...'` that bumps
   `encryption_cipher_text` on one row (out of scope for M13 to
   automate — the test infra would have to write to the DB, which
   violates the test-stack's read-only stance on the combined
   container's profile). Confirm the next iteration writes the
   `[E2EE_DECRYPT_INCOMPLETE]` halt marker and the gate refuses the
   following sync.

## Non-goals

- No fix to the M12 defect (the periodic halt-gate double sleep). M13
  inserts below the gate; the two are independent. M12 was filed under
  `plans/_finished/` when its fix landed 2026-10-08.
- No change to the probe JS in
  [`check_e2ee_state`](../entrypoint-combined.sh:280). The
  triple-lockstep rule (entrypoint:280-298, M2-T1 verification at
  `:791-810`, Dockerfile HEALTHCHECK at
  [`Dockerfile.combined:87`](../Dockerfile.combined:87), documented
  in the LOCKSTEP comment at
  [`entrypoint-combined.sh:265-268`](../entrypoint-combined.sh:265))
  stays a three-way contract.
- No change to `src/`. M14 covers the Node-side `/health/e2ee`
  endpoint when that lands; M13 is the shell-side periodic re-check
  and does not touch MCP code.
- No change to `check_e2ee_state`'s return-code contract (0=PASS,
  1=SKIP-WARN reserved, 2=TRIP; see the contract doc at
  [`entrypoint-combined.sh:256-258`](../entrypoint-combined.sh:256) and
  the case arms at `:309-326`).
- No CHANGELOG.md change. The release process owns changelog.
- No commit creation.
- **Citation-drift finding on M12 — discharged 2026-10-08:** this
  analysis originally surfaced that M12's entrypoint line cites
  ([`entrypoint-combined.sh:492`](../entrypoint-combined.sh:492) top
  sleep, `:495-500` gate branch, `:498` inner sleep, `:419-422`
  initial-sync gate) had drifted post-D4/M2-T3 (~396 lines) while M12
  was under a "surface as finding, do not edit M12" instruction. That
  debt is cleared: M12's entrypoint line cites were re-derived and
  refreshed on 2026-10-08 (this triage) and now match the tree
  (`:884`, `:888-892`, `:890`, `:862-940`, `:590-594`, plus
  `tests/test-sync-failure-diagnostics.sh:93-101`). The drift finding
  is discharged; M13 cites the same current line numbers.