# M3 — Comment on GitHub Issue #27

## Goal

Post a detailed comment on GitHub issue #27 summarizing the root cause,
implemented fixes, new environment variables, and test evidence. This closes
the feedback loop for the issue reporter and documents the resolution for
future reference.

## Background

GitHub issue #27 reports data destruction when the Joplin CLI sync cannot read
the `version` table because the Data API holds the SQLite write lock. M1
reproduced this failure deterministically. M2 implemented container-level
fixes (serialization, detection, circuit-breaker). M3 communicates the
resolution to the issue.

## Prerequisites / Dependencies

- **M2 must be complete.** M3 depends on the fixes being implemented and
  tested. The comment should reference concrete file changes, env vars, and
  test evidence that only exist after M2.

## Detailed Steps

### Step 1 — Draft the issue comment

Create a markdown file at [`plans/issue-27-comment.md`](./issue-27-comment.md)
containing the exact comment body. This file will be passed to
`gh issue comment 27 --body-file`.

**Draft content:**

```markdown
## Root Cause

When the Joplin Data API (running inside the combined container) holds the
SQLite write lock on `database.sqlite`, a concurrent `joplin sync` call
receives `SQLITE_BUSY: database is locked` when reading the `version` table.

The upstream Joplin CLI (3.7.1, `JoplinDatabase.js`) treats a `null` version
as "brand new database" and re-runs schema migrations from version 0 —
destroying all data. This was verified in production: profiles destroyed,
notes silently zeroed.

## What We Fixed

Container-level fixes that prevent this class of failure without patching
the upstream Joplin CLI:

### 1. Serialization via flock
All three `joplin sync` call sites (initial, periodic loop, cleanup) now
acquire an exclusive `flock` before executing. This serializes CLI sync
against any other process that holds the same lock file.

**Files changed:** `entrypoint-combined.sh` (lines ~300, ~334, ~461)

### 2. Abort on destructive log signatures
A new `check_sync_danger()` function scans sync logs for destructive
patterns (`SQLITE_BUSY`, `database is locked`, `Upgrading database from
version 0`, `Current database version.*null`). When detected:
- The sync is **aborted** (not just warned)
- A halt marker file is written (`.sync-halt`)
- The periodic sync loop is **killed**
- The container logs a clear error pointing to this issue

**Files changed:** `entrypoint-combined.sh` (new function, wired into all
three sync sites)

### 3. Deletion circuit-breaker
A pre/post item-count snapshot comparison trips a circuit breaker when sync
would delete more items than the configurable threshold. On trip:
- Halt marker is written
- Sync loop is killed
- Clear log message with counts and threshold

**Files changed:** `entrypoint-combined.sh` (new functions + env var)

### 4. PRAGMA busy_timeout
`database.busyTimeout` is configured so the CLI waits (up to 30s) instead of
failing immediately when the lock is briefly held.

**Files changed:** `entrypoint-combined.sh` (line ~167)

## New Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNC_MAX_DELETE_COUNT` | `100` | Maximum items sync may delete before circuit breaker trips. Set to `0` to disable. |

## Test Evidence

- **M1 repro test** (`tests/container/sqlite-busy-repro.test.ts`):
  Deterministically reproduces the SQLITE_BUSY contention by holding the
  SQLite lock via a second process and triggering `joplin sync`. After M2
  fixes, the test asserts the safe behavior (abort, no migration, data
  preserved) and **passes**.

- **Shell tests** (`tests/test-check-sync-errors.sh`,
  `tests/test-sync-failure-diagnostics.sh`): Updated with cases for
  `check_sync_danger()`, `check_deletion_circuit_breaker()`, flock
  wrapping, and halt marker creation.

- **Unit tests** (`tests/config.test.ts`): `SYNC_MAX_DELETE_COUNT` added
  to config schema with boundary tests.

## Recovery

If sync is halted (halt marker exists):
1. Investigate the logs for the root cause
2. Remove the halt marker: `rm /home/joplin/.config/joplin/.sync-halt`
3. Sync will resume on the next periodic cycle

## Files Changed

- `entrypoint-combined.sh` — flock, detection, circuit-breaker, busy_timeout
- `src/config.ts` — SYNC_MAX_DELETE_COUNT schema
- `.env.example` — new env var documented
- `README.md` — SQLITE_BUSY caveats updated, new env vars documented
- `CHANGELOG.md` — entry under [Unreleased]
- `tests/container/sqlite-busy-repro.test.ts` — new repro test (M1)
- `tests/test-check-sync-errors.sh` — new test cases
- `tests/test-sync-failure-diagnostics.sh` — new test cases
- `tests/config.test.ts` — new env var + boundary tests
```

### Step 2 — Post the comment

```bash
gh issue comment 27 --body-file plans/issue-27-comment.md
```

### Step 3 — Label management

If the issue has labels like `bug` or `data-loss`, ensure they remain. If
there is a `fixed` or `resolved` label available, add it:

```bash
gh issue edit 27 --add-label "fixed"
```

If no such label exists, skip this step and note it in the completion report.

### Step 4 — Clean up

Remove the temporary `plans/issue-27-comment.md` file after the comment is
posted (it was only a staging file for `--body-file`).

## Definition of Done

- Comment posted on issue #27 via `gh issue comment 27 --body-file`.
- Comment covers: root cause, what was fixed, new env vars, test evidence,
  recovery steps, files changed.
- Temporary staging file `plans/issue-27-comment.md` removed after posting.
- Git commit made (e.g. `Document issue #27 resolution in GitHub comment`).

## Verification

1. `gh issue view 27` — confirm the comment appears and is readable.
2. Verify the comment links to the correct PR/commits (add PR link after
   merge if applicable).
3. Git log shows a commit for the documentation update.

## Non-goals

- Closing the issue automatically (leave that to the reporter or maintainer
  after they verify the fix).
- Creating a PR (M1–M2 commits should already be on a branch; M3 just
  comments on the issue).
- Modifying issue labels beyond what is available and appropriate.

## Risks

- **Comment may need adjustment** after review (tone, accuracy of line
  references). The staging file allows iteration before posting.
- **Issue may have been updated** since the investigation; re-read the
  issue thread before posting to ensure the comment addresses any new
  information.
