#!/bin/bash
set -euo pipefail

# =============================================================================
# Combined single-container entrypoint — joplin-core + joplin-mcp
# =============================================================================
# Consolidates entrypoint-core.sh + entrypoint-mcp.sh into one process.
#
# Signal flow:
#   docker stop → init sends SIGTERM → bash trap fires cleanup()
#     → kill periodic-sync loop
#     → send SIGTERM to MCP child (Node) and wait briefly for graceful close
#     → perform final joplin sync
#     → exit 0
#
# The Data API binds directly to 0.0.0.0:${JOPLIN_DATA_API_PORT} (no socat,
# no internal-port offset) since Joplin CLI now accepts api.port for binding.
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
MCP_PORT="${MCP_PORT:-3000}"

# The Data API binds directly to this port — no socat, no +1 offset.
# In the old two-container setup a socat proxy forwarded from the public
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
# Extract API token from Joplin config
# -----------------------------------------------------------------------------
log "INFO" "Reading Joplin API token..."

JOPLIN_API_TOKEN=$(joplin config api.token 2>/dev/null || true)
if [ -z "${JOPLIN_API_TOKEN:-}" ]; then
    # Fallback: read directly from settings.json
    if [ -f /home/joplin/.config/joplin/settings.json ]; then
        JOPLIN_API_TOKEN=$(grep -o '"api\.token"[[:space:]]*:[[:space:]]*"[^"]*"' /home/joplin/.config/joplin/settings.json | grep -o '[^"]*"$' | tr -d '"' || true)
    fi
fi
if [ -z "${JOPLIN_API_TOKEN:-}" ]; then
    log "ERROR" "Could not read Joplin API token from config or settings.json"
    log "ERROR" "Ensure Joplin CLI is authenticated with the server"
    exit 1
fi
log "INFO" "Joplin API token obtained successfully"
# NOTE: This token is consumed in-container by the MCP server process.
# No operator copy/paste is needed in the combined container.
echo "========================================================="
echo "  Joplin API Token (consumed in-container by MCP server): $JOPLIN_API_TOKEN"
echo "========================================================="

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
# Export env vars for Joplin CLI
# -----------------------------------------------------------------------------
export JOPLIN_SERVER_URL
export JOPLIN_USERNAME
export JOPLIN_PASSWORD
export JOPLIN_DATA_API_PORT
export JOPLIN_API_TOKEN
export LOG_LEVEL

# -----------------------------------------------------------------------------
# Start Joplin Data API with retry loop (no socat)
# -----------------------------------------------------------------------------
# The Data API binds directly to 127.0.0.1:${JOPLIN_INTERNAL_PORT} which
# equals ${JOPLIN_DATA_API_PORT}. No socat proxy is needed.

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

# Start periodic sync loop in the background
(
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
) &
SYNC_LOOP_PID=$!

log "INFO" "Periodic sync loop started (PID: ${SYNC_LOOP_PID})"

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
log "INFO" "  Data API: http://0.0.0.0:${JOPLIN_DATA_API_PORT}"
log "INFO" "  MCP Server: http://0.0.0.0:${MCP_PORT}"
log "INFO" "  Sync interval: ${SYNC_INTERVAL_SECONDS}s"
log "INFO" "  Log file: ${LOG_FILE}"
log "INFO" "============================================="

cleanup() {
    local signal="$1"
    log "INFO" "Received ${signal}, shutting down gracefully..."

    # 1. Kill the periodic sync loop
    if [ -n "${SYNC_LOOP_PID:-}" ] && kill -0 "${SYNC_LOOP_PID}" 2>/dev/null; then
        kill "${SYNC_LOOP_PID}" 2>/dev/null || true
        log "INFO" "Sync loop stopped"
    fi

    # 2. Send SIGTERM to the MCP child process and wait briefly for graceful close.
    #    Node's own SIGTERM handler (see src/mcp/entry.ts) will close the HTTP
    #    server and exit within ~5 s.
    if [ -n "${MCP_PID:-}" ] && kill -0 "${MCP_PID}" 2>/dev/null; then
        log "INFO" "Sending SIGTERM to MCP server (PID: ${MCP_PID})..."
        kill -TERM "${MCP_PID}" 2>/dev/null || true
        # Wait up to 8 seconds for Node to shut down gracefully
        local waited=0
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

    # 3. Kill the Joplin Data API server
    if [ -n "${JOPLIN_SERVER_PID:-}" ] && kill -0 "${JOPLIN_SERVER_PID}" 2>/dev/null; then
        kill "${JOPLIN_SERVER_PID}" 2>/dev/null || true
        log "INFO" "Joplin Data API server stopped"
    fi

    # 4. Final sync before exit (matches entrypoint-core.sh shutdown semantics)
    log_sync "START" "Performing final sync before shutdown..."
    if joplin sync > /dev/null 2>&1; then
        log_sync "PASS" "Final sync completed successfully"
    else
        log_sync "FAIL" "Final sync failed"
    fi

    log "INFO" "Shutdown complete"
    exit 0
}

trap 'cleanup SIGTERM' SIGTERM
trap 'cleanup SIGINT' SIGINT

# Wait for the MCP server process (foreground behavior).
# If the MCP server exits unexpectedly, the container will stop.
wait "${MCP_PID}"
