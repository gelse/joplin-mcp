#!/bin/bash
# Seed script — runs in a one-shot container against the test Joplin Server.
# Enables E2EE, creates a deterministic encrypted notebook + note, syncs them
# to the server, VERIFIES that the ciphertext actually reached the server,
# and exits 0 so the combined container can start.

# E2EE is enabled HERE, non-interactively: `joplin e2ee enable -p <pw> -f` does
# not prompt on CLI 3.7.1 when -p and -f are given (verified against the pinned
# image) and is a safe no-op on re-runs when E2EE is already enabled. Enabling
# happens BEFORE any item is created so the fixture syncs as ciphertext — a
# configured master password alone does NOT activate encryption (it only
# equips the client to decrypt). The seeder no longer assumes the test server
# has E2EE enabled out-of-band; there is no out-of-band provisioning step.

set -euo pipefail

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] [seed] $*" >&2; }

: "${JOPLIN_SERVER_URL:?JOPLIN_SERVER_URL must be set}"
: "${JOPLIN_USERNAME:?JOPLIN_USERNAME must be set}"
: "${JOPLIN_PASSWORD:?JOPLIN_PASSWORD must be set}"
: "${JOPLIN_MASTER_PASSWORD:?JOPLIN_MASTER_PASSWORD must be set}"

NOTEBOOK_TITLE="EncryptedNotebook"
NOTE_TITLE="EncryptedNote"

# ---------------------------------------------------------------------------
# Phase-2 resync fixtures (issue #29 decrypt-on-resync repro).
#
# When E2EE_RESYNC_NOTEBOOK_TITLE + E2EE_RESYNC_NOTE_TITLE are BOTH set, an
# ADDITIONAL notebook+note pair is created (in this same E2EE-enabled profile,
# so it syncs to the server as ciphertext exactly like the base fixture) and
# recorded in .e2ee-resync-marker.json on this volume. The runner invokes the
# seeder a SECOND time with these vars AFTER joplin-mcp has booted and
# decrypted the base fixture — so the pair can only reach joplin-mcp via the
# PERIODIC sync loop, which is precisely the path that (pre-fix) never
# decrypts. With the vars unset the whole block is a no-op and phase-1
# behavior is byte-identical.
#
# Anti-vacuous: the pair is only trusted as "encrypted at the source" after
# the same throwaway keyless-profile verification as the base fixture proves
# the ciphertext is on the server; the marker is written ONLY after that
# proof. Without it, a silently unencrypted phase-2 fixture would arrive
# already plaintext and the resync repro would pass vacuously.
# ---------------------------------------------------------------------------
E2EE_RESYNC_NOTEBOOK_TITLE="${E2EE_RESYNC_NOTEBOOK_TITLE:-}"
E2EE_RESYNC_NOTE_TITLE="${E2EE_RESYNC_NOTE_TITLE:-}"

# Throwaway profile used only for the post-sync verification below. It is
# deliberately created WITHOUT a master password, so items sync down exactly
# as the server stores them (still encrypted). The seeder's own profile is
# not usable as evidence: locally created items stay plaintext there
# (encryption_applied=0) even after being uploaded encrypted.
VERIFY_HOME="/tmp/e2ee-seed-verify-home"
VERIFY_ATTEMPTS=3

# ---------------------------------------------------------------------------
# JSON item lookup.
#
# `joplin ls / -f json` (and no-arg `joplin ls -f json` for the active
# notebook's notes) returns FULL-LENGTH 32-char ids plus the raw encryption
# fields (encryption_applied, encryption_cipher_text) — unlike `ls -l`, whose
# first column is a SHORT id. All lookups therefore parse the JSON output and
# match an exact field value (title or id) instead of an `ls -l` line regex.
# ---------------------------------------------------------------------------
json_item_field() { # $1=match_field  $2=match_value  $3=field_to_print; JSON array on stdin
  node -e '
    const mf = process.argv[1], mv = process.argv[2], pf = process.argv[3];
    let items;
    try {
      items = JSON.parse(require("fs").readFileSync(0, "utf8"));
    } catch (e) {
      console.error("seed: JSON parse failed: " + e.message);
      process.exit(1);
    }
    const list = Array.isArray(items) ? items : [];
    const item = list.find((it) => String(it[mf]) === mv);
    if (!item || item[pf] === undefined || item[pf] === null) process.exit(2);
    process.stdout.write(String(item[pf]));
  ' "$1" "$2" "$3"
}

log "Configuring sync target: ${JOPLIN_SERVER_URL}"
joplin config sync.target 10
joplin config "sync.10.path" "${JOPLIN_SERVER_URL}"
joplin config "sync.10.username" "${JOPLIN_USERNAME}"
joplin config "sync.10.password" "${JOPLIN_PASSWORD}"

log "Setting master password"
joplin config encryption.masterPassword "${JOPLIN_MASTER_PASSWORD}"

log "Enabling E2EE (non-interactive: e2ee enable -p ... -f)"
joplin e2ee enable -p "${JOPLIN_MASTER_PASSWORD}" -f || {
  log "E2EE enable failed — items would seed as plaintext; aborting"
  exit 1
}
log "E2EE status: $(joplin e2ee status 2>&1 | tail -1)"

log "Performing initial sync against server (may download or no-op)"
joplin sync || { log "Initial seed sync failed — aborting"; exit 1; }

# Idempotency: if the notebook already exists (re-run), skip creation.
ROOT_JSON=$(joplin ls / -f json) || { log "Could not list notebooks — aborting"; exit 1; }
EXISTING=$(printf '%s' "${ROOT_JSON}" | json_item_field title "${NOTEBOOK_TITLE}" id) || EXISTING=""
if [ -z "${EXISTING}" ]; then
  log "Creating notebook: ${NOTEBOOK_TITLE}"
  joplin mkbook "${NOTEBOOK_TITLE}"
  ROOT_JSON=$(joplin ls / -f json)
  NOTEBOOK_ID=$(printf '%s' "${ROOT_JSON}" | json_item_field title "${NOTEBOOK_TITLE}" id) || {
    log "Could not resolve created notebook id — aborting"; exit 1; }
else
  NOTEBOOK_ID="${EXISTING}"
  log "Notebook already exists: id=${NOTEBOOK_ID}"
fi

log "Selecting notebook: ${NOTEBOOK_TITLE}"
joplin use "${NOTEBOOK_TITLE}"

# Same JSON lookup as above; no-arg `ls -f json` lists the active notebook's
# notes (`ls -l .` is a no-op after `use` in CLI 3.7.1).
NOTES_JSON=$(joplin ls -f json) || { log "Could not list notes — aborting"; exit 1; }
EXISTING_NOTE=$(printf '%s' "${NOTES_JSON}" | json_item_field title "${NOTE_TITLE}" id) || EXISTING_NOTE=""
if [ -z "${EXISTING_NOTE}" ]; then
  log "Creating note: ${NOTE_TITLE}"
  joplin mknote "${NOTE_TITLE}"
  NOTES_JSON=$(joplin ls -f json)
  NOTE_ID=$(printf '%s' "${NOTES_JSON}" | json_item_field title "${NOTE_TITLE}" id) || {
    log "Could not resolve created note id — aborting"; exit 1; }
else
  NOTE_ID="${EXISTING_NOTE}"
  log "Note already exists: id=${NOTE_ID}"
fi

log "Setting note body (forcibly marks the note encrypted on next sync)"
joplin set "${NOTE_ID}" body "secret-content-${NOTE_TITLE}"

# Bounded wait for master-key propagation: the reporter saw the first
# `joplin e2ee decrypt` fail because of this; our flow is unaffected
# (we set the master password and enable E2EE BEFORE the first sync), but a
# short settle avoids race when the test server has just started.
log "Settling 2s for master-key propagation"
sleep 2

log "Syncing to push ciphertext to server"
joplin sync || { log "Seed final sync failed — aborting"; exit 1; }

# ---------------------------------------------------------------------------
# Post-sync verification (server truth): pull the fixture BACK from the
# server via the throwaway keyless profile and assert it is stored
# encrypted. The marker's `encrypted` value is DERIVED from this observation;
# if the assertion fails the script exits non-zero BEFORE any marker write,
# so a silently unencrypted seed can never produce a passing marker.
# ---------------------------------------------------------------------------
log "Verifying ciphertext reached the server (throwaway keyless profile)"
rm -rf "${VERIFY_HOME}"
mkdir -p "${VERIFY_HOME}"
HOME="${VERIFY_HOME}" joplin config sync.target 10 >/dev/null
HOME="${VERIFY_HOME}" joplin config "sync.10.path" "${JOPLIN_SERVER_URL}" >/dev/null
HOME="${VERIFY_HOME}" joplin config "sync.10.username" "${JOPLIN_USERNAME}" >/dev/null
HOME="${VERIFY_HOME}" joplin config "sync.10.password" "${JOPLIN_PASSWORD}" >/dev/null

ENCRYPTED="false"
NB_ENC=""
NB_CIPHER=""
NOTE_ENC=""
for attempt in $(seq 1 "${VERIFY_ATTEMPTS}"); do
  if V_SYNC_OUT=$(HOME="${VERIFY_HOME}" joplin sync 2>&1); then
    V_ROOT_JSON=$(HOME="${VERIFY_HOME}" joplin ls / -f json 2>/dev/null) || V_ROOT_JSON=""
    NB_ENC=$(printf '%s' "${V_ROOT_JSON}" | json_item_field id "${NOTEBOOK_ID}" encryption_applied) || NB_ENC=""
    NB_CIPHER=$(printf '%s' "${V_ROOT_JSON}" | json_item_field id "${NOTEBOOK_ID}" encryption_cipher_text) || NB_CIPHER=""
    HOME="${VERIFY_HOME}" joplin use "${NOTEBOOK_ID}" >/dev/null 2>&1 || true
    V_NOTES_JSON=$(HOME="${VERIFY_HOME}" joplin ls -f json 2>/dev/null) || V_NOTES_JSON=""
    NOTE_ENC=$(printf '%s' "${V_NOTES_JSON}" | json_item_field id "${NOTE_ID}" encryption_applied) || NOTE_ENC=""
    if [ "${NB_ENC}" = "1" ] && [ -n "${NB_CIPHER}" ] && [ "${NOTE_ENC}" = "1" ]; then
      ENCRYPTED="true"
      break
    fi
    log "Attempt ${attempt}/${VERIFY_ATTEMPTS}: fixture not yet encrypted on server (notebook enc='${NB_ENC:-none}' cipher_nonempty=$([ -n "${NB_CIPHER}" ] && echo yes || echo no) note enc='${NOTE_ENC:-none}')"
    sleep 2
  else
    # Joplin Server rate-limits POST /api/sessions per client IP ("Too many
    # login attempts. Please try again in N seconds."); a seeder that runs
    # right after a previous seeding client on the same IP can trip it. The
    # server states the remaining lockout — honor it instead of busy-retrying.
    RETRY_IN=$(printf '%s' "${V_SYNC_OUT}" | grep -oE 'try again in [0-9]+ seconds' | grep -oE '[0-9]+' | head -1)
    WAIT_SEC=$(( ${RETRY_IN:-5} + 2 ))
    log "Verify sync attempt ${attempt}/${VERIFY_ATTEMPTS} failed: $(printf '%s' "${V_SYNC_OUT}" | tr '\n' ' ' | tail -c 300); retrying in ${WAIT_SEC}s"
    sleep "${WAIT_SEC}"
  fi
done

if [ "${ENCRYPTED}" != "true" ]; then
  log "ERROR: fixture is NOT encrypted on the server after ${VERIFY_ATTEMPTS} attempts (notebook encryption_applied='${NB_ENC:-none}', cipher_text nonempty=$([ -n "${NB_CIPHER}" ] && echo yes || echo no), note encryption_applied='${NOTE_ENC:-none}')"
  log "ERROR: refusing to write a passing marker — aborting"
  exit 1
fi
log "Verified encrypted on server: notebook enc=1 with non-empty cipher_text, note enc=1"

# Write a seed-time marker file for M1-T3's mechanism-validation gate.
# This is the escape hatch when the Joplin Server REST API does NOT expose
# the items' encryption state (Gap 3 — assigned to M1-T1).
MARKER_DIR="${HOME}/.config/joplin"
mkdir -p "${MARKER_DIR}"
cat > "${MARKER_DIR}/.e2ee-seed-marker.json" <<EOF
{
  "notebook_title": "${NOTEBOOK_TITLE}",
  "notebook_id": "${NOTEBOOK_ID}",
  "note_title": "${NOTE_TITLE}",
  "note_id": "${NOTE_ID}",
  "encrypted": ${ENCRYPTED},
  "seeded_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}
EOF
log "Marker written: ${MARKER_DIR}/.e2ee-seed-marker.json (encrypted=${ENCRYPTED})"

# ---------------------------------------------------------------------------
# Phase 2: resync fixtures (see header comment). Runs only when both env vars
# are set. Mirror of the base flow: create at the E2EE-enabled source client,
# push, verify ciphertext on the server via a fresh keyless profile, then —
# and only then — write the marker.
# ---------------------------------------------------------------------------
if [ -n "${E2EE_RESYNC_NOTEBOOK_TITLE}" ] && [ -n "${E2EE_RESYNC_NOTE_TITLE}" ]; then
  log "Phase 2: creating resync fixtures: notebook '${E2EE_RESYNC_NOTEBOOK_TITLE}', note '${E2EE_RESYNC_NOTE_TITLE}'"

  ROOT_JSON=$(joplin ls / -f json) || { log "Phase 2: could not list notebooks — aborting"; exit 1; }
  RESYNC_NB_ID=$(printf '%s' "${ROOT_JSON}" | json_item_field title "${E2EE_RESYNC_NOTEBOOK_TITLE}" id) || RESYNC_NB_ID=""
  if [ -z "${RESYNC_NB_ID}" ]; then
    log "Phase 2: creating notebook: ${E2EE_RESYNC_NOTEBOOK_TITLE}"
    joplin mkbook "${E2EE_RESYNC_NOTEBOOK_TITLE}"
    ROOT_JSON=$(joplin ls / -f json)
    RESYNC_NB_ID=$(printf '%s' "${ROOT_JSON}" | json_item_field title "${E2EE_RESYNC_NOTEBOOK_TITLE}" id) || {
      log "Phase 2: could not resolve created notebook id — aborting"; exit 1; }
  else
    log "Phase 2: resync notebook already exists: id=${RESYNC_NB_ID}"
  fi

  joplin use "${RESYNC_NB_ID}" || { log "Phase 2: could not select resync notebook — aborting"; exit 1; }
  NOTES_JSON=$(joplin ls -f json) || { log "Phase 2: could not list notes — aborting"; exit 1; }
  RESYNC_NOTE_ID=$(printf '%s' "${NOTES_JSON}" | json_item_field title "${E2EE_RESYNC_NOTE_TITLE}" id) || RESYNC_NOTE_ID=""
  if [ -z "${RESYNC_NOTE_ID}" ]; then
    log "Phase 2: creating note: ${E2EE_RESYNC_NOTE_TITLE}"
    joplin mknote "${E2EE_RESYNC_NOTE_TITLE}"
    NOTES_JSON=$(joplin ls -f json)
    RESYNC_NOTE_ID=$(printf '%s' "${NOTES_JSON}" | json_item_field title "${E2EE_RESYNC_NOTE_TITLE}" id) || {
      log "Phase 2: could not resolve created note id — aborting"; exit 1; }
  else
    log "Phase 2: resync note already exists: id=${RESYNC_NOTE_ID}"
  fi
  joplin set "${RESYNC_NOTE_ID}" body "secret-content-${E2EE_RESYNC_NOTE_TITLE}"

  log "Phase 2: settling 2s, then syncing to push ciphertext to server"
  sleep 2
  joplin sync || { log "Phase 2: seed sync failed — aborting"; exit 1; }

  # Fresh throwaway keyless profile: proves the PHASE-2 ciphertext is on the
  # server (same mechanism and rate-limit handling as the base verification).
  log "Phase 2: verifying ciphertext reached the server (throwaway keyless profile)"
  rm -rf "${VERIFY_HOME}"
  mkdir -p "${VERIFY_HOME}"
  HOME="${VERIFY_HOME}" joplin config sync.target 10 >/dev/null
  HOME="${VERIFY_HOME}" joplin config "sync.10.path" "${JOPLIN_SERVER_URL}" >/dev/null
  HOME="${VERIFY_HOME}" joplin config "sync.10.username" "${JOPLIN_USERNAME}" >/dev/null
  HOME="${VERIFY_HOME}" joplin config "sync.10.password" "${JOPLIN_PASSWORD}" >/dev/null

  RESYNC_ENCRYPTED="false"
  R_NB_ENC=""
  R_NOTE_ENC=""
  for attempt in $(seq 1 "${VERIFY_ATTEMPTS}"); do
    if R_SYNC_OUT=$(HOME="${VERIFY_HOME}" joplin sync 2>&1); then
      V_ROOT_JSON=$(HOME="${VERIFY_HOME}" joplin ls / -f json 2>/dev/null) || V_ROOT_JSON=""
      R_NB_ENC=$(printf '%s' "${V_ROOT_JSON}" | json_item_field id "${RESYNC_NB_ID}" encryption_applied) || R_NB_ENC=""
      HOME="${VERIFY_HOME}" joplin use "${RESYNC_NB_ID}" >/dev/null 2>&1 || true
      V_NOTES_JSON=$(HOME="${VERIFY_HOME}" joplin ls -f json 2>/dev/null) || V_NOTES_JSON=""
      R_NOTE_ENC=$(printf '%s' "${V_NOTES_JSON}" | json_item_field id "${RESYNC_NOTE_ID}" encryption_applied) || R_NOTE_ENC=""
      if [ "${R_NB_ENC}" = "1" ] && [ "${R_NOTE_ENC}" = "1" ]; then
        RESYNC_ENCRYPTED="true"
        break
      fi
      log "Phase 2 attempt ${attempt}/${VERIFY_ATTEMPTS}: fixtures not yet encrypted on server (notebook enc='${R_NB_ENC:-none}' note enc='${R_NOTE_ENC:-none}')"
      sleep 2
    else
      RETRY_IN=$(printf '%s' "${R_SYNC_OUT}" | grep -oE 'try again in [0-9]+ seconds' | grep -oE '[0-9]+' | head -1)
      WAIT_SEC=$(( ${RETRY_IN:-5} + 2 ))
      log "Phase 2 verify sync attempt ${attempt}/${VERIFY_ATTEMPTS} failed: $(printf '%s' "${R_SYNC_OUT}" | tr '\n' ' ' | tail -c 300); retrying in ${WAIT_SEC}s"
      sleep "${WAIT_SEC}"
    fi
  done

  if [ "${RESYNC_ENCRYPTED}" != "true" ]; then
    log "ERROR: phase-2 fixtures are NOT encrypted on the server after ${VERIFY_ATTEMPTS} attempts (notebook enc='${R_NB_ENC:-none}', note enc='${R_NOTE_ENC:-none}')"
    log "ERROR: refusing to write a passing resync marker — aborting"
    exit 1
  fi
  log "Phase 2 verified encrypted on server: notebook enc=1, note enc=1"

  cat > "${MARKER_DIR}/.e2ee-resync-marker.json" <<EOF
{
  "notebook_title": "${E2EE_RESYNC_NOTEBOOK_TITLE}",
  "notebook_id": "${RESYNC_NB_ID}",
  "note_title": "${E2EE_RESYNC_NOTE_TITLE}",
  "note_id": "${RESYNC_NOTE_ID}",
  "note_body": "secret-content-${E2EE_RESYNC_NOTE_TITLE}",
  "encrypted": ${RESYNC_ENCRYPTED},
  "seeded_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}
EOF
  log "Phase 2 marker written: ${MARKER_DIR}/.e2ee-resync-marker.json (encrypted=${RESYNC_ENCRYPTED})"
fi

log "Seed complete; exiting 0"
exit 0
