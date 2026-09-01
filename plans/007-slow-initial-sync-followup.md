# Plan #7 — Slow Initial Sync (Follow-up Issue)

**Source:** [GitHub Issue #2, Topic 7](https://github.com/gelse/joplin-mcp/issues/2)
**Type:** Investigation — COMPLETED (2026-09-01)
**Priority:** Closed (no fixable action in this repo)
**Effort:** TBD (investigation required)

---

## Understanding

- **Goal:** Create a follow-up GitHub issue to investigate why initial sync is slow (~12 items/min over LAN) and explore potential optimizations.
- **Intended behavior:** Initial sync should be as fast as the network and server allow. The reporter saw ~5 hours for 4,500 items over LAN.
- **Scope/constraints:** This is a placeholder for future investigation. No immediate implementation planned.

## Findings

- The reporter observed ~4,500 items taking ~5 hours (~12 items/min) over LAN to a local Joplin Server.
- Incremental syncs afterward are 3-7 seconds, so the issue is specific to initial/bulk sync.
- Near-zero CPU usage suggests the bottleneck is I/O-bound or protocol-level (e.g., individual HTTP requests per item rather than batch operations).
- The Joplin CLI's `joplin sync` command handles the sync internally — we don't control the sync algorithm.
- The SQLITE_BUSY contention from Topics 5/6 may contribute to slow initial sync (database locks during heavy write operations).
- The Joplin Server (Postgres 15) should not be the bottleneck for 4,500 items.

## Design

- **Decision:** Create a GitHub issue documenting the performance observation and potential investigation areas:
  1. **Is it Joplin CLI internals?** The sync algorithm may process items one-by-one with individual HTTP requests. Investigating whether batch sync is possible.
  2. **Is it SQLite contention?** The two-process architecture (Data API + sync) may cause lock contention during bulk writes, slowing sync.
  3. **Is it network overhead?** Each item may require multiple HTTP round-trips (upload, metadata, conflict check).
  4. **Can we parallelize?** The Joplin CLI may not support parallel sync streams.
  5. **Is the Data API being hit during sync?** If the MCP server is active during initial sync, the SQLITE_BUSY retries from Plan #5 add latency.
- **Rationale:** This requires investigation before any implementation. The issue should capture the observation and proposed investigation areas for future work.

## Tasks

### 1. ~~Create follow-up GitHub issue for slow initial sync~~ — NOT DONE (superseded by Resolution section)

- **Files:** None (GitHub issue only)
- **Changes:**
  - Create a new GitHub issue titled: "Investigate slow initial sync performance (~12 items/min)"
  - Content:

    ```markdown
    ## Problem

    Initial sync of ~4,500 items takes ~5 hours (~12 items/min) over LAN to a local
    Joplin Server, at near-zero CPU. Incremental syncs are 3-7s.

    ## Environment

    - Joplin CLI 3.6.2 (joplin-core container default)
    - Joplin Server 3.7.1 (self-hosted, Postgres 15)
    - ~4,500 notes / 60 notebooks
    - Docker on QNAP QTS 5.2.9

    ## Possible Causes

    1. Joplin CLI sync processes items one-by-one (no batching)
    2. SQLite contention from two-process architecture (ref: #2, Topics 5/6)
    3. Per-item HTTP round-trip overhead
    4. Data API activity during sync adds latency via SQLITE_BUSY retries

    ## Investigation Areas

    - Profile `joplin sync` network traffic to count HTTP requests per item
    - Test with Data API disabled to isolate sync-only performance
    - Check Joplin CLI source for batch sync support
    - Consider if single-process architecture (ref: #2, Topic 6) improves performance

    ## Notes

    - This only affects initial sync — incremental syncs are fast
    - May be partially addressed by resolving #2, Topics 5/6 (SQLITE_BUSY contention)
    ```

  - Label as `enhancement`, `performance`, and reference `#2`.

- **Context/constraints:** Do NOT create the issue yet — only prepare the plan.
- **Dependencies:** None.
- **Acceptance:** The plan file documents the follow-up issue content with clear problem description and investigation areas.
- **Verification:** N/A.

## Testing

- N/A — this is a follow-up issue for future investigation.

## Risks / Open Decisions

## Resolution (2026-09-01 re-investigation after v0.2.0 combined-container overhaul)

**Verdict:** Not fixable in this repository. The one cause we owned — Cause 4, Data API `SQLITE_BUSY` retry latency during initial sync — is eliminated by the current architecture. The remaining causes are intrinsic to the Joplin CLI binary.

### Per-Cause Disposition

| Cause | Status | Detail |
|-------|--------|--------|
| **1. CLI processes items one-by-one** | INTRINSIC | Sync throughput is governed entirely by `joplin@3.6.2` (see [`Dockerfile.combined`](Dockerfile.combined:44)), which we invoke as a black box with no batching knobs. |
| **3. Per-item HTTP round-trips** | INTRINSIC | Same as Cause 1 — the Joplin CLI issues one HTTP request per item. We have no control over this. |
| **2. Two-process SQLite contention** | REDUCED | Contention is now the same-container Data API ↔ sync-CLI pair and affects MCP reads during periodic sync windows, documented in [README "SQLite contention" note](README.md:243-250). |
| **4. Data API activity during initial sync** | ELIMINATED | The entrypoint runs a single blocking `joplin sync` ([`entrypoint-combined.sh` lines 293-309](entrypoint-combined.sh:293)) BEFORE the MCP server starts ([`entrypoint-combined.sh` lines 359-361](entrypoint-combined.sh:359)), so no Data API calls occur during initial sync. Additionally, `SQLITE_BUSY` retries in [`JoplinDataClient`](src/data-client.ts:28) are GET-only (see comment "Only retry GET requests — writes must not be retried" at [`src/data-client.ts:225`](src/data-client.ts:225)) and only active during MCP serving. |

### Legacy Code Note

The TypeScript `SyncManager` / `CliExecutor.sync()` are legacy code paths — never instantiated in production ([`src/mcp/entry.ts` comment: "syncManager intentionally omitted"](src/mcp/entry.ts:54)). Periodic sync is a bash loop: `while true; sleep $SYNC_INTERVAL_SECONDS; joplin sync` ([`entrypoint-combined.sh` lines 320-344](entrypoint-combined.sh:320)).

### Why No GitHub Issue Was Opened

The originally planned GitHub issue was intentionally NEVER opened. The only remaining root cause is upstream in the Joplin CLI — opening an issue here would track work we cannot perform.

### Caveat

The historical ~12 items/min observation predates v0.2.0. Post-overhaul throughput is unmeasured — measurement is possible via [`scripts/measure-initial-sync.sh`](scripts/measure-initial-sync.sh) (added as part of this plan closure).

---

- **Root cause unknown:** The slow performance may be intrinsic to the Joplin CLI sync algorithm, which we cannot modify. If so, the only mitigation would be to document the expected initial sync time.
- **Interaction with Topics 5/6:** Resolving the SQLITE_BUSY issues may or may not improve initial sync performance. This needs measurement.
- **Priority:** This is the lowest priority item — it only affects first-run and the workaround (wait) is acceptable.
