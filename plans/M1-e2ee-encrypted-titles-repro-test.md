# M1 — E2EE Encrypted Titles Reproduction Integration Test (INDEX)

> **Status:** Plan-only milestone. **Reproduces GitHub issue #29 — does NOT fix it.**
> Companion fix lives in this same split effort as **M2** (scope A + B2 + C,
> defined below). This file is the **index/overview**: detail has moved into
> the per-subtask files `M1-T1..T6` and `M2-T1..T4`. Implementers start each
> subtask in a fresh session from its own file.

> **Naming note.** The repo already has milestone files in `plans/_finished/`
> with `M1` / `M2` slugs (sqlite-busy work). Number reuse is a known
> ambiguity; this work deliberately adopts the same M1/M2 convention per
> the user's request, and is distinguishable by the `-e2ee-encrypted-titles`
> suffix and the `-T<k>` subtask pattern.

## Goal

Add a container integration test that deterministically reproduces GitHub
issue #29: with `JOPLIN_MASTER_PASSWORD` set and E2EE enabled on a real
Joplin Server, `list_notebooks` returns notebooks with empty `title` fields
(or `encryption_applied=1` with non-empty `encryption_cipher_text`) even
though the master password is "configured". The test **asserts the SAFE
behavior** (non-empty plaintext titles, no remaining encrypted blobs) and
therefore **FAILS on current container code**, proving the bug exists,
and flips to PASS once a fix lands — with **zero assertion edits**.

## User decisions (RESOLVED — do not re-open)

| #   | Decision                                                                                                                                                        | Where implemented                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | **Fix scope: A + B2 + C** (robust). B1 (server restart) and B3 (periodic decrypt worker) **REJECTED**. Effort baseline: ~11.5 h (~1.5 days) + ~1.5 h research spikes.   | M2-T1 (A), M2-T2 (B2), M2-T3 (C) |
| 2   | **Joplin Server image: float `joplin/server:latest`** (no tag pinning). Drift accepted; monitor in gated opt-in job; fix fixtures/test if drift surfaces, do not pin. | M1-T1                            |
| 3   | **CI cost: opt-in `workflow_dispatch`-only**. Default PR CI untouched. Mirror the `sqlite-busy-repro` job (`run_sync_lock_tests` input).                                  | M1-T5                            |

**Considered-and-rejected (B1, B3):** B1 (restart `joplin server start` after
decrypt) costs ~2s of downtime and drops any in-flight MCP request —
unacceptable. B3 (a periodic decrypt worker inside the running server) is
the most complex (+6h), may still hit the API's process-local caching
(ties to Gap 1 below), and offers no benefit over B2's cleaner reorder.

**Considered-and-rejected (Joplin Server tag pinning):** Pinning ties us to
upstream changes; the repro test is opt-in (`RUN_E2EE_REPRO_TESTS=1`) so
upstream drift surfaces only in the gated `workflow_dispatch` job — and
when it breaks there, we fix the fixture/test, not the tag. Monitor:
when the gated job fails on a clean re-run with `RUN_E2EE_REPRO_TESTS=1`,
inspect the failure, decide whether it's a transient infra change or a real
regression, and respond by editing the seeder/test (M1-T1/M1-T2/M1-T3) —
not by pinning the image.

## Background — issue #29 symptom and excerpts

GitHub issue #29 reports that the combined container
(`ghcr.io/gelse/joplin-mcp:latest`) serves E2EE-encrypted notebook titles
as-is via `list_notebooks` despite `JOPLIN_MASTER_PASSWORD` being set. The
reporter had to manually run `joplin e2ee decrypt` (which first failed:
*"DecryptionWorker: cannot start because no master key is currently
loaded"*) before titles populated — at which point 204 items were
decrypted, the API still served plaintext without restart, and only then
did `list_notebooks` work.

**Why every subtask file carries these excerpts itself:** issue #29 is NOT
vendored in any other location in the repo, and each subtask is implemented
in a separate session that loads no other reference. Every subtask file
therefore carries the full set of symptom excerpts in its own "Full
problem context" section so a fresh agent with no memory can understand
what is being verified or fixed.

## Investigation evidence (authoritative — see subtask files for the FULL set of excerpts and file:line references)

- **Master password is set only declaratively.** `entrypoint-combined.sh:306-309` is the *only* master-password code: `joplin config encryption.masterPassword "${JOPLIN_MASTER_PASSWORD}"`. No `e2ee decrypt`, no master-key load, no verification. `JOPLIN_MASTER_PASSWORD` does not appear anywhere in `src/` (`src/config.ts:5-44`).
- **Startup order (`entrypoint-combined.sh`):** 1. sync.target config (`:294-297`); 2. master password (`:306-309`); 3. `nohup joplin server start &` (`:333-335`) — Data API as long-running process; 4. curl health-wait (`:347-367`); 5. api.token extraction (`:384-413`); 6. `flock ... -c 'joplin sync'` initial sync (`:443`); 7. `node /app/dist/mcp/entry.js &` MCP server (`:576`); 8. "joplin combined container is ready" (`:585`).
- **Data API is a separate, *earlier-started* process** — started before any master key could possibly exist on a fresh volume. Long-running; never restarted after initial sync. Mirrors the documented FTS limitation (`README.md:351`; upstream `laurent22/joplin#11631`).
- **Sync is shell `flock -w 120 -c 'joplin sync'`.** Initial (`:443`), periodic (`:523`), shutdown (`:677`). Detection `check_sync_errors()` (`:71-110`) pattern-matches "Master key is not loaded" — **NOT** the actual DecryptionWorker wording ("no master key is currently loaded"). Blind spot confirmed: `grep "currently loaded|DecryptionWorker" entrypoint src tests` → zero hits.
- **Per-CLI-process master-key loading.** Confirmed in `reports/container/joplin-mcp.log:38,42-43,50-51`: `"e2ee/utils: Trying to load 0 master keys... Loaded master keys: 0"`. Each fresh `joplin` invocation loads keys from config on its own; running `joplin server start` (the Data API) before sync means it never sees the keys.
- **No `e2ee decrypt` anywhere in the executable path.** No DecryptionWorker trigger, no post-sync decryption wait, no verification. README's E2EE section (`README.md:86-88`) covers the upload side only and says "current session only" — but no session ever decrypts.
- **`list_notebooks` plumbing** (`src/mcp/tools.ts:45-47`) → `ctx.client.getAllFolders()` → `src/data-client.ts:479-482` `GET /folders?limit=100&page=N` → no field restriction, no local decryption → empty `title` surfaces verbatim. Folder shape (`src/api-types.ts:37-51`) carries `encryption_cipher_text` / `encryption_applied`; never inspected. **Correction note vs. source plan:** the original source plan cited `src/api-types.ts:42-56`; the corrected locations are `:37-51` (interface), with `encryption_cipher_text` at `:45` and `encryption_applied` at `:46`.
- **Test infra constraints.** `docker-compose.test.yml:8-11` points at a **dummy** URL `https://dummy-joplin-server.example.com` — no real Joplin Server in the test stack. Closest real-server harness is `scripts/measure-initial-sync.sh`.
- **Healthcheck is encryption-agnostic** (`Dockerfile.combined:86-87`).
- **CLI whitelist excludes `e2ee`** (`src/cli-executor.ts:27-49`). Combined container never calls Node CLI anyway (`src/mcp/entry.ts:50-55`).

## Root-cause table

| #   | Candidate                                                                                                                                                                                                                                                                                                              | File:line                                                | Confidence   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------ |
| A   | No `joplin e2ee decrypt` step runs after initial sync. Entrypoint only stores password + runs `joplin sync`; never triggers the DecryptionWorker; never waits for decrypt to complete; never verifies. Reporter's manual `e2ee decrypt` (204 items persisted as plaintext to the shared SQLite) is exactly the missing step. | `entrypoint-combined.sh:306-309, :443`                     | **Highest**      |
| B   | Data API (`joplin server start`) was started before any master key ever existed. Long-running; never restarted. Even after A runs and decrypts the DB, the API may still serve ciphertext because it cached no master key. Mirrors FTS limitation.                                                                       | `entrypoint-combined.sh:333-335`; no restart after `:443`    | **High**         |
| C   | Detection blind spot + encryption-agnostic healthcheck. `check_sync_errors` misses DecryptionWorker wording; no post-sync "items still encrypted" check; `/health` probe is content-agnostic. Lets the bug ship silently.                                                                                                  | `entrypoint-combined.sh:71-110`; `Dockerfile.combined:86-87` | Contributing |

**Fix shapes (chosen scope A + B2 + C):** A = insert `joplin e2ee decrypt` after `:443` sync + wait/verify (gate fails on `encryption_applied > 0`); B2 = reorder so server start (`:333-335`) happens AFTER sync+decrypt block; C = tighten `combined_pattern` (add `no master key is currently loaded|DecryptionWorker`), add post-sync encrypted-item check, E2EE-aware healthcheck (Dockerfile.combined shell `HEALTHCHECK` that runs `joplin ls -l | grep -c '\[Encrypted\]'` and fails above 0).

## Known information gaps (owned by subtasks)

1. Does `joplin server start` re-read/decrypt-on-read the SQLite DB after an out-of-process `e2ee decrypt`? → owned by **M2-T2** (spike + restart escape hatch).
2. Does `joplin config encryption.masterPassword` trigger the DecryptionWorker in-process? → owned by **M2-T1**.
3. Does the Joplin Server REST API expose `encryption_applied`? → owned by **M1-T1** (fallback: seeder marker file).
4. Master-key propagation timing on first sync → owned by **M1-T3** (polling) and **M2-T1** (retry semantics).

## Recreatability / test-design constraints

(Detail in **M1-T3**; summary here.)

- **Required env:** real Joplin Server (`joplin/server:latest`) with E2EE enabled + account matching `JOPLIN_USERNAME`/`JOPLIN_PASSWORD`; ≥1 notebook + ≥1 note encrypted with known master password ON THE SERVER before combined container syncs; combined container with `JOPLIN_SERVER_URL`/`USERNAME`/`PASSWORD`/`MASTER_PASSWORD` + fresh `joplin_data` volume; MCP client via existing `tests/container/helpers.ts`.
- **Seeding strategy chosen** — one-shot seed container running `joplin` CLI against the same server (`e2ee enable` + master password + create encrypted items + sync + exit). Pre-baked SQLite rejected (brittle across joplin versions); local-profile-only rejected (bug is about download).
- **Determinism:** sync 5–30s variance → poll bounded 90s; decrypt lags sync (reporter observed) → poll the SYMPTOM, not log lines.
- **Two anti-vacuous-pass gates** (defined in M1-T3): `SEED_GATE_FAILED: no encrypted fixture on server`; `FIXTURE_NOT_SYNCED: seeded notebook absent from list_notebooks`. Both run BEFORE any symptom assertion and are themselves **never** the GREEN flip — the symptom assertion is.
- **Gating precedent:** `tests/container/sqlite-busy-repro.test.ts:23-26` — `const RUN_SYNC_LOCK_TESTS = process.env['RUN_SYNC_LOCK_TESTS'] === '1'; describeIfSyncLock = ... ? describe : describe.skip`. Use `RUN_E2EE_REPRO_TESTS` for M1-T3.
- **`docker compose down -v`** between runs.
- **Vitest** (`vitest.config.container.ts`): auto-includes `tests/container/**/*.test.ts`, serial execution, 30s default timeouts — M1-T3 likely needs a per-test timeout bump for the new suite.

## M2 scope (defined here, detailed in M2-T1..T4)

| Subtask | Scope                                                                                    | Touches                                                                                     | Depends on   |
| ------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------ |
| **M2-T1**   | A — post-sync `joplin e2ee decrypt` + verification gate                                    | `entrypoint-combined.sh` (inserts `joplin e2ee decrypt` + verification in the initial-sync success branch, after `check_sync_errors "Initial"`, ~`:474`; overrides `START_PERIODIC_LOOP` to 0 fail-closed on failure) | M1 done      |
| **M2-T2**   | B2 — startup reorder so `joplin server start` follows sync+decrypt                         | `entrypoint-combined.sh` (move `:330-426` block)                                                | M2-T1        |
| **M2-T3**   | C — tighten `combined_pattern`, add post-sync encrypted-item check, E2EE-aware `HEALTHCHECK` | `entrypoint-combined.sh`, `Dockerfile.combined`                                                 | M2-T1        |
| **M2-T4**   | Flip-to-green verification + README correction                                           | (no source changes beyond M2-T3's docs cross-link); re-runs M1-T3 with zero assertion edits | M2-T2, M2-T3 |

**Ordering rationale (M2-T1 → M2-T2 → M2-T3 → M2-T4):**
- **T1 first, T2 second.** T1 inserts one step in the initial-sync success branch (after `check_sync_errors "Initial"`, ~`:474`; a single anchor). T2 then relocates a separate block (`:330-426`, api-port + server-start + health-wait + token-extract + server-probe) to after the now-extended sync region. Doing T1 first means T2's relocation does not have to thread through a freshly inserted decrypt step — cleaner diffs. (Final layout is correct regardless of order; T1-first minimises merge risk.)
- **T3 independent of T2 in placement.** T3's entrypoint edits (`:74` pattern, post-sync check) live in different regions from T2. T3 also touches `Dockerfile.combined`. T3 may be merged in any order relative to T2 but MUST land before T4.
- **T4 last.** T4 is verification only: run M1-T3, expect PASS, no assertion edits. After T4 the M1 milestone is effectively closed.

## Tasks (per-subtask files)

| Subtask | File                                                    | What it delivers                                                                       |
| ------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| M1-T1   | `plans/M1-T1-test-stack-real-server-and-seed.md`          | Real Joplin Server + one-shot seed container in `docker-compose.test.yml`, profile-gated |
| M1-T2   | `plans/M1-T2-e2ee-seed-fixture-script.md`                 | `tests/container/fixtures/e2ee-seed.sh`                                                  |
| M1-T3   | `plans/M1-T3-e2ee-encrypted-titles-repro-test.md`         | `tests/container/e2ee-encrypted-titles-repro.test.ts` with two anti-vacuous gates        |
| M1-T4   | `plans/M1-T4-runner-script-pass-through.md`               | `scripts/run-integration-tests.sh` pass-through (additive on M11's uncommitted baseline) |
| M1-T5   | `plans/M1-T5-ci-wiring-e2ee-repro-job.md`                 | `.github/workflows/integration-tests.yml` opt-in job                                     |
| M1-T6   | `plans/M1-T6-readme-documentation.md`                     | `README.md` section + E2EE section correction                                            |
| M2-T1   | `plans/M2-T1-initial-sync-decrypt-and-verify.md`          | A — post-sync `joplin e2ee decrypt` + verification                                       |
| M2-T2   | `plans/M2-T2-server-start-reorder.md`                     | B2 — startup reorder                                                                   |
| M2-T3   | `plans/M2-T3-sync-detection-and-healthcheck-hardening.md` | C — sync error detection + E2EE-aware healthcheck                                      |
| M2-T4   | `plans/M2-T4-flip-to-green-verification-and-docs.md`      | Flip-to-green + docs                                                                   |

## Effort estimation (unchanged from source plan — carry forward verbatim)

> Hours are engineering hours for an experienced contributor familiar with
> the repo. Day conversions assume an 8 h day rounded to the nearest
> half-day.

#### Minimal fix (A only — stop short of robust)

| Sub-fix                                                                                | Hours  | Notes                                                    |
| -------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| Add `joplin e2ee decrypt` after initial sync; wait for completion                        | 2      | Bash in entrypoint; idempotent; bounded retry            |
| Verify (add `encryption_applied === 0` post-decrypt check, fail loudly otherwise)        | 1      | New pattern in `check_sync_errors` or new `check_e2ee_state` |
| Tests (flip RED→GREEN — **no assertion edits**; optional stricter post-M2 tightening only) | 1      | The M1 repro test flips unmodified                       |
| Docs (README correction)                                                               | 0.5    |                                                          |
| **Minimal subtotal**                                                                       | **~4.5 h** | **≈ 0.5 day**                                                |

Caveat: **may not actually fix the symptom** if B is the true blocker (the Data
API serves stale rows). A-only fix would likely leave the user-facing bug
in place; the new M1 test would still fail.

#### Robust fix (A + B2 + C) — chosen scope

| Sub-fix | Hours | Notes |
|---|---|---|
| A: post-sync decrypt + verify | 3.5 | |
| B2: change startup order so `server start` runs *after* initial sync+decrypt | +3 | Cleaner; ~5–15s cold-start delay added to first boot. Requires reordering `:333-335` after `:443` and the decrypt step. |
| C: tighten sync error detection; add `encryption_applied === 0` post-decrypt gate; E2EE-aware healthcheck | +3 | Pattern updates in `check_sync_errors`; new healthcheck probe (`HEALTHCHECK` in `Dockerfile.combined` runs `joplin ls -l \| grep -c '\[Encrypted\]'` and fails above 0). |
| Tests: flip verification (no assertion edits) + CI gate | +1 | |
| Docs | +1 | |
| **A + B2 + C subtotal** | **~11.5 h** | **≈ 1.5 days** |

#### Untested / research spikes (~1.5h total)

- Confirm `joplin server start` behavior post-`e2ee decrypt` (B's actual answer). **~1 h** of investigation. Could downgrade B to A-only or require an in-place restart. → **Assigned to M2-T2.**
- Confirm `joplin config encryption.masterPassword` triggers DecryptionWorker in-process. (Strongly implied: no.) **~30 min** to verify. → **Assigned to M2-T1.**
- Confirm `joplin e2ee decrypt` reads master password from existing `joplin config encryption.masterPassword` (no `-p` flag needed). **~15 min**. → **Assigned to M2-T1.**
- Confirm `joplin ls -l` output marker for encrypted items (`[Encrypted]`) and `joplin status` E2EE block. **~15 min**. → **Assigned to M2-T3.**
- Confirm whether the Joplin Server REST API exposes `encryption_applied` for the seed-time gate probe. **~15 min**. → **Assigned to M1-T1.**

## Non-goals

- **No fix in M1.** M1 is verification only; the fix lives in M2.
- **No change to entrypoint behavior** beyond what the test stack requires (M1-T1 may add a profile-gated seed container; the combined container's own startup behavior is not modified by M1).
- **No patching of upstream Joplin CLI.**
- **No CI-on-every-push** for this test (heavy infra; opt-in only via `RUN_E2EE_REPRO_TESTS` / `workflow_dispatch` input).
- **No coverage of the upload-only E2EE path** (reporter's bug is about *download* of encrypted titles).
- **No tag pinning** for `joplin/server:latest` (Decision 2; drift is monitored, not pinned).

## Cause investigation + effort estimation

(Carried verbatim from the source plan; preserved for posterity. See
"Effort estimation" above for the chosen A + B2 + C total of ~11.5 h
plus ~1.5 h research spikes.)

## Review verdict

**APPROVED** — produced via architecture workflow (investigator → plan). Nested review-plan: the plan drafts were reviewed for spec compliance; findings addressed in revision. Post-write verification: see subtask files.
