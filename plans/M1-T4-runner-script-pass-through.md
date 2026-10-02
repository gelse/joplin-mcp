# M1-T4 — Runner-script pass-through for `RUN_E2EE_REPRO_TESTS`

> Subtask of **M1 — E2EE Encrypted Titles Reproduction Integration Test**.
> Belongs to the verification milestone (M1). Implementation starts in a
> fresh session from this file alone.

## 1. Header

- **Subtask ID:** M1-T4
- **Milestone:** M1
- **Dependencies (other subtask IDs):** M1-T1 (compose changes), M1-T3 (test file).
- **What it delivers:** Additive pass-through of `RUN_E2EE_REPRO_TESTS` in `scripts/run-integration-tests.sh` — when set, runs the e2ee-repro profile stack and the new test in a separate vitest invocation. Default behavior unchanged.

## 2. Full problem context

GitHub issue #29 reports E2EE-encrypted notebook titles served as-is via `list_notebooks` despite `JOPLIN_MASTER_PASSWORD` set. The reporter saw `SYNC_PASS` despite encrypted state (corroborated by `README.md:60`), and a `joplin e2ee decrypt` that first failed ("DecryptionWorker: cannot start because no master key is currently loaded") before succeeding on retry. **204 items** decrypted, then plaintext served without server restart.

The runner script is the entry point for all container integration tests; it must carry the new gate through, mirror the existing `RUN_SYNC_LOCK_TESTS` pattern (separate vitest invocation, destructive-isolation), and **must NOT revert M11's uncommitted baseline changes** (see Risks below).

## 3. Authoritative investigation evidence (with file:line)

- **scripts/run-integration-tests.sh:1-90 (full file)** — 90 lines. `docker compose -f "$COMPOSE_FILE" build` → `up -d joplin-mcp` → `up -d --wait joplin-mcp` → resolve `JOPLIN_CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -q -a joplin-mcp)"` (fail-fast on empty; see M11 §4) → `export JOPLIN_CONTAINER="$JOPLIN_CONTAINER_ID"` → run regular vitest suite with `RUN_SYNC_LOCK_TESTS=0` → if `RUN_SYNC_LOCK_TESTS=1`, run sqlite-busy-repro test in a separate vitest invocation → collect logs → `docker compose ... down -v --remove-orphans` → exit propagation.
- **M11 uncommitted baseline in `scripts/run-integration-tests.sh`** (uncommitted working-tree changes dated ~2026-09-29; `tests/integration-runner-config.test.ts` carries the matching uncommitted structural-test changes):
  - `ps -q -a joplin-mcp` (was `ps -q joplin-mcp`) — added `-a` so a stopped container between `up --wait` and resolution is identified.
  - Fail-fast empty-check block: `if [ -z "$JOPLIN_CONTAINER_ID" ]; then echo "ERROR: …" >&2; exit 1; fi`.
  - `export JOPLIN_CONTAINER="$JOPLIN_CONTAINER_ID"` (verbatim; no name fallback).
  - Name-fallback REMOVED: `${ID:-joplin-mcp}` no longer appears.
- **M11 structural-test pins** (verbatim):
  - `expect(script).toContain('ps -q -a joplin-mcp')`
  - `'if [ -z "$JOPLIN_CONTAINER_ID" ]; then …'; fi'`
  - `expect(script).not.toMatch(/JOPLIN_CONTAINER_ID:-/)` — the name-fallback form must NEVER return.
  - `expect(script).toContain('export JOPLIN_CONTAINER="$JOPLIN_CONTAINER_ID"')` — verbatim export.
  - `expect(script.match(/-e "JOPLIN_CONTAINER=\$\{JOPLIN_CONTAINER\}"/g)?.length).toBe(2)` — exactly 2 occurrences of `-e "JOPLIN_CONTAINER=…"`.

Both `scripts/run-integration-tests.sh` and `tests/integration-runner-config.test.ts` already carry these uncommitted M11 follow-up changes in the working tree (dated ~2026-09-29). The implementer MUST start from that baseline and NOT revert or clean it up (see Risks §8).

The M1-T4 changes MUST preserve all five pins (see Risks §8).

## 4. Scope

**Files to modify:**
- `scripts/run-integration-tests.sh` (additive).

**Files NOT to touch:**
- `docker-compose.test.yml` (M1-T1).
- `tests/container/e2ee-encrypted-titles-repro.test.ts` (M1-T3).
- `tests/integration-runner-config.test.ts` (M11 baseline; implementer must not modify).
- `.github/workflows/integration-tests.yml` (M1-T5).

## 5. Exact behavior required

Add to `scripts/run-integration-tests.sh` (after the existing `RUN_SYNC_LOCK_TESTS=1` repro block, around line 62):

```bash
# When RUN_E2EE_REPRO_TESTS=1, bring up the e2ee-repro profile (real
# Joplin Server + one-shot seed container) and run the E2EE repro test
# in a SEPARATE vitest invocation. The repro needs the seeder to have
# completed first; running it inside the same invocation as the regular
# suite could race the seeder or be incomplete if PROFILE gating is in
# use. Mirror the destructive-isolation rationale for the sqlite-busy-repro.
E2EE_REPRO_EXIT=0
if [ "${RUN_E2EE_REPRO_TESTS:-0}" -eq 1 ]; then
  echo "=== Starting E2EE repro profile (real server + seed) ==="
  docker compose -f "$COMPOSE_FILE" --profile e2ee-repro up -d joplin-server

  echo "=== Waiting for joplin-server to be healthy ==="
  docker compose -f "$COMPOSE_FILE" --profile e2ee-repro up -d --wait joplin-server

  echo "=== Running one-shot seeder ==="
  docker compose -f "$COMPOSE_FILE" --profile e2ee-repro run --rm joplin-e2ee-seed || {
    echo "ERROR: joplin-e2ee-seed failed — aborting E2EE repro" >&2
    E2EE_REPRO_EXIT=1
  }

  if [ "${E2EE_REPRO_EXIT}" -eq 0 ]; then
    echo "=== Resolving joplin-mcp container ID (with profile) ==="
    JOPLIN_CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -q -a joplin-mcp)"
    if [ -z "$JOPLIN_CONTAINER_ID" ]; then
      echo "ERROR: could not resolve joplin-mcp container from compose project $COMPOSE_FILE (e2ee-repro profile)" >&2
      E2EE_REPRO_EXIT=1
    else
      export JOPLIN_CONTAINER="$JOPLIN_CONTAINER_ID"
    fi
  fi

  if [ "${E2EE_REPRO_EXIT}" -eq 0 ]; then
    echo "=== Running E2EE encrypted-titles repro (separate vitest invocation) ==="
    docker compose -f "$COMPOSE_FILE" run --rm \
      -e "RUN_E2EE_REPRO_TESTS=1" \
      -e "JOPLIN_CONTAINER=${JOPLIN_CONTAINER}" \
      test-runner \
      pnpm vitest run --config vitest.config.container.ts \
        tests/container/e2ee-encrypted-titles-repro.test.ts \
      || E2EE_REPRO_EXIT=$?
    echo "=== E2EE repro exit code: ${E2EE_REPRO_EXIT} ==="
  fi
fi
```

Add to the exit-propagation section (around line 87):

```bash
if [ "$TEST_EXIT" -ne 0 ] || [ "$REPRO_EXIT" -ne 0 ] || [ "${E2EE_REPRO_EXIT:-0}" -ne 0 ]; then
  exit 1
fi
```

Add a new echo block for the E2EE repro status (around line 84):

```bash
if [ "${RUN_E2EE_REPRO_TESTS:-0}" -eq 1 ]; then
  if [ "$E2EE_REPRO_EXIT" -eq 0 ]; then
    echo "E2EE encrypted-titles repro passed — M1 safe-behaviour verified (RED on current code; GREEN after M2)."
  else
    echo "E2EE encrypted-titles repro failed (exit code: ${E2EE_REPRO_EXIT})."
  fi
fi
```

**Note on the `-e "JOPLIN_CONTAINER=…"` pin:** the M11 structural test pins the count to exactly 2 occurrences. The above adds 1 new occurrence for the E2EE repro invocation, bringing the total to 3 — which BREAKS the M11 invariant. **Fix:** instead of passing `JOPLIN_CONTAINER` as a third `-e` flag, refactor: the existing two occurrences can pass `JOPLIN_CONTAINER` as part of a `docker compose run --env-file` or by inlining. **Cleanest minimal change:** export `JOPLIN_CONTAINER` in the runner script (already done at line 31) and rely on `docker compose run` to inherit it via `--env-file` or via shell propagation. **Verified working approach:** use `docker compose run --rm -e RUN_E2EE_REPRO_TESTS=1 test-runner pnpm vitest run ...` (without the `-e JOPLIN_CONTAINER=...`; `JOPLIN_CONTAINER` is exported in the runner shell, and `docker compose run` inherits the environment block from compose project-level env vars, which `JOPLIN_CONTAINER` is exported into).

**Note:** `docker compose run` does NOT automatically inherit the host shell environment. The existing two `-e "JOPLIN_CONTAINER=..."` flags exist because compose project-level env does not apply to `docker compose run --rm test-runner` (the service has no `environment:` entry for `JOPLIN_CONTAINER`).

**Cleanest fix that preserves M11's exactly-2× invariant:** define `JOPLIN_CONTAINER` in the `test-runner` service's `environment:` block (M1-T1 or this subtask). Then `docker compose run --rm -e RUN_E2EE_REPRO_TESTS=1 test-runner pnpm vitest run ...` works without an extra `-e JOPLIN_CONTAINER=...`. M1-T1's scope said "do not modify the test-runner service" — but adding one env line is in scope for the M1-T1 contract. **Decision:** add `JOPLIN_CONTAINER=${JOPLIN_CONTAINER:-joplin-mcp}` to the `test-runner` service's `environment:` block in M1-T1 (NOT M1-T4). Update M1-T1's spec accordingly when this plan lands.

This keeps M11's `expect(...).toBe(2)` invariant intact: the existing two `docker compose run --rm -e "JOPLIN_CONTAINER=…"` calls stay at 2; the new E2EE invocation uses compose-side env instead of `-e` propagation.

## 6. Acceptance criteria

- Default CI (`RUN_SYNC_LOCK_TESTS=0`, `RUN_E2EE_REPRO_TESTS=0`) — identical behavior to today.
- `RUN_E2EE_REPRO_TESTS=1` — `joplin-server` starts, becomes healthy, `joplin-e2ee-seed` runs to completion, `joplin-mcp` starts (via soft dependency), vitest invocation runs the repro test.
- The `tests/integration-runner-config.test.ts` invariants remain green (the 5 pins listed in §3).
- Log collection step (`docker compose ... logs joplin-mcp`) collects logs from the e2ee-repro stack too (no change needed).
- Teardown (`docker compose ... down -v --remove-orphans`) tears down all three new volumes (`joplin_data`, `joplin_server_data`, `joplin_seed_data`) — `--remove-orphans` handles any.

## 7. Verification commands

1. Default: `bash scripts/run-integration-tests.sh` → exit 0; existing suite green; the new E2EE branch is skipped.
2. E2EE repro RED (current code): `RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh` → exit 1 (symptom assertion fails).
4. Structural checks: `pnpm test tests/integration-runner-config.test.ts` → green (all 5 invariants).
5. Manual volume check after teardown: `docker volume ls | grep -E '(^|_)joplin_(seed_data|server_data)$'` → empty (both torn down).

## 8. Risks / gotchas

- **M11 uncommitted baseline MUST be preserved.** This subtask is additive on M11; do NOT revert the `ps -q -a`, fail-fast, or `export JOPLIN_CONTAINER="$JOPLIN_CONTAINER_ID"` changes.
- **M11 structural-test `-e JOPLIN_CONTAINER` exactly 2× invariant.** Preserved by routing the new E2EE invocation through a compose-side env var on `test-runner` (added in M1-T1), not via an `-e JOPLIN_CONTAINER=...` flag.
- **Profile ordering.** Compose profiles must be activated with `--profile NAME` on BOTH `up -d` and `run` invocations. The above does; verify by inspection of the script after edit.
- **Container name resolution across profiles.** When `--profile e2ee-repro` is active, `ps -q -a joplin-mcp` still resolves the project-prefixed `joplin-mcp` service container. The runner does NOT re-resolve when the profile changes mid-run; verify by running both modes and inspecting the resolved IDs.
- **Soft-dependency in compose (`required: false`).** Compose 2.32+ required. Documented in M1-T1; if the devcontainer has older compose, the soft dep form fails and the runner cannot start. Verify `docker compose version` ≥ 2.32.

## 9. Research spikes assigned

- (None directly; the soft-dependency spike inherits from M1-T1's profile-support spike.)

## 10. Handoff note

The next subtask is **M1-T5 (CI wiring)**, which depends on this. M1-T5 adds the new opt-in `workflow_dispatch` job that calls this runner with `RUN_E2EE_REPRO_TESTS=1`.

The next-next subtask is **M1-T6 (README documentation)**, which depends on M1-T3 + M1-T4 + M1-T5.

After all M1 subtasks land: **M2-T1..T4 (the fix)**, with M2-T4 verifying that M1-T3 passes unchanged.

## Non-goals

- No changes to `tests/integration-runner-config.test.ts` (M11's uncommitted work; do not touch).
- No reordering of `down -v` teardown.
- No removal of the sqlite-busy-repro branch.
