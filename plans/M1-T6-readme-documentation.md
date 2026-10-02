# M1-T6 — README documentation for E2EE repro

> Subtask of **M1 — E2EE Encrypted Titles Reproduction Integration Test**.
> Belongs to the verification milestone (M1). Implementation starts in a
> fresh session from this file alone.

## 1. Header

- **Subtask ID:** M1-T6
- **Milestone:** M1
- **Dependencies (other subtask IDs):** M1-T3 (test file), M1-T4 (runner), M1-T5 (CI).
- **What it delivers:** A README.md section under "Testing" describing the new E2EE repro test, the gated opt-in nature, the local one-shot command, and a link to the CI workflow_dispatch job. A correction to the existing E2EE section acknowledging that today's setup stores the password but does NOT trigger decryption — users hitting the symptom need to either run `joplin e2ee decrypt` manually or wait for the M2 fix.

## 2. Full problem context

GitHub issue #29 reports E2EE-encrypted notebook titles served as-is via `list_notebooks` despite `JOPLIN_MASTER_PASSWORD` set. The reporter saw empty `title` fields, `SYNC_PASS` despite encrypted state (corroborated by `README.md:60`), and a manual `joplin e2ee decrypt` that first failed ("DecryptionWorker: cannot start because no master key is currently loaded") before succeeding on retry — 204 items decrypted, plaintext served without restart. **The README is the primary user-facing surface** for documenting this bug class: the existing `## ⚠️ End-to-End Encryption (E2EE)` section (`:58-92`) covers the upload-side silent-failure mode but does not document the download-side empty-titles mode. M1-T6 adds a section describing the new repro test and corrects the E2EE section.

## 3. Authoritative investigation evidence (with file:line)

- **README.md:58-92** — current E2EE section. Existing FTS blockquote precedent at `:351` (`> **⚠️ Known limitation: ...**` blockquote format used for `search_notes`). Mirror the same blockquote style for the E2EE encrypted-titles issue.
- **README.md:60** — *"… the sync process will misleadingly report `SYNC_PASS`"*. The reporter saw the same misleading SYNC_PASS on the download side (initial sync completed; encrypted titles still surfaced). The existing E2EE section's wording is upload-side; M1-T6's correction adds the download-side equivalent.
- **README.md:86-88** — the warning about `joplin e2ee decrypt` not persisting the password. The correction in M1-T6 mentions this as the manual workaround users may apply today.
- **README.md:351** — known-limitation blockquote pattern to mirror.
- **README.md testing section** — search the README for the existing testing-related subsection; the new E2EE repro section should sit alongside the existing `RUN_SYNC_LOCK_TESTS` description (verify the README has one before adding).

## 4. Scope

**Files to modify:**
- `README.md` (additive — new section + correction in existing E2EE section).

**Files NOT to touch:**
- `CHANGELOG.md` (the user's request did not ask for changelog changes; out of scope).
- `docs/` directory (no relevant doc there; out of scope).
- Any source code.

## 5. Exact behavior required

### Add a section under Testing

After the existing `### sqlite-busy-repro` (or equivalent) section, add:

```markdown
#### E2EE encrypted-titles reproduction test (issue #29)

This gated integration test reproduces GitHub issue #29 — where the
combined container, with `JOPLIN_MASTER_PASSWORD` set and E2EE enabled on
a real Joplin Server, serves E2EE-encrypted notebook titles as-is via
`list_notebooks`. The test asserts the **safe** behavior (non-empty
plaintext titles, no remaining encrypted blobs) and therefore **fails on
the current container code** (proving the bug exists) and will flip to
pass when the M2 fix lands — without any assertion edits.

**Requirements:**

- A real `joplin/server:latest` container with E2EE enabled and an
  account matching `JOPLIN_USERNAME` / `JOPLIN_PASSWORD`.
- `JOPLIN_MASTER_PASSWORD` set to the password used to encrypt fixtures.
- A fresh `joplin_data` volume.

**Local one-shot run:**

```bash
RUN_E2EE_REPRO_TESTS=1 ./scripts/run-integration-tests.sh
```

The runner brings up the real Joplin Server, runs the one-shot seed
container to create an encrypted notebook + note, starts the combined
container, and runs the repro. On current container code it **fails** with
the symptom assertion message. Default CI is unaffected.

**CI:**

Manual `workflow_dispatch` with input `run_e2ee_repro_tests: true` →
new opt-in job `e2ee-encrypted-titles-repro` runs. See
`.github/workflows/integration-tests.yml`.

**Known gap (M1 → M2):** today's combined container sets the master
password but does NOT trigger decryption. Users hitting the symptom
need to either run `joplin e2ee decrypt` manually inside the container
(see warning below) or wait for the M2 fix (scope: post-sync decrypt +
verification + startup reorder + tighter sync detection). See
`plans/M2-T1..T4` for the fix design.
```

### Correct the existing E2EE section (line 86-92)

After the existing `### ⚠️ Warning: joplin e2ee decrypt does NOT persist the password` block (`:86-88`), add:

```markdown
### Known gap: encrypted titles served as-is via `list_notebooks` (issue #29)

> **⚠️ Known gap.** With `JOPLIN_MASTER_PASSWORD` set and E2EE enabled on
> the Joplin Server, the combined container configures the password but
> **does not trigger decryption** of items already on the server. The
> `list_notebooks` MCP tool may therefore return notebooks with **empty
> `title` fields** (or `encryption_applied=1` with non-empty
> `encryption_cipher_text`). Sync will misleadingly report `SYNC_PASS`
> even though ciphertext was not decrypted. This is GitHub issue #29.
>
> **Workarounds today** (until M2 lands):
>
> ```bash
> # Run e2ee decrypt manually inside the container; first attempt may
> # fail with "DecryptionWorker: cannot start because no master key is
> # currently loaded" (master-key propagation timing) — re-run if so.
> docker exec joplin-mcp joplin e2ee decrypt
> docker restart joplin-mcp
> ```
>
> **Permanent fix:** see the M2 milestone plans
> (`plans/M2-T1..T4`) — post-sync `joplin e2ee decrypt` with verification,
> startup reorder so `joplin server start` follows sync+decrypt, and
> tighter sync error detection. A container integration test
> reproducing this gap ships with M1 (`plans/M1-T3`); the M2 fix flips
> that test green with zero assertion edits.
```

## 6. Acceptance criteria

- README contains the new `#### E2EE encrypted-titles reproduction test (issue #29)` section under Testing.
- README's existing E2EE section contains the new `### Known gap:` subsection.
- Markdown is rendered correctly on GitHub (no broken links; the `plans/M1-T1..T6` and `plans/M2-T1..T4` references resolve to files in `plans/`).
- The warning blockquote mirrors the existing `README.md:351` FTS-known-limitation style.

## 7. Verification commands

1. `grep -n 'issue #29' README.md` → at least 2 matches (the new Testing section + the new E2EE-section correction).
2. `grep -n 'e2ee decrypt' README.md` → at least 2 matches (the existing warning + the new workaround command).
3. Visual inspection: render the README via `grip -b README.md` or open in GitHub markdown preview → new sections render as expected, blockquote style matches `:351`.

## 8. Risks / gotchas

- **README drift** — if the README is updated to reflect M2's fix in the future, this section's "Known gap" wording becomes stale. M2-T4 owns the post-M2 README update; do not duplicate that here.
- **Markdown link targets** — the new section references `plans/M1-T1..T6` and `plans/M2-T1..T4`. These resolve to files in the repo. Verify on GitHub that the relative paths render as links (not as text).
- **Existing E2EE section ordering** — insert the new `### Known gap:` AFTER the `### ⚠️ Warning: joplin e2ee decrypt…` block but BEFORE the `### How to tell if E2EE is the problem` block (`:90-92`). Verify by inspection.

## 9. Research spikes assigned

- (None.)

## 10. Handoff note

After M1-T6: M1 is fully shipped. The next milestone is **M2-T1..T4 (the fix)**. M2-T4 owns any post-M2 README corrections (e.g. removing the "Known gap" subsection, pointing to a "Resolved" note).

## Non-goals

- No `CHANGELOG.md` changes (the user's request did not ask for it; M2-T4 or the release process owns changelog).
- No source-code changes.
- No new documentation files in `docs/` (README is sufficient for this bug class).
