M1 — SQLite Busy reproduction integration test — completed and independently verified (ACCEPT), branch `testing` at `5ace019`.

## Outcome

The repro test for GitHub issue #27 exists and proves the bug: under a held SQLite exclusive write lock, a concurrent `joplin sync` reads `version` as null and re-runs schema migrations from 0, destroying the database.

**Verified behavior** (two consecutive gated runs, fresh volumes each):
- Gated run (`RUN_SYNC_LOCK_TESTS=1 ./scripts/run-integration-tests.sh`): regular container suite fully green (30 passed, repro skipped), then the isolated repro invocation **fails with a visible vitest diff on the destructive signature**: `SQLITE_BUSY: database is locked: SELECT * FROM version LIMIT 1` → `Current database version <null>` → `Upgrading database from version 0` — exactly the issue #27 chain, deterministically.
- Ungated runs: byte-identical to previous behavior; no repro banner; all tests green.

## Key deliverables

- [`tests/container/sqlite-busy-repro.test.ts`](tests/container/sqlite-busy-repro.test.ts) — gated on `RUN_SYNC_LOCK_TESTS`, with a self-validating mechanism (awaited `LOCK_HELD` marker + independent `PROBE_BUSY` probe; the test cannot pass vacuously), window-scoped log assertions (excludes the benign startup-collision signature), volume-backed capture that survives the deliberate container death, and a `TODO(M2)` flip contract that requires zero assertion edits once M2 lands.
- Runner isolation in [`scripts/run-integration-tests.sh`](scripts/run-integration-tests.sh) — the destructive repro runs as its own vitest invocation after the regular suite (it kills the shared container by design).
- Compose/CI wiring: docker.sock + docker CLI scoped to test-runner only; manual `workflow_dispatch` CI job (never on PRs).
- Docs: [`README.md`](README.md) section and [`plans/M1-sqlite-busy-repro-test.md`](plans/M1-sqlite-busy-repro-test.md) kept accurate, including a post-implementation addendum.

## Notable findings along the way

- The original plan's holder was doubly wrong: a bare `BEGIN EXCLUSIVE` takes no lock until a statement runs inside the transaction, and joplin retries `SQLITE_BUSY` for ~43s — the holder needs a statement in-txn plus a ≥90s hold.
- The destructive signature lives in `log.txt` on the data volume, not container stdout, and survives the container teardown only via volume-backed capture read from a helper container.

## Unresolved items (by design, out of M1 scope)

- M2 (the fix/mitigation) is not started; the repro's assertion-flip contract is ready for it.
- Minor verifier-noted gaps that do not affect correctness: the `SYNC_EXIT` poll branch and the timeout watchdog path are only exercised by manual kills, not live gated runs.