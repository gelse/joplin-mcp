# Changelog: `testing` vs `main`

**Generated:** 2026-09-01
**Compared refs:** `origin/main` (`51f3767`) → `testing` (`76b49ab`)

---

## Summary

| Metric           | Value |
|------------------|-------|
| Commits (testing) | 76    |
| Files changed     | 46    |
| Insertions        | 3,125 |
| Deletions         | 1,071 |

> **Note:** There are no commits in `main` that are absent from `testing`.

---

## Changes

### Features

- Add combined single-container Dockerfile and entrypoint ([`a720c0b`](https://github.com/gelse/joplin-mcp/commit/a720c0b))
- Collapse production compose to single combined container ([`f8cfc39`](https://github.com/gelse/joplin-mcp/commit/f8cfc39))
- Use MCP_HOST_PORT for host mapping; container port fixed at 3000 ([`85a7389`](https://github.com/gelse/joplin-mcp/commit/85a7389))
- Add SQLITE_BUSY retry logic to JoplinDataClient ([`0c1e19d`](https://github.com/gelse/joplin-mcp/commit/0c1e19d))
- Add sync failure diagnostics and connectivity probe ([`6d1d0f9`](https://github.com/gelse/joplin-mcp/commit/6d1d0f9))
- Add `check_sync_errors` helper and wire into sync blocks ([`3808b8d`](https://github.com/gelse/joplin-mcp/commit/3808b8d))
- Add E2EE documentation section to README ([`3ab4542`](https://github.com/gelse/joplin-mcp/commit/3ab4542))

### Infrastructure / CI/CD

- Add devcontainer Dockerfile and related setup ([`b60c765`](https://github.com/gelse/joplin-mcp/commit/b60c765), [`40e6bcb`](https://github.com/gelse/joplin-mcp/commit/40e6bcb), [`a606f89`](https://github.com/gelse/joplin-mcp/commit/a606f89), [`5736ed5`](https://github.com/gelse/joplin-mcp/commit/5736ed5), [`de9f2dd`](https://github.com/gelse/joplin-mcp/commit/de9f2dd), [`6cc7f34`](https://github.com/gelse/joplin-mcp/commit/6cc7f34), [`1608aea`](https://github.com/gelse/joplin-mcp/commit/1608aea), [`26ce102`](https://github.com/gelse/joplin-mcp/commit/26ce102), [`4bb217e`](https://github.com/gelse/joplin-mcp/commit/4bb217e), [`edfcb41`](https://github.com/gelse/joplin-mcp/commit/edfcb41), [`e7ac9fe`](https://github.com/gelse/joplin-mcp/commit/e7ac9fe), [`7a815bc`](https://github.com/gelse/joplin-mcp/commit/7a815bc))
- Add Makefile with self-documenting help target ([`75adf23`](https://github.com/gelse/joplin-mcp/commit/75adf23))
- Replace `test.yml` with separate `unit-tests.yml` and `integration-tests.yml` workflows ([`1587af9`](https://github.com/gelse/joplin-mcp/commit/1587af9))
- Add release workflow and CI/CD docs ([`08ad3a7`](https://github.com/gelse/joplin-mcp/commit/08ad3a7))
- Add testing integration runs and latest-testing image publish ([`235fea7`](https://github.com/gelse/joplin-mcp/commit/235fea7))
- Add testing to PR validation workflow triggers ([`068fdb6`](https://github.com/gelse/joplin-mcp/commit/068fdb6))
- Use frozen lockfile in Docker builds ([`035cefc`](https://github.com/gelse/joplin-mcp/commit/035cefc))
- Harden test report steps and add manual release dispatch ([`dcda872`](https://github.com/gelse/joplin-mcp/commit/dcda872))
- Drop duplicate testing push trigger from integration workflow ([`26b4d9c`](https://github.com/gelse/joplin-mcp/commit/26b4d9c))
- Remove obsolete two-container build artifacts ([`393e3e4`](https://github.com/gelse/joplin-mcp/commit/393e3e4))

### Bug Fixes

- Fix combined entrypoint review findings ([`3d61a40`](https://github.com/gelse/joplin-mcp/commit/3d61a40))
- Fix sync loop and monitor loop regressions in combined entrypoint ([`02e6a66`](https://github.com/gelse/joplin-mcp/commit/02e6a66))
- Fix drain loop blocking wait and doc/tool string accuracy ([`f509f16`](https://github.com/gelse/joplin-mcp/commit/f509f16))
- Fix compose and entrypoint review findings ([`8b64745`](https://github.com/gelse/joplin-mcp/commit/8b64745))
- Fix code review findings: lowercase types, error re-throws, polling retry ([`18c75eb`](https://github.com/gelse/joplin-mcp/commit/18c75eb))
- Fix SQLITE_BUSY exhausted path status code ([`6ad119d`](https://github.com/gelse/joplin-mcp/commit/6ad119d))
- Fix code review issues: restore schema, update test mocks and assertions ([`39976a7`](https://github.com/gelse/joplin-mcp/commit/39976a7))
- Fix 15 failing integration tests across 4 test files ([`bdc3192`](https://github.com/gelse/joplin-mcp/commit/bdc3192))
- Fix search-tags integration tests: waitForSearch shape and tag timing ([`bb56f48`](https://github.com/gelse/joplin-mcp/commit/bb56f48))
- Fix SIGPIPE race and tighten error pattern in check_sync_errors ([`788367f`](https://github.com/gelse/joplin-mcp/commit/788367f))
- Fix grep reading filename instead of file contents in check_sync_errors ([`ed51091`](https://github.com/gelse/joplin-mcp/commit/ed51091))
- Fix inverted sync error detection and unbounded log grep ([`908bb11`](https://github.com/gelse/joplin-mcp/commit/908bb11))
- Fix silent `log.txt` skip warning and update error pattern wording ([`5b42d78`](https://github.com/gelse/joplin-mcp/commit/5b42d78))
- Fix `tagNote`/`untagNote` to use correct Joplin Data API endpoints ([`ef70bc9`](https://github.com/gelse/joplin-mcp/commit/ef70bc9))
- Fix flaky SQLITE_BUSY tests and add proper coverage ([`0ab57ab`](https://github.com/gelse/joplin-mcp/commit/0ab57ab))
- Fix README heading for search limitation to be deterministic ([`d183230`](https://github.com/gelse/joplin-mcp/commit/d183230))
- Fix idempotent `groupadd` in devcontainer Dockerfile ([`edfcb41`](https://github.com/gelse/joplin-mcp/commit/edfcb41))
- Fix devcontainer forwarded port to 3000 ([`e5ab1c3`](https://github.com/gelse/joplin-mcp/commit/e5ab1c3))
- Fix devcontainer vscode-server directory permissions ([`f1605e1`](https://github.com/gelse/joplin-mcp/commit/f1605e1))
- Fix devcontainer; removed from gitignore ([`40e6bcb`](https://github.com/gelse/joplin-mcp/commit/40e6bcb))
- Fix stale `test.yml` reference in SBOM.md ([`177716f`](https://github.com/gelse/joplin-mcp/commit/177716f))

### Tests

- Add container integration test infrastructure ([`f93bcd0`](https://github.com/gelse/joplin-mcp/commit/f93bcd0), [`dad6799`](https://github.com/gelse/joplin-mcp/commit/dad6799), [`f39c939`](https://github.com/gelse/joplin-mcp/commit/f39c939), [`bbd65fb`](https://github.com/gelse/joplin-mcp/commit/bbd65fb), [`aeeaaa7`](https://github.com/gelse/joplin-mcp/commit/aeeaaa7), [`89c48a9`](https://github.com/gelse/joplin-mcp/commit/89c48a9))
- Add mcp-connection container test ([`4f48ba1`](https://github.com/gelse/joplin-mcp/commit/4f48ba1))
- Add notes-crud end-to-end test suite ([`cce8ebe`](https://github.com/gelse/joplin-mcp/commit/cce8ebe))
- Add folders-crud container test ([`87f4337`](https://github.com/gelse/joplin-mcp/commit/87f4337))
- Add search-tags e2e tests ([`7c0b1ef`](https://github.com/gelse/joplin-mcp/commit/7c0b1ef))
- Add error-handling container tests ([`0818161`](https://github.com/gelse/joplin-mcp/commit/0818161))
- Add unit tests for sync failure diagnostics ([`4a39f57`](https://github.com/gelse/joplin-mcp/commit/4a39f57))
- Add unit tests for SQLITE_BUSY retry logic ([`2091639`](https://github.com/gelse/joplin-mcp/commit/2091639))
- Add unit tests for `check_sync_errors` function ([`f5f8951`](https://github.com/gelse/joplin-mcp/commit/f5f8951))
- Add integration test coverage analysis ([`a7b4404`](https://github.com/gelse/joplin-mcp/commit/a7b4404))
- Add integration test orchestration script ([`1dc41b2`](https://github.com/gelse/joplin-mcp/commit/1dc41b2))
- Skip search-dependent tests and document search limitation ([`b2ab3b4`](https://github.com/gelse/joplin-mcp/commit/b2ab3b4))
- Increase search/tag test timeouts for FTS index latency ([`73b3869`](https://github.com/gelse/joplin-mcp/commit/73b3869))
- Document intentional brittleness of tool-count assertions ([`3123e92`](https://github.com/gelse/joplin-mcp/commit/3123e92))

### Documentation / Chore

- Update documentation for single-container topology ([`ffdf542`](https://github.com/gelse/joplin-mcp/commit/ffdf542))
- Add container integration tests section to README ([`24e1084`](https://github.com/gelse/joplin-mcp/commit/24e1084))
- Document SQLITE_BUSY as known limitation ([`cbdea45`](https://github.com/gelse/joplin-mcp/commit/cbdea45))
- Removed old, deprecated `TASK_LOG` and added plans dir to ignore files ([`26ce102`](https://github.com/gelse/joplin-mcp/commit/26ce102))

### Merge PRs

- Merge pull request #12: merge-containers ([`76b49ab`](https://github.com/gelse/joplin-mcp/commit/76b49ab))
- Merge pull request #9: sync-failure-diagnostics ([`e1dcdd3`](https://github.com/gelse/joplin-mcp/commit/e1dcdd3))
- Merge pull request #6: sync-pass-false-positive ([`dd78dd4`](https://github.com/gelse/joplin-mcp/commit/dd78dd4))
- Merge pull request #5: E2EE-documentation ([`c900c20`](https://github.com/gelse/joplin-mcp/commit/c900c20))
- Merge pull request #4: preparations-and-devcontainer ([`1bb1d99`](https://github.com/gelse/joplin-mcp/commit/1bb1d99))
- Merge pull request #3: preparations-and-devcontainer ([`7834b56`](https://github.com/gelse/joplin-mcp/commit/7834b56))
