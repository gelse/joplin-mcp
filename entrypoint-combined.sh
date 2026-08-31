#!/bin/bash
set -euo pipefail

# =============================================================================
# Combined single-container entrypoint — joplin-core + joplin-mcp
# =============================================================================
# Consolidates entrypoint-core.sh + entrypoint-mcp.sh into one process.
#
# Signal flow:
#   docker stop → init sends SIGTERM → bash trap fires cleanup()
#     → kill periodic-sync loop (own process group, drain bounded ~10 s)
#     → send SIGTERM to MCP child (Node) and wait briefly for graceful close
#     → if Data API is still alive: stop it, then perform final joplin sync
#     → if Data API already died: skip final sync (would fail over loopback)
#     → exit 0
#
# Liveness: a monitor loop waits on BOTH MCP_PID and JOPLIN_SERVER_PID.
# If either child dies, we log which one failed, run cleanup, and exit non-zero
# so Docker's restart policy kicks in.
#
# The Data API binds to 127.0.0.1:${JOPLIN_DATA_API_PORT} (loopback-only).
# Joplin CLI hardcodes 127.0.0.1 in ClipperServer.ts; no proxy is needed
# because both the MCP server and the sync loop run inside the same container.
# =============================================================================

LOG_DIR="/var/log/joplin"
LOG_FILE="${LOG_DIR}/joplin-core.log"
SYNC_LOG_FILE="${LOG_DIR}/sync.log"

# Ensure log directory exists (should be created in Dockerfile, but be safe)
mkdir -p "${LOG_DIR}"

# -----------------------------------------------------------------------------
# Logging function — writes to both stderr (Docker logs) and log file
# -----------------------------------------------------------------------------
log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp
    timestamp="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    local line="[${timestamp}] [${level}] ${message}"
    echo "${line}" >&2
    echo "${line}" >> "${LOG_FILE}"
}

# -----------------------------------------------------------------------------
# Log sync events to a dedicated sync log file
# -----------------------------------------------------------------------------
log_sync() {
    local status="$1"
    shift
    local message="$*"
    local timestamp
    timestamp="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    local line="[${timestamp}] [SYNC_${status}] ${message}"
    echo "${line}" >&2
    echo "${line}" >> "${SYNC_LOG_FILE}"
}

# -----------------------------------------------------------------------------
# Check log files for sync error patterns
# Returns 0 if no errors found, 1 if error patterns detected
# Usage: check_sync_errors <label> [log_offset]
# -----------------------------------------------------------------------------
check_sync_errors() {
    local label="$1"
    local log_offset="${2:-0}"
    local combined_pattern='\[error\]|There was some errors|Could not encrypt item|Master key is not loaded'

    local files=(
        "${LOG_DIR}/log.txt"
        "${LOG_DIR}/sync-stdout.log"
        "${LOG_DIR}/sync-stderr.log"
    )

    local match=false
    for f in "${files[@]}"; do
        if [ ! -f "${f}" ]; then
            if [ "${f}" = "${LOG_DIR}/log.txt" ]; then
                log "WARN" "[${label}] ${f} not found — sync error detection limited to stdout/stderr logs"
            fi
            continue
        fi

        if [ "${f}" = "${LOG_DIR}/log.txt" ] && [ "${log_offset}" -gt 0 ]; then
            if grep -i -q -E "${combined_pattern}" <(tail -n +"${log_offset}" "${f}" 2>/dev/null) 2>/dev/null; then
                match=true
                break
            fi
        else
            if grep -i -q -E "${combined_pattern}" "${f}" 2>/dev/null; then
                match=true
                break
            fi
        fi
    done

    if [ "${match}" = true ]; then
        log "WARN" "[${label}] Sync log files contain error patterns — sync may have encountered issues despite exit code 0"
        return 1
    fi

    return 0
}

# -----------------------------------------------------------------------------
# Validate required environment variables (from core entrypoint)
# -----------------------------------------------------------------------------
log "INFO" "============================================="
log "INFO" "joplin combined container starting"
log "INFO" "============================================="

REQUIRED_VARS=("JOPLIN_SERVER_URL" "JOPLIN_USERNAME" "JOPLIN_PASSWORD")
MISSING=()

for VAR in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!VAR:-}" ]; then
        MISSING+=("$VAR")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    log "ERROR" "Missing required environment variables: ${MISSING[*]}"
    log "ERROR" "Please set JOPLIN_SERVER_URL, JOPLIN_USERNAME, and JOPLIN_PASSWORD"
    exit 1
fi

# --- Set defaults ---
JOPLIN_DATA_API_PORT="${JOPLIN_DATA_API_PORT:-41184}"
SYNC_INTERVAL_SECONDS="${SYNC_INTERVAL_SECONDS:-300}"
LOG_LEVEL="${LOG_LEVEL:-info}"
# Canonicalize MCP port — the container always binds to 3000.
# env_file may inject a non-3000 MCP_PORT from .env; ignore it.
if [ "${MCP_PORT:-3000}" != "3000" ]; then
    log "WARN" "MCP_PORT is set to '${MCP_PORT}' via env_file — ignoring (container always listens on 3000; use MCP_HOST_PORT for host mapping)"
fi
MCP_PORT=3000

# The Data API binds directly to this port — no offset needed.
# In the old two-container setup a TCP proxy forwarded from the public
# port to an internal port (+1). Now the CLI listens on the same port
# that is exposed.
JOPLIN_INTERNAL_PORT="${JOPLIN_DATA_API_PORT}"

log "INFO" "Configuration:"
log "INFO" "  Joplin Server URL: ${JOPLIN_SERVER_URL}"
log "INFO" "  Data API Port: ${JOPLIN_DATA_API_PORT}"
log "INFO" "  MCP Port: ${MCP_PORT}"
log "INFO" "  Log Level: ${LOG_LEVEL}"
log "INFO" "  Sync Interval: ${SYNC_INTERVAL_SECONDS}s"
log "INFO" "  Log File: ${LOG_FILE}"
log "INFO" "  Sync Log File: ${SYNC_LOG_FILE}"

# -----------------------------------------------------------------------------
# Configure Joplin CLI for server sync
# -----------------------------------------------------------------------------
log "INFO" "Configuring Joplin CLI sync target..."

joplin config sync.target 10
joplin config "sync.10.path" "${JOPLIN_SERVER_URL}"
joplin config "sync.10.username" "${JOPLIN_USERNAME}"
joplin config "sync.10.password" "${JOPLIN_PASSWORD}"

log "INFO" "Joplin CLI sync target configured (server reachability will be checked after API token is obtained)"

# -----------------------------------------------------------------------------
# Export env vars for Joplin CLI (JOPLIN_API_TOKEN exported later after
# Data API starts — the server generates the token on first boot).
# -----------------------------------------------------------------------------
export JOPLIN_SERVER_URL
export JOPLIN_USERNAME
export JOPLIN_PASSWORD
export JOPLIN_DATA_API_PORT
export LOG_LEVEL

# -----------------------------------------------------------------------------
# Start Joplin Data API with retry loop (loopback-only)
# -----------------------------------------------------------------------------
# The Data API binds directly to 127.0.0.1:${JOPLIN_INTERNAL_PORT} which
# equals ${JOPLIN_DATA_API_PORT}. No proxy is needed.

log "INFO" "Configuring Joplin Data API to listen on 127.0.0.1:${JOPLIN_INTERNAL_PORT}..."
joplin config api.port "${JOPLIN_INTERNAL_PORT}"

log "INFO" "Starting Joplin Data API (127.0.0.1:${JOPLIN_INTERNAL_PORT})..."
nohup joplin server start \
    > "${LOG_DIR}/joplin-server-stdout.log" 2> "${LOG_DIR}/joplin-server-stderr.log" &
JOPLIN_SERVER_PID=$!

log "INFO" "Joplin Data API process started (PID: ${JOPLIN_SERVER_PID})"

# --- Retry loop: wait for Data API to become healthy ---
MAX_RETRIES=30
RETRY_DELAY=2
HEALTH_CHECK_URL="http://127.0.0.1:${JOPLIN_INTERNAL_PORT}/ping"

log "INFO" "Waiting for Data API to become healthy (max ${MAX_RETRIES} attempts, ${RETRY_DELAY}s apart)..."

DATA_API_HEALTHY=false
for i in $(seq 1 ${MAX_RETRIES}); do
    if curl -s -f "${HEALTH_CHECK_URL}" > /dev/null 2>&1; then
        log "INFO" "Data API is healthy (attempt ${i}/${MAX_RETRIES})"
        DATA_API_HEALTHY=true
        break
    fi

    if [ "${i}" -eq "${MAX_RETRIES}" ]; then
        log "ERROR" "Data API failed to become healthy after ${MAX_RETRIES} attempts"
        log "ERROR" "Last 50 lines of Data API stderr log:"
        tail -n 50 "${LOG_DIR}/joplin-server-stderr.log" >&2
        log "ERROR" "Last 50 lines of Data API stdout log:"
        tail -n 50 "${LOG_DIR}/joplin-server-stdout.log" >&2
        log "ERROR" "Last 50 lines of core log:"
        tail -n 50 "${LOG_FILE}" >&2
        exit 1
    fi

    log "WARN" "Data API not ready yet (attempt ${i}/${MAX_RETRIES}), retrying in ${RETRY_DELAY}s..."
    sleep "${RETRY_DELAY}"
done

if [ "${DATA_API_HEALTHY}" != true ]; then
    log "ERROR" "Data API never became healthy — cannot start MCP server"
    exit 1
fi

log "INFO" "Joplin Data API is running and healthy on 127.0.0.1:${JOPLIN_INTERNAL_PORT}"

# -----------------------------------------------------------------------------
# Extract API token from Joplin config
# The Data API generates the token on first boot and writes it to
# settings.json, so we must extract it AFTER the server is healthy.
# If JOPLIN_API_TOKEN is already set (e.g. via .env), honour it directly.
# -----------------------------------------------------------------------------
log "INFO" "Reading Joplin API token..."

if [ -z "${JOPLIN_API_TOKEN:-}" ]; then
    # The Data API may still be writing settings.json — retry a few times.
    TOKEN_MAX_RETRIES=10
    TOKEN_RETRY_DELAY=2
    for t in $(seq 1 ${TOKEN_MAX_RETRIES}); do
        _RAW_TOKEN=$(joplin config api.token 2>/dev/null || true)
        # `joplin config` outputs "api.token = <value>" — strip the prefix.
        JOPLIN_API_TOKEN="${_RAW_TOKEN#api.token = }"
        if [ -n "${JOPLIN_API_TOKEN:-}" ]; then
            break
        fi
        # Fallback: read directly from settings.json
        if [ -f /home/joplin/.config/joplin/settings.json ]; then
            JOPLIN_API_TOKEN=$(grep -o '"api\.token"[[:space:]]*:[[:space:]]*"[^"]*"' /home/joplin/.config/joplin/settings.json | grep -o '[^"]*"$' | tr -d '"' || true)
            if [ -n "${JOPLIN_API_TOKEN:-}" ]; then
                break
            fi
        fi
        if [ "${t}" -eq "${TOKEN_MAX_RETRIES}" ]; then
            log "ERROR" "Could not read Joplin API token after ${TOKEN_MAX_RETRIES} attempts"
            log "ERROR" "Ensure Joplin CLI is authenticated with the server"
            exit 1
        fi
        log "WARN" "API token not ready yet (attempt ${t}/${TOKEN_MAX_RETRIES}), retrying in ${TOKEN_RETRY_DELAY}s..."
        sleep "${TOKEN_RETRY_DELAY}"
    done
    log "INFO" "Joplin API token extracted from Joplin CLI config"
else
    log "INFO" "Using pre-set Joplin API token from environment"
fi

export JOPLIN_API_TOKEN

# -----------------------------------------------------------------------------
# Probe Joplin Server connectivity
# -----------------------------------------------------------------------------
log "INFO" "Probing Joplin Server connectivity..."
if curl -sf --connect-timeout 5 --max-time 10 "${JOPLIN_SERVER_URL}/api/ping?token=${JOPLIN_API_TOKEN}" -o /dev/null 2>/dev/null; then
    log "INFO" "Joplin Server is reachable at ${JOPLIN_SERVER_URL}"
else
    log "WARN" "Joplin Server not reachable at ${JOPLIN_SERVER_URL} — sync may fail"
    log "WARN" "This is expected if the server is temporarily unavailable or the token is incorrect"
fi

# -----------------------------------------------------------------------------
# Periodic sync loop (same as core entrypoint)
# -----------------------------------------------------------------------------
log "INFO" "Starting periodic sync loop (interval: ${SYNC_INTERVAL_SECONDS}s)..."

# Perform an initial sync immediately
log_sync "START" "Performing initial sync..."
LOG_TAIL_START=$(( $(wc -l < "${LOG_DIR}/log.txt" 2>/dev/null || echo 0) + 1 ))
SYNC_EXIT=0
joplin sync > "${LOG_DIR}/sync-stdout.log" 2> "${LOG_DIR}/sync-stderr.log" || SYNC_EXIT=$?

if [ "${SYNC_EXIT}" -ne 0 ]; then
    log_sync "FAIL" "Initial sync failed (exit code: ${SYNC_EXIT})"
    log "ERROR" "Sync stderr output:"
    cat "${LOG_DIR}/sync-stderr.log" >&2
    log "ERROR" "Last 20 lines of Joplin log (log.txt):"
    tail -n 20 "${LOG_DIR}/log.txt" >&2 || log "WARN" "log.txt not found or empty"
elif ! check_sync_errors "Initial" "${LOG_TAIL_START}"; then
    log_sync "FAIL" "Initial sync reported errors despite exit code 0"
else
    log_sync "PASS" "Initial sync completed successfully"
fi

# Start periodic sync loop in its own process group so cleanup() can kill
# the whole group (subshell + any in-flight joplin sync child) atomically.
#
# `bash -c` children do not inherit shell functions or non-exported variables,
# so we must export everything the loop body references:
#   - variables: SYNC_INTERVAL_SECONDS, LOG_DIR, LOG_FILE, SYNC_LOG_FILE
#   - functions: log, log_sync, check_sync_errors
export SYNC_INTERVAL_SECONDS LOG_DIR LOG_FILE SYNC_LOG_FILE
export -f log log_sync check_sync_errors
setsid bash -c '
    while true; do
        sleep "${SYNC_INTERVAL_SECONDS}"

        log_sync "START" "Starting periodic sync..."
        SYNC_STDOUT="${LOG_DIR}/sync-stdout.log"
        SYNC_STDERR="${LOG_DIR}/sync-stderr.log"

        LOG_TAIL_START=$(( $(wc -l < "${LOG_DIR}/log.txt" 2>/dev/null || echo 0) + 1 ))
        SYNC_EXIT=0
        joplin sync > "${SYNC_STDOUT}" 2> "${SYNC_STDERR}" || SYNC_EXIT=$?

        if [ "${SYNC_EXIT}" -ne 0 ]; then
            log_sync "FAIL" "Periodic sync failed (exit code: ${SYNC_EXIT})"
            log "ERROR" "Sync stderr output (exit code ${SYNC_EXIT}):"
            cat "${SYNC_STDERR}" >&2
            log "ERROR" "Last 20 lines of Joplin log (log.txt):"
            tail -n 20 "${LOG_DIR}/log.txt" >&2 || log "WARN" "log.txt not found or empty"
        elif ! check_sync_errors "Periodic" "${LOG_TAIL_START}"; then
            log_sync "FAIL" "Periodic sync reported errors despite exit code 0"
        else
            log_sync "PASS" "Periodic sync completed successfully"
        fi
    done
' &
SYNC_LOOP_PID=$!

log "INFO" "Periodic sync loop started (PID: ${SYNC_LOOP_PID}, own process group)"

# -----------------------------------------------------------------------------
# Start MCP HTTP server (Node.js, in background)
# -----------------------------------------------------------------------------
# Export env vars that the Node MCP process needs.
# JOPLIN_CORE_URL points at the Data API running in THIS container.
export JOPLIN_CORE_URL="http://127.0.0.1:${JOPLIN_INTERNAL_PORT}"
export JOPLIN_API_TOKEN
export LOG_LEVEL
export MCP_PORT

log "INFO" "Starting MCP HTTP server on port ${MCP_PORT} (JOPLIN_CORE_URL=${JOPLIN_CORE_URL})..."
node /app/dist/mcp/entry.js &
MCP_PID=$!

log "INFO" "MCP server process started (PID: ${MCP_PID})"

# -----------------------------------------------------------------------------
# Keep container alive and handle graceful shutdown
# -----------------------------------------------------------------------------
log "INFO" "============================================="
log "INFO" "joplin combined container is ready"
log "INFO" "  Data API: http://127.0.0.1:${JOPLIN_DATA_API_PORT} (loopback-only)"
log "INFO" "  MCP Server: http://0.0.0.0:${MCP_PORT}"
log "INFO" "  Sync interval: ${SYNC_INTERVAL_SECONDS}s"
log "INFO" "  Log file: ${LOG_FILE}"
log "INFO" "============================================="

cleanup() {
    [ "${CLEANUP_DONE:-0}" -eq 1 ] && return 0
    CLEANUP_DONE=1

    local signal="$1"
    log "INFO" "Received ${signal}, shutting down gracefully..."

    # 1. Kill the periodic sync loop AND any in-flight joplin sync child.
    #    The loop runs in its own process group (setsid), so we kill the
    #    whole group by sending SIGTERM to the negative PGID.
    if [ -n "${SYNC_LOOP_PID:-}" ] && kill -0 "${SYNC_LOOP_PID}" 2>/dev/null; then
        log "INFO" "Stopping sync loop (PID: ${SYNC_LOOP_PID}) and children..."
        kill -TERM -- -"${SYNC_LOOP_PID}" 2>/dev/null || true
        # Drain: wait up to 10 seconds for the group to exit
        waited=0
        while [ "${waited}" -lt 10 ] && kill -0 "${SYNC_LOOP_PID}" 2>/dev/null; do
            sleep 1
            waited=$((waited + 1))
        done
        if kill -0 "${SYNC_LOOP_PID}" 2>/dev/null; then
            log "WARN" "Sync loop did not exit within 10 s, sending SIGKILL to group"
            kill -KILL -- -"${SYNC_LOOP_PID}" 2>/dev/null || true
            sleep 1
        else
            log "INFO" "Sync loop and children exited cleanly"
        fi
        # Reap the setsid leader so the process group is fully gone before
        # we perform the final sync.
        wait "${SYNC_LOOP_PID}" 2>/dev/null || true
    fi

    # 2. Send SIGTERM to the MCP child process and wait briefly for graceful close.
    #    Node's own SIGTERM handler (see src/mcp/entry.ts) will close the HTTP
    #    server and exit within ~5 s.
    if [ -n "${MCP_PID:-}" ] && kill -0 "${MCP_PID}" 2>/dev/null; then
        log "INFO" "Sending SIGTERM to MCP server (PID: ${MCP_PID})..."
        kill -TERM "${MCP_PID}" 2>/dev/null || true
        waited=0
        while [ "${waited}" -lt 8 ] && kill -0 "${MCP_PID}" 2>/dev/null; do
            sleep 1
            waited=$((waited + 1))
        done
        if kill -0 "${MCP_PID}" 2>/dev/null; then
            log "WARN" "MCP server did not exit within 8 s, sending SIGKILL"
            kill -9 "${MCP_PID}" 2>/dev/null || true
        else
            log "INFO" "MCP server exited gracefully"
        fi
    fi

    # 3. Stop the Joplin Data API if it is still running.
    local data_api_alive=false
    if [ -n "${JOPLIN_SERVER_PID:-}" ] && kill -0 "${JOPLIN_SERVER_PID}" 2>/dev/null; then
        data_api_alive=true
        log "INFO" "Stopping Joplin Data API (PID: ${JOPLIN_SERVER_PID})..."
        kill "${JOPLIN_SERVER_PID}" 2>/dev/null || true
        # Give it a moment to close SQLite cleanly, then escalate to SIGKILL.
        #
        # Zombie race: after SIGTERM the process may die and become a zombie
        # before the drain loop reaps it.  `kill -0` succeeds on zombies, so
        # the loop may report "did not exit within 3 s" spuriously — this is
        # acceptable / best-effort; the single `wait` after escalation reaps
        # either way (zombie or killed).
        waited=0
        while [ "${waited}" -lt 3 ] && kill -0 "${JOPLIN_SERVER_PID}" 2>/dev/null; do
            sleep 1
            waited=$((waited + 1))
        done
        if kill -0 "${JOPLIN_SERVER_PID}" 2>/dev/null; then
            log "WARN" "Joplin Data API did not exit within 3 s, sending SIGKILL"
            kill -9 "${JOPLIN_SERVER_PID}" 2>/dev/null || true
        fi
        # Reap zombie or killed process (non-blocking in both cases).
        wait "${JOPLIN_SERVER_PID}" 2>/dev/null || true
        log "INFO" "Joplin Data API stopped"
    fi

    # 4. Final sync before exit (matches entrypoint-core.sh shutdown semantics).
    #    Skip if the Data API already died — a final sync over loopback would fail.
    if [ "${data_api_alive}" = true ]; then
        log_sync "START" "Performing final sync before shutdown..."
        if joplin sync > /dev/null 2>&1; then
            log_sync "PASS" "Final sync completed successfully"
        else
            log_sync "FAIL" "Final sync failed"
        fi
    else
        log "WARN" "Skipping final sync — Data API is not running"
    fi

    log "INFO" "Shutdown complete"
}

# --- Liveness monitor -------------------------------------------------------
# Wait for EITHER child to exit.  If one dies, we log clearly, run cleanup
# for the survivor(s), and exit non-zero so the Docker restart policy kicks in.
trap 'cleanup SIGTERM' SIGTERM
trap 'cleanup SIGINT' SIGINT

EXIT_CODE=0
while true; do
    # wait -n -p (bash ≥5.1) returns when any one of the listed PIDs finishes
    # and stores the actual exited PID in WAIT_PID.
    # The entrypoint shebang is #!/bin/bash and the image ships bash 5.2.
    WAIT_PID=""
    WAIT_STATUS=""
    wait -n -p WAIT_PID "${MCP_PID}" "${JOPLIN_SERVER_PID}" 2>/dev/null || WAIT_STATUS=$?

    if [ "${WAIT_PID}" = "${MCP_PID}" ]; then
        log "ERROR" "MCP server (PID: ${MCP_PID}) exited unexpectedly (wait status: ${WAIT_STATUS:-?})"
        EXIT_CODE=1
        # Gracefully stop the surviving Data API
        if [ -n "${JOPLIN_SERVER_PID:-}" ] && kill -0 "${JOPLIN_SERVER_PID}" 2>/dev/null; then
            log "INFO" "Sending SIGTERM to surviving Data API (PID: ${JOPLIN_SERVER_PID})..."
            kill -TERM "${JOPLIN_SERVER_PID}" 2>/dev/null || true
            waited=0
            while [ "${waited}" -lt 5 ] && kill -0 "${JOPLIN_SERVER_PID}" 2>/dev/null; do
                sleep 1
                waited=$((waited + 1))
            done
            if kill -0 "${JOPLIN_SERVER_PID}" 2>/dev/null; then
                kill -9 "${JOPLIN_SERVER_PID}" 2>/dev/null || true
            fi
        fi
    elif [ "${WAIT_PID}" = "${JOPLIN_SERVER_PID}" ]; then
        log "ERROR" "Data API (PID: ${JOPLIN_SERVER_PID}) exited unexpectedly (wait status: ${WAIT_STATUS:-?})"
        EXIT_CODE=1
        # Gracefully stop the surviving MCP server
        if [ -n "${MCP_PID:-}" ] && kill -0 "${MCP_PID}" 2>/dev/null; then
            log "INFO" "Sending SIGTERM to surviving MCP server (PID: ${MCP_PID})..."
            kill -TERM "${MCP_PID}" 2>/dev/null || true
            waited=0
            while [ "${waited}" -lt 5 ] && kill -0 "${MCP_PID}" 2>/dev/null; do
                sleep 1
                waited=$((waited + 1))
            done
            if kill -0 "${MCP_PID}" 2>/dev/null; then
                kill -9 "${MCP_PID}" 2>/dev/null || true
            fi
        fi
    fi

    # Run cleanup for the sync loop, final sync, etc.
    cleanup "CHILD_EXIT"
    exit "${EXIT_CODE}"
done
