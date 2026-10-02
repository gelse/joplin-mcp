# M1-T5 — CI wiring: opt-in `workflow_dispatch` job for E2EE repro

> Subtask of **M1 — E2EE Encrypted Titles Reproduction Integration Test**.
> Belongs to the verification milestone (M1). Implementation starts in a
> fresh session from this file alone.

## 1. Header

- **Subtask ID:** M1-T5
- **Milestone:** M1
- **Dependencies (other subtask IDs):** M1-T4 (runner pass-through), M1-T3 (test file).
- **What it delivers:** A new `workflow_dispatch` boolean input `run_e2ee_repro_tests` on `.github/workflows/integration-tests.yml`; a new opt-in job `e2ee-encrypted-titles-repro` mirroring `sqlite-busy-repro`. Default CI untouched.

## 2. Full problem context

GitHub issue #29 reports E2EE-encrypted notebook titles served as-is via `list_notebooks` despite `JOPLIN_MASTER_PASSWORD` set. The reporter saw `SYNC_PASS` despite encrypted state, and a manual `joplin e2ee decrypt` that first failed ("DecryptionWorker: cannot start because no master key is currently loaded") before succeeding — **204 items** decrypted, plaintext served without server restart. **The CI test requires a real Joplin Server** (`joplin/server:latest`) reachable from the test container, with E2EE enabled; this is heavy (the test stack pulls a Postgres-backed server, plus the seed container pulls the combined image, plus the test-runner pulls the test image). Default CI runs on every PR and must not regress in build time or infra cost; the heavy E2EE repro must be opt-in only.

Decision 3 in the index: opt-in `workflow_dispatch`-only; default CI untouched.

## 3. Authoritative investigation evidence (with file:line)

- **.github/workflows/integration-tests.yml:1-72 (full file)** — name `Integration Tests`; triggers `pull_request: [main, testing]` + `workflow_dispatch` with one boolean input `run_sync_lock_tests`; two jobs: `integration-tests` (PR+dispatch, 20min, runs `bash scripts/run-integration-tests.sh`) and `sqlite-busy-repro` (`:53-72` — `if: github.event_name == 'workflow_dispatch' && github.event.inputs.run_sync_lock_tests == 'true'`, runs-on ubuntu-latest, 10min, sets `RUN_SYNC_LOCK_TESTS: '1'`, collects logs, tears down with `down -v --remove-orphans`).
- **.github/workflows/integration-tests.yml:6-9** — note in the existing job explaining why the sqlite-busy-repro is gated: mounts the host Docker socket → root-equivalent credential over the host daemon. The e2ee-encrypted-titles-repro does NOT mount the Docker socket (the test runs `list_notebooks` via MCP, no `docker exec`), so the gating rationale differs — gated for **cost** (real Joplin Server image, seed container, ~10min run) rather than security. The note text may be slightly broadened.

## 4. Scope

**Files to modify:**
- `.github/workflows/integration-tests.yml` (additive — new input + new job).

**Files NOT to touch:**
- `scripts/run-integration-tests.sh` (M1-T4).
- `docker-compose.test.yml` (M1-T1).
- Other workflows.

## 5. Exact behavior required

### Modify `workflow_dispatch.inputs`

Replace the current `workflow_dispatch` block (lines 10-16) with:

```yaml
workflow_dispatch:
  inputs:
    run_sync_lock_tests:
      description: 'Run SQLITE_BUSY destructive migration repro test (issue #27)'
      required: false
      default: false
      type: boolean
    run_e2ee_repro_tests:
      description: 'Run E2EE encrypted-titles reproduction test (issue #29; pulls joplin/server:latest + seed)'
      required: false
      default: false
      type: boolean
```

### Add new opt-in job

After the `sqlite-busy-repro` job (after line 72), add:

```yaml
  # Reproduces GitHub issue #29: with JOPLIN_MASTER_PASSWORD set and E2EE
  # enabled on a real Joplin Server, list_notebooks returns encrypted
  # ciphertext. Manually triggered only — pulls a real Joplin Server
  # (joplin/server:latest), runs the seed, and exercises the MCP path.
  # Gated for cost (~10 min, three image pulls). Does NOT run on every PR.
  e2ee-encrypted-titles-repro:
    if: github.event_name == 'workflow_dispatch' && github.event.inputs.run_e2ee_repro_tests == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 20

    steps:
      - uses: actions/checkout@v4

      - name: Run E2EE encrypted-titles repro test
        run: bash scripts/run-integration-tests.sh
        env:
          RUN_E2EE_REPRO_TESTS: '1'

      - name: Collect container logs
        if: always()
        run: docker compose -f docker-compose.test.yml logs joplin-mcp joplin-server joplin-e2ee-seed > reports/container/joplin-mcp.log 2>&1 || true

      - name: Cleanup test stack
        if: always()
        run: docker compose -f docker-compose.test.yml down -v --remove-orphans
```

## 6. Acceptance criteria

- The existing `integration-tests` job runs identically on every PR (no regression).
- The `sqlite-busy-repro` job runs identically when only `run_sync_lock_tests=true` is set (no regression).
- The new `e2ee-encrypted-titles-repro` job runs when `run_e2ee_repro_tests=true` is set on a `workflow_dispatch`.
- Default (`workflow_dispatch` with both inputs false or no input): no new job runs.
- The new job's logs are collected even on failure (`if: always()`).
- The new job tears down even on failure (`if: always()`).

## 7. Verification commands

1. Manual review: `cat .github/workflows/integration-tests.yml` shows the new input and new job.
2. (On a fork or branch with Actions enabled) trigger `workflow_dispatch` with `run_e2ee_repro_tests: true` → new job runs; on current code, exits non-zero with the symptom assertion failure message.
3. PR-only: a PR that does NOT touch this workflow → existing `integration-tests` job runs; new job does NOT run; default CI unaffected.

## 8. Risks / gotchas

- **GitHub Actions `if` expression syntax** — `github.event.inputs.run_e2ee_repro_tests == 'true'` matches the existing precedent (line 54). Do NOT use truthy checks (`if: github.event.inputs.run_e2ee_repro_tests`) — these are evaluated as strings and the boolean input is rendered as `"true"`/`"false"`.
- **Timeout 20min** matches the `integration-tests` job's budget. The repro runs in ~5–10min in practice; 20min absorbs retries.
- **Image pull cost** — the e2ee-repro job pulls `joplin/server:latest` and the seed image. The combined image is already cached (build runs in the workflow step or is pulled from ghcr.io). No action needed.
- **Workflow syntax validation** — Actions treats unknown top-level keys as errors; the YAML above uses only documented keys (`if`, `runs-on`, `timeout-minutes`, `steps`, `uses`, `name`, `run`, `env`, `if`, `with`).

## 9. Research spikes assigned

- (None — pattern mirrors `sqlite-busy-repro` directly.)

## 10. Handoff note

The next subtask is **M1-T6 (README documentation)**, which depends on this and M1-T3 + M1-T4.

After M1-T6: M1 is shipped. The next milestone is **M2-T1..T4 (the fix)** — M2-T4's verification runs M1-T3 with zero assertion edits.

## Non-goals

- No default-CI changes.
- No new triggers (only `workflow_dispatch`).
- No changes to other workflows.
