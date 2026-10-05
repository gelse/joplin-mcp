# M2-T4 — Flip-to-green verification + docs update

> Subtask of **M2 — E2EE Encrypted Titles Fix (scope A + B2 + C)** (B2
> descoped 2026-10-03 — see the Re-scope note below).
> Belongs to the fix milestone (M2). Implementation starts in a fresh
> session from this file alone.

> **RE-SCOPE NOTE (2026-10-03, user-approved D2 — `plans/backlog.md` §3 D2).**
> The GREEN flip (old Step 2) already happened during the M2-T1 run: the
> M1-T3 repro went GREEN with M2-T1 alone (decision rule
> `plans/_finished/M2-T1-initial-sync-decrypt-and-verify.md:158`; outcome recorded in
> `plans/backlog.md` §1). M2-T2 is descoped (user ratification 2026-10-03;
> `plans/backlog.md` §3 D1). The residual scope of this task is: (i) Step 1
> test-immutability check; (ii) Step 3 anti-vacuous gates + default-suite
> regression; (iii) Step 4 README conversion (including backlog §6 E1);
> (iv) Step 5 diff summary. The steps below are kept as written for the
> historical record; each affected step carries its own dated annotation.

## 1. Header

- **Subtask ID:** M2-T4
- **Milestone:** M2 (fix)
- **Dependencies (other subtask IDs):** M2-T1 and M2-T3 (both must have landed). M2-T2 is descoped (2026-10-03, user ratification — see `plans/backlog.md` §3 D1 and the "Amendment — 2026-10-03" section of `plans/_finished/M1-e2ee-encrypted-titles-repro-test.md`; the GREEN flip already occurred with M2-T1 alone, so no task waits on T2).
- **What it delivers (residual scope, re-scoped 2026-10-03 per D2):** confirmation that the M1-T3 repro test remains unchanged with **zero assertion edits** in `tests/container/e2ee-encrypted-titles-repro.test.ts` (Step 1) and is GREEN — already observed during the M2-T1 run (decision rule `plans/_finished/M2-T1-initial-sync-decrypt-and-verify.md:158`; outcome in `plans/backlog.md` §1), with the Step 2 commands kept as optional cheap re-confirmation; verification that the two anti-vacuous-pass gates still fire loudly under broken-seed conditions and the default suite stays green (Step 3); a README update converting M1-T6's "Known gap" subsection to a "Resolved" subsection plus fixing all other stale M1-era claims (Step 4, extended 2026-10-03 — see `plans/backlog.md` §6 E1); a `git diff` summary confirming no other files were touched (Step 5). The original deliverable — the first GREEN flip with zero assertion edits — was already satisfied by the M2-T1 run.

## 2. Full problem context

GitHub issue #29 reports the combined container serves E2EE-encrypted
notebook titles as-is via `list_notebooks` despite `JOPLIN_MASTER_PASSWORD`
set. The reporter saw empty `title` fields, `SYNC_PASS` despite encrypted
state, and a manual `joplin e2ee decrypt` that first failed
("DecryptionWorker: cannot start because no master key is currently
loaded") before succeeding — 204 items decrypted, plaintext served
without restart.

M1 (this split effort's first half) shipped the repro test (RED on
current code). M2 (the second half) ships the fix (A + B2 + C; B2 descoped
2026-10-03 — read as A + C; see the Re-scope note). M2-T4
is the verification step: confirm M1-T3 now passes with zero edits;
confirm the anti-vacuous gates still fail loudly when the seed is
broken (so a "vacuous green" cannot sneak through); update the README
to convert the "Known gap" wording to a "Resolved" note.

## 3. Authoritative investigation evidence (with file:line)

- **tests/container/e2ee-encrypted-titles-repro.test.ts** (M1-T3) — the test file. After M1 ships, this exists. After M2, it must pass **without any edits**.
- **entrypoint-combined.sh** (post M2-T1+T2+T3) — the fixed entrypoint. **[2026-10-03: read as "post M2-T1+M2-T3" — T2 descoped.]**
- **README.md:90-104** — the M1-T6 "Known gap" subsection. M2-T4 converts it to "Resolved".
- **docker-compose.test.yml** (post M1-T1) — the test stack with `joplin-server` and `joplin-e2ee-seed` profile-gated services.
- **scripts/run-integration-tests.sh** (post M1-T4) — the runner with `RUN_E2EE_REPRO_TESTS` pass-through.
- **.github/workflows/integration-tests.yml** (post M1-T5) — the opt-in `workflow_dispatch` job `e2ee-encrypted-titles-repro`.

## 4. Scope

**Files to modify:**
- `README.md` (M1-T6's "Known gap" → "Resolved" conversion; extended 2026-10-03 to also fix the stale claims at `README.md:254`, `:268`, `:274`, and the boot-sequence list at `README.md:662-671` — see the re-scoped Step 4).

**Files NOT to touch:**
- `tests/container/e2ee-encrypted-titles-repro.test.ts` (must remain unchanged; the flip-to-green is the proof).
- `entrypoint-combined.sh` (M2-T1/T2/T3 own this; M2-T4 verifies it does not change). **[2026-10-03: T2 descoped — read as M2-T1/T3.]**
- `docker-compose.test.yml` (M1-T1).
- `scripts/run-integration-tests.sh` (M1-T4).
- `.github/workflows/integration-tests.yml` (M1-T5).
- `src/` (M2 does not touch src/).
- `CHANGELOG.md` (out of scope; the release process owns changelog).
- `plans/_finished/M1-T1..T6` and `plans/_finished/M2-T1-initial-sync-decrypt-and-verify.md`, `plans/_finished/M2-T2-server-start-reorder.md`, `plans/M2-T3-sync-detection-and-healthcheck-hardening.md` (these are plans, not source; the plan files are reference material for future maintainers and should not be retroactively edited to reflect the implementation outcome).

## 5. Exact behavior required

### Step 1: confirm M1-T3 is unchanged

```bash
git diff tests/container/e2ee-encrypted-titles-repro.test.ts
```

→ empty output. (The file was created in M1-T3; no edits between M1-T3 ship and M2-T4.)

### Step 2: GREEN flip verification

> **[2026-10-03: ALREADY SATISFIED — the GREEN flip happened during the
> M2-T1 run: the repro went GREEN with M2-T1 alone (decision rule
> `plans/_finished/M2-T1-initial-sync-decrypt-and-verify.md:158`; outcome recorded in
> `plans/backlog.md` §1). The commands below are kept as an optional cheap
> re-confirmation; this step is no longer the flip.]**

```bash
docker compose -f docker-compose.test.yml down -v --remove-orphans 2>/dev/null
RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh
```

**Expected:** exit 0. The repro test passes because:
- The seed container creates the encrypted fixture.
- ~~The combined container starts with the M2-fixed entrypoint: master password set → sync → decrypt → verification → 0 encrypted items → server start → token extraction → MCP start.~~ **[2026-10-03: superseded — that boot order assumed the descoped M2-T2 reorder. Real order:]** the combined container runs the entrypoint as: master password config → Data API start (unchanged early position) → initial sync → `joplin e2ee decrypt` with bounded retries → zero-encrypted-items verification → MCP start last. The Data API serves plaintext after decryption without a restart — the observed GREEN-run behavior; the underlying re-read of the SQLite DB after out-of-process `e2ee decrypt` is the Spike-1 answer *(inference from the GREEN outcome; `plans/backlog.md` §2 R6)*.
- `list_notebooks` returns the seeded notebook with non-empty plaintext title and `encryption_applied === 0`.

If the test fails:
- Check the M1-T3 log message: if `SEED_GATE_FAILED` → the seeder is broken; debug M1-T2.
- If `FIXTURE_NOT_SYNCED` → the combined container's sync did not pull the fixture; debug M2-T1 (decrypt block may have run before sync, or sync may not have completed).
- If the symptom assertion fails → the fix is incomplete; debug M2-T1 (decrypt not running), ~~M2-T2 (server still serving ciphertext),~~ or M2-T3 (verification gate misfiring). **[2026-10-03: M2-T2 struck out — descoped. T2-free replacement debug target: if the Data API serves ciphertext, that indicates the Spike-1 re-read assumption regressing — see `plans/backlog.md` §5 F6.]**

### Step 3: anti-vacuous-pass verification

**Sub-step 3a (SEED_GATE_FAILED fires when seed is broken):** run with the seeder disabled. Easiest method: in `docker-compose.test.yml`, temporarily comment out the `joplin-e2ee-seed` service or set its `entrypoint` to a no-op:
```yaml
joplin-e2ee-seed:
  ...existing...
  entrypoint: ['true']  # no-op; seeder does not actually create the fixture
```

Run:
```bash
docker compose -f docker-compose.test.yml down -v --remove-orphans 2>/dev/null
RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh
```

**Expected:** exit non-zero with `SEED_GATE_FAILED: no encrypted fixture on server` (or `SEED_GATE_FAILED: seeder volume not found` if the volume was not created).

Revert the temporary change to `docker-compose.test.yml` after the test.

**Sub-step 3b (FIXTURE_NOT_SYNCED fires when sync doesn't pull the fixture):** run with a non-reachable server. Method: set `JOPLIN_SERVER_URL` to a non-existent host:
```bash
JOPLIN_SERVER_URL=http://nonexistent.example.invalid:1 RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh
```

**Expected:** exit non-zero with `FIXTURE_NOT_SYNCED: seeded notebook 'EncryptedNotebook' absent from list_notebooks` (because sync fails → no items on the combined container → list_notebooks is empty or returns only system rows).

**Sub-step 3c (default CI still green):** run without the gate:
```bash
bash scripts/run-integration-tests.sh
```

**Expected:** exit 0; existing test suite green; E2EE repro skipped (the `describeIfE2EE` block).

### Step 4: README "Resolved" conversion

> **[2026-10-03: RE-SCOPED AND EXTENDED (user-approved D2; `plans/backlog.md`
> §3 D2, §6 E1).** Beyond the "Known gap" → "Resolved" conversion below, this
> step now covers ALL stale README claims found as of 2026-10-03: the "fails
> on the current container code" claims at `README.md:254` and `README.md:268`;
> the "does not trigger decryption" / "wait for the M2 fix" text at
> `README.md:274`; and the pre-M2 boot-sequence list at `README.md:662-671`
> (shows the Data API before the initial sync and omits the decrypt step
> entirely). The `README.md:104` "startup reorder" promise inside the
> Known-gap section is also dropped from the replacement wording — M2-T2 was
> descoped. The conversion itself happens at M2-T4 execution time; do not
> edit the README now.]**

> **[2026-10-04: EXECUTED.** Step 4's README conversion was carried out by the
> documentation batch on 2026-10-04 (user-directed; backlog §6 E1 resolved): the
> "Known gap" subsection (pre-edit `README.md:90-104`) is now the T2-free
> "Resolved" subsection, and the other targets named in the re-scope note above
> are converted — the "fails on the current container code" claims (pre-edit
> `README.md:254` / `:268`), the "does not trigger decryption" / "wait for the
> M2 fix" text (pre-edit `README.md:274`), and the boot-sequence list (pre-edit
> `README.md:662-671`, rewritten to the real order). README line numbers are
> pre-edit; the conversion shifts them. Residual M2-T4 scope: Steps 1, 3, and 5.]**

In `README.md`, replace M1-T6's `### Known gap: encrypted titles served as-is via list_notebooks (issue #29)` subsection (the blockquote + workarounds) with:

```markdown
### Resolved: encrypted titles served as-is via `list_notebooks` (issue #29)

> **✅ Resolved in M2.** The combined container now runs `joplin e2ee
> decrypt` after the initial sync (with bounded retries for master-key
> propagation timing), verifies zero items remain encrypted before
> starting the periodic sync loop, and serves plaintext titles via
> `list_notebooks` — the Data API picks up the post-decrypt state without
> a restart (the re-read behavior observed in the GREEN repro run;
> recorded as an inference in `plans/backlog.md` §2 R6). A container
> integration test (`tests/container/e2ee-encrypted-titles-repro.test.ts`,
> gated by `RUN_E2EE_REPRO_TESTS=1`) reproduces the original bug and now
> passes.
>
> See the M2 fix-design plans (`plans/_finished/M2-T1-initial-sync-decrypt-and-verify.md`,
> `plans/_finished/M2-T2-server-start-reorder.md`, `plans/M2-T3-sync-detection-and-healthcheck-hardening.md`,
> `plans/M2-T4-flip-to-green-verification-and-docs.md`) and the M1 repro-test plans (`plans/_finished/M1-T1..T6`)
> repro test. The repro is opt-in (CI `workflow_dispatch` with input
> `run_e2ee_repro_tests: true`); default CI is unaffected.
```

**[2026-10-03: the draft above was reworded T2-free — the original clause "and starts the Data API *after* the decrypt step so it serves plaintext" described the descoped M2-T2 reorder and was dropped per D2.]**

**Expected outcome of this step (checked at execution time):**
- The "Known gap" subsection (`README.md:90-104`) is replaced by the "Resolved" subsection; `:104`'s "startup reorder" promise disappears with it.
- No remaining "Known gap", "fails on the current container code" (`README.md:254`, `:268`), "does not trigger decryption", or "wait for the M2 fix" (`README.md:274`) claims in the touched sections.
- The boot-sequence list (`README.md:662-671`) matches the real order: master password config → Data API start (unchanged early position) → initial sync → `joplin e2ee decrypt` with bounded retries → zero-encrypted-items verification → periodic sync loop → MCP start last; no reorder claim.

### Step 5: diff summary

After all of the above, run:
```bash
git diff --stat
```

**Expected diff:**
- `entrypoint-combined.sh` — M2-T1 + M2-T2 + M2-T3 changes (~+50 / ~-10). **[2026-10-03: corrected — M2-T1 + M2-T3 changes only, no M2-T2 (descoped); the uncommitted D3 master-key preflight is a separate change outside M2-T4's accounting.]**
- `Dockerfile.combined` — M2-T3 healthcheck (~+5 / ~-2).
- `docker-compose.test.yml` — M1-T1 (~+40 / ~-2).
- `tests/container/fixtures/e2ee-seed.sh` — M1-T2 (new file, ~+70).
- `tests/container/e2ee-encrypted-titles-repro.test.ts` — M1-T3 (new file, ~+150).
- `scripts/run-integration-tests.sh` — M1-T4 additive on M11 baseline (~+30 / ~-0).
- `.github/workflows/integration-tests.yml` — M1-T5 additive (~+20 / ~-0).
- `README.md` — M1-T6 (new testing section + E2EE correction) + M2-T4 ("Known gap" → "Resolved") (~+40 / ~-20).
- NO changes to `tests/integration-runner-config.test.ts` (M11 baseline preserved).
- NO changes to `tests/test-*.sh` (M2-T3's pattern expansion is verified to not break them; documented in M2-T3's verification step 5).
- NO changes to `src/`.

## 6. Acceptance criteria

- `git diff tests/container/e2ee-encrypted-titles-repro.test.ts` → empty.
- Step 2: **already satisfied** — the repro went GREEN during the M2-T1 run (2026-10-03; decision rule `plans/_finished/M2-T1-initial-sync-decrypt-and-verify.md:158`; outcome in `plans/backlog.md` §1); if re-run as an optional re-confirmation, exit 0.
- Step 3a: exit non-zero; `SEED_GATE_FAILED` fires. (unchanged)
- Step 3b: exit non-zero; `FIXTURE_NOT_SYNCED` fires. (unchanged)
- Step 3c: exit 0; default suite green. (unchanged)
- Step 4 (re-scoped 2026-10-03): README conversion complete per the extended list — the "Resolved" subsection present (not "Known gap"), and none of the stale claim classes remain in the touched sections: no "fails on the current container code" (`README.md:254`, `:268`), no "does not trigger decryption" / "wait for the M2 fix" (`README.md:274`); the boot-sequence list (`README.md:662-671`) matches the real order.
- Step 5: diff stat matches the corrected list — `entrypoint-combined.sh` shows M2-T1 + M2-T3 changes (no M2-T2; the uncommitted D3 preflight is outside M2-T4's accounting).
- All files listed in Step 5 show in `git diff --stat`; no other files show.

## 7. Verification commands

(Same as Step 1–5 above; commands are repeated in the canonical order.)

1. `git diff tests/container/e2ee-encrypted-titles-repro.test.ts` → empty.
2. `docker compose -f docker-compose.test.yml down -v --remove-orphans 2>/dev/null && RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh` → exit 0. **[2026-10-03: already satisfied during the M2-T1 run; re-run is optional re-confirmation.]**
3a. (After temporary seeder disable + revert) → exit non-zero with `SEED_GATE_FAILED`.
3b. (After `JOPLIN_SERVER_URL=http://nonexistent.example.invalid:1`) → exit non-zero with `FIXTURE_NOT_SYNCED`.
3c. `bash scripts/run-integration-tests.sh` → exit 0; existing suite green.
4. `grep -n 'Resolved in M2' README.md` → at least 1 match.
5. `git diff --stat` → expected list above.

## 8. Risks / gotchas

- **Risk 1: M1-T3 GREEN is a real signal ONLY if the seed surface is real.** If a regression in M1-T2 (e.g. seeder silently no-ops due to a permissions issue) makes the seed unencrypted, the M1-T3 mechanism-validation gate (`SEED_GATE_FAILED`) fires. The flip-to-green therefore depends on the seed being correctly encrypted. **Mitigation:** Step 3a explicitly verifies the gate still fires when the seed is broken; if it does, the gate is functioning. **No further mitigation needed.**
- **Risk 2: Timing-dependent flakes.** The repro test has bounded 90s polling for the symptom; on a slow CI runner, this can be tight. **Mitigation:** if the test flakes in CI, increase the per-test timeout in M1-T3 from 180s to 300s.
- **Risk 3: README "Resolved" wording drift.** The "Resolved" subsection says "M2" without specifying the milestone file. If M3 etc. land later, the wording remains accurate (M2 fixed this specific bug; M3 may add related work). **No mitigation needed.**
- **Risk 4: docker-compose.test.yml profile-gate composition.** Step 3a's "comment out the seeder" temporary change is a manual edit; if forgotten, subsequent test runs in the same session are broken. **Mitigation:** the verification command sequence in §7 includes "revert the temporary change" as an explicit step; document in the plan execution notes.
- **Risk 5: CHANGELOG.md gap.** The user's request did not ask for changelog updates; the release process owns it. M2-T4 does NOT add a changelog entry. If a follow-up issue is filed, the changelog is updated as part of the release. **Out of scope.**

## 9. Research spikes assigned

- (None — M2-T4 is verification only; no new behavior to research.)

## 10. Handoff note

After M2-T4: M1 + M2 are fully shipped. GitHub issue #29 is resolved. The combined container now:
1. Configures the master password declaratively (existing, `:306-309`).
2. Starts the Data API (existing early position — before the initial sync; unchanged).
3. Runs the initial sync (existing, `:443`).
4. Runs `joplin e2ee decrypt` (M2-T1) with bounded retries for master-key propagation timing.
5. Verifies zero items remain encrypted (M2-T1 + M2-T3 redundant check); the Data API then serves plaintext without a restart (the Spike-1 re-read behavior — inference; `plans/backlog.md` §2 R6).
6. Tightens sync error detection (M2-T3) to catch DecryptionWorker failures.
7. Exposes E2EE state in the healthcheck (M2-T3) so a regression in decrypt surfaces via Docker health.
8. Starts the MCP server last (existing position, after the sync region).

**[2026-10-03: list reordered to the real boot sequence; the old item 5 — "Starts the Data API (M2-T2 reorder) so it serves plaintext" — claimed the descoped reorder; no reorder happens.]**

The repro test (`tests/container/e2ee-encrypted-titles-repro.test.ts`) catches regressions in any of steps 3-7: if any step regresses, the test goes RED.

The fix is **opt-in verified** (the repro test is gated by `RUN_E2EE_REPRO_TESTS=1` and a manual `workflow_dispatch` input), so default CI is unaffected.

**Next steps for the maintainer:**
- File a GitHub issue referencing #29 + the M1+M2 plan files; mark as closed.
- Add a CHANGELOG entry as part of the next release.
- Consider (out of scope) periodic-decrypt in the periodic loop as a future hardening; see `plans/M2-T3` Risk #5 for the rationale.
- Consider (out of scope) a Node-side `/health/e2ee` endpoint to replace the shell-side probe in `Dockerfile.combined`; see `plans/M2-T3` Risk #3.

## Non-goals

- No changes to `tests/container/e2ee-encrypted-titles-repro.test.ts`.
- No changes to M2-T1/T2/T3 source code (verification only). **[2026-10-03: T2 descoped — read as M2-T1/T3.]**
- No CHANGELOG.md changes.
- No commit creation (the user has not asked for commits; the dispatch is to a coding agent that handles commits).
