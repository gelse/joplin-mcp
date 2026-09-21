Milestone M2 is complete, verified, and committed (`68c4f70` on `testing`, plus fix commits `99d6c4c` and `1070268`).

## What was built
Per the approved plan ([`plans/M2-sqlite-busy-fixes-and-circuit-breaker.md`](plans/M2-sqlite-busy-fixes-and-circuit-breaker.md)):

- **Destructive-signature detection** — [`check_sync_danger()`](entrypoint-combined.sh:117) matches `SQLITE_BUSY` / `database is locked` / version-0-migration signatures across the sync logs; wired into both branches of the initial sync, the periodic loop, and the cleanup sync.
- **Halt marker** — `${JOPLIN_PROFILE_DIR}/.sync-halt` permanently refuses further syncs (gate + sleep, no loop-kill → no Docker restart loop); survives restarts; manual removal re-enables sync.
- **Serialization** — `flock` wraps all three `joplin sync` sites and the item-count calls (sync-vs-sync only; the Data API never takes the flock — documented honestly).
- **Deletion circuit-breaker** — pre/post counts via `joplin ls -n 99999` / `ls /`; `SYNC_MAX_DELETE_COUNT` (default 100, `-1` disables); set -e-safe conditional invocation; suspicious-zero retry; skip-not-fail on count errors.
- **Config wiring** — [.env.example](.env.example), [src/config.ts](src/config.ts:44) (schema/env map/error list), [tests/config.test.ts](tests/config.test.ts:11) with boundary tests.
- **Tests** — 18 new cases in [tests/test-check-sync-errors.sh](tests/test-check-sync-errors.sh) (32/32 pass), 13 structure tests in [tests/test-sync-failure-diagnostics.sh](tests/test-sync-failure-diagnostics.sh) (25/25 pass), repro test re-scoped in [tests/container/sqlite-busy-repro.test.ts](tests/container/sqlite-busy-repro.test.ts).
- **Docs** — [README.md](README.md) and [CHANGELOG.md](CHANGELOG.md) updated.

## Verification (all green)
- `RUN_SYNC_LOCK_TESTS=1 ./scripts/run-integration-tests.sh` → `SCRIPT_EXIT=0`; repro suite 1 passed; regular container suite 30 passed/4 skipped.
- Unit suite: 419 passed/14 skipped. Shell suites: 32/32 and 25/25. shellcheck: no new warning classes.
- Exit propagation from the repro suite now enforced (verified with a stubbed negative control).
- In-container probes: halt marker present → sync refused, MCP stays up; marker removed → sync resumes.

## Notable plan corrections made during the workflow
- `database.busyTimeout` is **rejected** by Joplin CLI 3.7.1 (exit 1, "Unknown key") — dropped in favor of documentation; flock verified present in the image.
- Fixed a `START_PERIODIC_LOOP` unbound-variable crash on the halt path and re-scoped the M1 repro to assert what M2 actually guarantees (the first bypassed destructive sync is a documented non-goal; detection regex + reproduction + no secondary corruption are asserted instead).

## Known out-of-scope item
Pre-existing `WAIT_PID` unbound-variable warning at [entrypoint-combined.sh:702](entrypoint-combined.sh:702) on shutdown — unrelated to M2, suitable for a separate issue.