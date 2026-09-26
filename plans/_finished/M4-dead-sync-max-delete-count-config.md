# M4 — Remove Dead `syncMaxDeleteCount` Config (Single Source of Truth)

> Source: [`docs/code-review-testing-2026-09-21.md`](../docs/code-review-testing-2026-09-21.md)
> finding **W1** (WARNING). User confirmed this is an oversight, not deliberate.

## Problem

[`src/config.ts`](../src/config.ts:44) defines `syncMaxDeleteCount` in the zod
schema (lines 44–49), maps it from the environment (line 64), lists it in the
`ConfigError` help text (line 84), and [`tests/config.test.ts`](../tests/config.test.ts:181)
covers it with six test cases (accept `100`, `0`, `-1`; reject `-2`, `1.5`, plus
the allowlist entry at line 10) — but **nothing in `src/` ever reads the parsed
value**. The only enforcement lives in the container entrypoint,
[`entrypoint-combined.sh`](../entrypoint-combined.sh:252), which consumes the
raw env var with its own hardcoded default `100` and its own ad-hoc validation.

Consequences:

- **Two sources of truth.** The TS schema rejects `-2` (`.min(-1)`), while the
  entrypoint's `[ "${SYNC_MAX_DELETE_COUNT}" -lt 0 ]` check in
  [`check_deletion_circuit_breaker`](../entrypoint-combined.sh:179) treats *any*
  negative value as "disabled" — validated config and enforced behavior diverge.
- **False assurance.** A caller may believe `SYNC_MAX_DELETE_COUNT` is validated
  because `parseConfig()` runs, when the shell consumes it unvalidated.
- **Clean-code violation.** [`src/config.ts`](../src/config.ts:44) owns a
  setting it never applies.

## Goal

Eliminate the dead config and the dual source of truth: `SYNC_MAX_DELETE_COUNT`
becomes a documented container-level (entrypoint) setting only. This is the
KISS option — the enforcement point is the shell entrypoint, which the TS
process never invokes.

## Proposed Approach

Option (a) from the review: **remove** the TS-side definition; do **not** try to
consume the parsed value in `src/`.

- [`src/config.ts`](../src/config.ts:44): remove the `syncMaxDeleteCount`
  schema entry (lines 44–49), the env map entry (line 64), and the
  `SYNC_MAX_DELETE_COUNT` line from the error help text (line 84).
- [`tests/config.test.ts`](../tests/config.test.ts): remove `SYNC_MAX_DELETE_COUNT`
  from the `ENV_VARS` allowlist (line 10) and delete the five
  `syncMaxDeleteCount` test cases.
- [`.env.example`](../.env.example:32): keep as-is — it already correctly frames
  `SYNC_MAX_DELETE_COUNT` as entrypoint-level (commented-out default `100`).
- [`README.md`](../README.md): verify the configuration table row (line 38) and
  circuit-breaker sections (lines 272, 384, 616) describe the variable as a
  container env var consumed by the entrypoint, not by `parseConfig()`. Adjust
  wording if any passage implies TS-side validation.

## Acceptance Criteria

- `grep -n "syncMaxDeleteCount\|SYNC_MAX_DELETE_COUNT" src/` returns no matches.
- `.env.example` and `README.md` still document `SYNC_MAX_DELETE_COUNT` with
  default `100`, `-1` = disable, `0` = trip on any deletion.
- [`entrypoint-combined.sh`](../entrypoint-combined.sh:252) unchanged (still
  the single enforcement point with the single default).

## Verification

1. `grep -rn "syncMaxDeleteCount" src/ tests/` → empty.
2. `pnpm test` (devcontainer/CI; no node on host) → all config tests pass with
   the removed cases and allowlist entry.
3. `pnpm run build` succeeds (no dangling references to `config.syncMaxDeleteCount`).
4. Container smoke test: set `SYNC_MAX_DELETE_COUNT=0`, observe the breaker
   still honors it (entrypoint behavior unchanged).

## Non-goals

- Consuming `SYNC_MAX_DELETE_COUNT` inside `src/` (option b — rejected: the
  enforcement point is the shell, so TS consumption would be dead code again).
- Changing the entrypoint's validation semantics.
