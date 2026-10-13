# Backlog — live work and closed-item history

> Living backlog for the M1/M2 e2ee effort. This file tracks live work only:
> the open plans and duties in §1–§4, each with its trigger and pointer.
> Everything the 2026-10-08 triage closed is compressed to a one-line
> disposition in §5, so the audit trail survives in place; the full pre-prune
> text is recoverable from git history (pointers in §6). This file is not a
> milestone and does not replace the plan files it cites.

Short form: `M1-index` = `plans/_finished/M1-e2ee-encrypted-titles-repro-test.md`.

**At a glance:** 2 live plans · 2 maintainer actions · 1 standing duty ·
1 grouped dormant-conditionals row (Q10/Q11/Q12, never observed) · 35 closed
lines — 34 closed IDs plus one G1–G12 aggregate line.

## 1. Live plans

| ID | Item | State and what | Pointer |
|----|------|----------------|---------|
| F2 → M13 | Periodic `check_e2ee_state()` in the sync loop | Deferred by M2-T3 Risk 5 (the delivered check runs once at boot, not periodically); now planned. Owner: unowned. | `plans/M13-periodic-e2ee-state-check.md` |
| F3 → M14 | Node-side `/health/e2ee` endpoint | Deferred by both M2-T3 and M2-T4 (M2 excluded `src/`); would replace the shell-side SQLite probe with a real endpoint. Owner: unowned. | `plans/M14-node-health-e2ee-endpoint.md` |

## 2. Maintainer actions

| ID | Item | State and what | Pointer |
|----|------|----------------|---------|
| F4 | M2-T4 maintainer next steps | Trimmed. **Process/bookkeeping only — no implementation remains.** (a) File a GitHub issue referencing #29 + the M1/M2 plan files and mark it closed — still outstanding, but bookkeeping/communication work. (b) CHANGELOG entry at next release — owned by the release process (Risk 5). (c) "Consider future periodic decrypt" — delivered as M13 (§1). | `plans/_finished/M2-T4-flip-to-green-verification-and-docs.md:291-295` |
| F6 | Optional M2-T2 hardening remnant | Drift-triggered only: if the S1 duty ever observes a `joplin/server` image where the repro goes RED, the server-start reorder (or the cold-start restart escape hatch) is the candidate response. This is the ratified residual of the 2026-10-03 M2-T2 drop. Trigger: the S1 duty firing (§3). Owner: unowned. | `plans/_finished/M2-T2-server-start-reorder.md:173` (escape hatch + rationale), `:181` (spike answer); ratified-residual STATUS header `:13` |

## 3. Standing duty (process, not implementation)

| ID | Duty | What and why | Pointer |
|----|------|--------------|---------|
| S1 | Image-drift monitoring | The repro floats `joplin/server:latest` (Decision 2). Act only if the gated opt-in CI job fails on a clean re-run: inspect, decide transient-vs-regression, and respond per the `M1-index:46-53` protocol — the response may include F6 (§2). Kept here rather than in README or a one-duty `docs/` file: the backlog is the single tracking artifact maintainers consult, and F6's trigger lives here. Owner: maintainer, on each gated run. | Decision `M1-index:37`; protocol `:46-53`; drift rationale `plans/_finished/M1-T1-test-stack-real-server-and-seed.md:246` |

## 4. Dormant conditionals (never observed)

**Q10 / Q11 / Q12** — three timing/CI contingencies, none ever observed; act only on the trigger.

- **Q10** — pre-test `joplin sync` warmup, if the repro flakes (master-key propagation timing, gap #4). `plans/_finished/M1-T3-e2ee-encrypted-titles-repro-test.md:349`, `:356`; `M1-index:101`.
- **Q11** — the 180s per-test budget matters only if the test moves into default CI (fine for the opt-in job). `plans/_finished/M1-T3-e2ee-encrypted-titles-repro-test.md:350`.
- **Q12** — bump the per-test timeout 180s → 300s, if the repro flakes. `plans/_finished/M2-T4-flip-to-green-verification-and-docs.md:264`.

## 5. Closed items (2026-10-08 triage)

One line per closed ID: subject — disposition — date — evidence. The full
pre-prune text: `git show HEAD:plans/backlog.md`.

- **§1 verdict (M2-T2 re-evaluation)** — DROP M2-T2 from the M2 critical path; ratified by the user 2026-10-03. Amendment `M1-index:202`; descope STATUS header `plans/_finished/M2-T2-server-start-reorder.md:13`; residual value → F6 (§2).
- **M12** — periodic halt-gate double sleep — RESOLVED 2026-10-08 (deleted the redundant inner `sleep` in the periodic halt gate; a halted loop now idles one interval per cycle and the refusal message repeats once per `SYNC_INTERVAL_SECONDS`, not once per `2 ×`) — gate `entrypoint-combined.sh:888-891`; regression pin `tests/test-sync-failure-diagnostics.sh` Test 10b; plan filed `plans/_finished/M12-periodic-halt-gate-double-sleep.md` (keep-alive discharged).
- **R1** — does `joplin server start` re-read the SQLite DB after out-of-process `e2ee decrypt`? — RESOLVED: YES (M2-T1 run, GREEN; R1/R6 answers backfilled into the plan files 2026-10-03) — decision rule + outcome `plans/_finished/M2-T1-initial-sync-decrypt-and-verify.md:158`.
- **R2** — does `joplin config encryption.masterPassword` trigger the DecryptionWorker? — RESOLVED: NO (M2-T1 run) — answer lives as a code comment, `entrypoint-combined.sh:646-650`.
- **R3** — does `joplin e2ee decrypt` read the config-set master password with no `-p` flag? — RESOLVED: YES (M2-T1 run) — code comment `entrypoint-combined.sh:653-656`.
- **R4** — does `joplin config` trigger the DecryptionWorker? — RESOLVED: NO (same finding as R2) — `entrypoint-combined.sh:646-650`.
- **R5** — does `joplin ls -l` emit an `[Encrypted]` marker? — RESOLVED: NO in joplin 3.7.1, so a grep gate is impossible; the SQLite-probe fallback was implemented instead (probe `entrypoint-combined.sh:791`, run `:810`, integer case `:816-827`) — marker-half answer annotated at `M1-index:180`.
- **R6** — same question as R1 (M2-T2 Spike 1) — RESOLVED: YES — `plans/_finished/M2-T2-server-start-reorder.md:181`.
- **R7** — grep-based verification-gate risks — MOOT (M2-T1 implementation): superseded by the SQLite probe plus case-based integer validation, recorded 2026-10-04 in the M2-T1 Amendment — plan mitigation `plans/_finished/M2-T1-initial-sync-decrypt-and-verify.md:166`; implementation `entrypoint-combined.sh:791-827`; amendment `:193`.
- **D1** — formal descoping of M2-T2 — RESOLVED 2026-10-03 (user ratification, "is ok") — amendment `M1-index:202`; STATUS header `plans/_finished/M2-T2-server-start-reorder.md:13`.
- **D2** — M2-T4 scope and ordering stale — RESOLVED 2026-10-03 (user approval of the re-scope) — RE-SCOPE NOTE `plans/_finished/M2-T4-flip-to-green-verification-and-docs.md:38-47`.
- **D3** — master password set but E2EE fully disabled on the server — RESOLVED 2026-10-04 (implemented as the master-key preflight). **The old row's "UNCOMMITTED" status text was stale: the work is committed** (commit `69818d0`) — `entrypoint-combined.sh:658-735`; `tests/test-e2ee-master-key-preflight.sh`.
- **D4** — halt-marker nomenclature collision — RESOLVED 2026-10-04 (user decision: tag-aware refusals, fixed at every read site) — helpers `entrypoint-combined.sh:81-130`; wired at `:592-593`, `:888-889`, `:937-940`, `:1074-1076`.
- **D5** — M1-T5 gating rationale factually wrong — RESOLVED 2026-10-04 (user decision: "fix the wording, keep the mount"; corrected in place with a dated note) — `plans/_finished/M1-T5-ci-wiring-e2ee-repro-job.md:29`.
- **Q1** — M2-T3 Spike 2: is `joplin` on PATH in the HEALTHCHECK? — RESOLVED 2026-10-05 (M2-T3 implementation; partly mooted by the re-base onto `node`) — commit `451845c`; `plans/_finished/M2-T3-sync-detection-and-healthcheck-hardening.md`.
- **Q2** — M2-T3 Spike 3: do existing shell tests pass with the expanded pattern? — RESOLVED 2026-10-05 (54/54 plus extended harnesses green) — commit `451845c`.
- **Q3** — M2-T3 Change 1: `combined_pattern` expansion — RESOLVED 2026-10-05 (implemented per plan) — commit `451845c`.
- **Q4** — M2-T3 Change 2: `check_e2ee_state()` — RESOLVED 2026-10-05 (implemented on the re-based SQLite-probe design, fail-closed) — commit `451845c`.
- **Q5** — M2-T3 Change 3: E2EE-aware HEALTHCHECK — RESOLVED 2026-10-05 (inline `node -e` probe, fail-closed, verified in-image) — commit `451845c`.
- **Q6** — M2-T3 Risk 1: pattern over-matching — RESOLVED 2026-10-05 (assessed; bare pattern retained; true cost recorded) — commit `451845c`.
- **Q7** — M2-T3 Risk 2: `joplin ls -l -n 99999` performance — MOOT 2026-10-04 (the `ls -l` probe premise was void per R5; superseded by M2-T3 execution) — MOOT annotation in `plans/_finished/M2-T3-sync-detection-and-healthcheck-hardening.md`.
- **Q8** — M2-T3 Risk 3: shell-side healthcheck fragility — RESOLVED 2026-10-05 (re-based design; residual fragility is deliberate fail-closed) — commit `451845c`.
- **Q9** — M2-T3 Risk 4: mirror the probe into `docker-compose.test.yml` — RESOLVED 2026-10-05 (inspected; intentionally not mirrored — the test stack keeps its own healthcheck) — commit `451845c`.
- **Q13** — M2-T4 Risk 4: temporary seeder-disable edit must be reverted — MOOT 2026-10-05 (the M2-T4 execution window closed with the working tree verified clean; superseded by M2-T4 execution) — Risk 4 `plans/_finished/M2-T4-flip-to-green-verification-and-docs.md:266`; §7 order `:255`, `:259`.
- **Q14** — M2-T2 Risk 2: stale `:N-M` citations if the move happens — MOOT 2026-10-03 (T2 was dropped; superseded by the M2-T2 descoping) — `plans/_finished/M2-T2-server-start-reorder.md:174`.
- **Q15** — M2-T4 Step 3b: the `FIXTURE_NOT_SYNCED` gate is unreachable via the documented command — RESOLVED 2026-10-07 (user decision (b): the `E2EE_REPRO_SERVER_URL` override hook, commit `b10c038`) — runner `scripts/run-integration-tests.sh:97`; unit pin `tests/integration-runner-config.test.ts:80-95`; residual note in the M2-T4 filing note (`plans/_finished/M2-T4-flip-to-green-verification-and-docs.md:23-31`).
- **F1** — two review-code suggestions deferred to M2-T3 — RESOLVED 2026-10-05 (both implemented: per-attempt stderr summary `entrypoint-combined.sh:246-249`; `--force` hardening `:750`) — commit `451845c`.
- **F5** — `joplin ls --format=json` as the long-term parser form — **PREMISE FALSIFIED:** the `ls -l`/awk parsing premise is void — the e2ee seeder has been JSON-based since commit `45851e3` (`tests/container/fixtures/e2ee-seed.sh`: JSON-only parsing, `json_item_field()` at `:44`, `joplin ls -f json` at `:99` and `:104`). No work remains and none was ever needed.
- **E1** — M1-T6 README drift — RESOLVED 2026-10-04 (README converted per M2-T4 Step 4) — `README.md:90`, `:265`.
- **E2** — M2-T1 plan-vs-implementation divergences — RESOLVED 2026-10-04 (recorded, plans not rewritten) — dated Amendment `plans/_finished/M2-T1-initial-sync-decrypt-and-verify.md:193`.
- **E3** — M1 master-plan spike list half-stale — RESOLVED 2026-10-04 (all five spike bullets annotated with dated answers) — `M1-index:177-181`.
- **E4** — verify relative plan links — DISCHARGED 2026-10-08: full relative-link enumeration performed during this triage; all README/docs/plans links resolve post-fix; frozen `plans/_finished/` bodies retain historical pre-move path mentions by design (record-not-rewrite) — pose line `plans/_finished/M1-T6-readme-documentation.md:144`.
- **E5** — M1 compose soft-dependency verification never recorded — RESOLVED 2026-10-04 (Compose 5.5.1 ≥ 2.32 recorded) — `plans/_finished/M1-T1-test-stack-real-server-and-seed.md:245`.
- **E6** — M2-T4 Step-1/Step-5 plan commands vacuous on a committed tree — DISCHARGED 2026-10-08: the vacuous commands and the history-proof annotation are recorded in the M2-T4 filing note — `plans/_finished/M2-T4-flip-to-green-verification-and-docs.md:12-21`.
- **G1–G12** — twelve settled decisions/invariants (fix scope, image float, opt-in CI, REST-API answer, seed/runner contracts, CI choices, accepted structural debts) — all settled pre-2026-10-04, do not re-open; the full table is recoverable verbatim from `git show a54f259:plans/backlog.md`.

## 6. Provenance — 2026-10-08 triage

This prune is the closing step of the 2026-10-07/08 backlog triage. The batch
wrote the M13 and M14 plan files for the F2/F3 survivors; filed M2-T3 and
M2-T4 under `plans/_finished/` with dated provenance notes (M2-T4's note also
carries the E6 discharge and the Q15 residual); added a status banner to
`docs/code-review-testing-2026-09-21.md` (nine findings; S6 fixed 2026-10-08 = M12);
updated the README's plan-path references to the `plans/_finished/` paths; and
pruned this file to live work plus one-line closed dispositions.

**Deviation:** the three `plans/triage-*.md` scaffolding files (docs audit,
plans filing, backlog prune) were deleted after their content was salvaged —
not filed under `plans/_finished/` as the scaffolding itself had planned. Their
surviving effects are the items recorded above (E4, E6, the M2-T3/M2-T4
filing, M13/M14) plus this rewrite.

**History retention:** every closed ID keeps one disposition line (§5) so the
audit trail survives in place, while the full pre-prune text stays recoverable
from git history — `git show HEAD:plans/backlog.md` for the pre-triage
version; `git show a54f259:plans/backlog.md` for G1–G12 in full. This keeps
the live file small without destroying evidence.

**Citation caveat:** this repo has a history of `file:line` citation drift
across `entrypoint-combined.sh` edits (cites taken before commit `451845c`
run ~92 lines low). All cites in this file were re-derived against the
current tree on 2026-10-08.
