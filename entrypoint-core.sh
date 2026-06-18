#!/bin/bash
set -euo pipefail

# =============================================================================
# Container A: joplin-core — Entrypoint Script
# =============================================================================
# Validates environment, configures Joplin CLI for server sync, starts the
# Joplin Data API with a retry loop, then runs a periodic sync loop.
# All output is logged with timestamps to both console (stderr) and log files.
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
# Validate required environment variables
# -----------------------------------------------------------------------------
log "INFO" "============================================="
log "INFO" "joplin-core container starting"
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

log "INFO" "Configuration:"
log "INFO" "  Joplin Server URL: ${JOPLIN_SERVER_URL}"
# REMOVED: log "INFO" "  Joplin Username: ${JOPLIN_USERNAME}"
log "INFO" "  Data API Port: ${JOPLIN_DATA_API_PORT}"
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

log "INFO" "Joplin CLI sync configured successfully"

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
# Start Joplin Data API with retry loop
# -----------------------------------------------------------------------------
log "INFO" "Starting Joplin Data API on 0.0.0.0:${JOPLIN_DATA_API_PORT}..."

# Start Joplin Data API in the background
# Bind to 0.0.0.0 so Container B can reach it on the Docker network
nohup joplin server start --host 0.0.0.0 --port "${JOPLIN_DATA_API_PORT}" \
    > "${LOG_DIR}/joplin-server-stdout.log" 2> "${LOG_DIR}/joplin-server-stderr.log" &
JOPLIN_SERVER_PID=$!

log "INFO" "Joplin Data API process started (PID: ${JOPLIN_SERVER_PID})"

# --- Retry loop: wait for Data API to become healthy ---
MAX_RETRIES=30
RETRY_DELAY=2
HEALTH_CHECK_URL="http://127.0.0.1:${JOPLIN_DATA_API_PORT}/ping"

log "INFO" "Waiting for Data API to become healthy (max ${MAX_RETRIES} attempts, ${RETRY_DELAY}s apart)..."

for i in $(seq 1 ${MAX_RETRIES}); do
    if curl -s -f "${HEALTH_CHECK_URL}" > /dev/null 2>&1; then
        log "INFO" "Data API is healthy (attempt ${i}/${MAX_RETRIES})"
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

log "INFO" "Joplin Data API is running and healthy on 0.0.0.0:${JOPLIN_DATA_API_PORT}"

# -----------------------------------------------------------------------------
# Periodic sync loop
# -----------------------------------------------------------------------------
log "INFO" "Starting periodic sync loop (interval: ${SYNC_INTERVAL_SECONDS}s)..."

# Perform an initial sync immediately
log_sync "START" "Performing initial sync..."
if joplin sync > "${LOG_DIR}/sync-stdout.log" 2> "${LOG_DIR}/sync-stderr.log"; then
    log_sync "PASS" "Initial sync completed successfully"
else
    log_sync "FAIL" "Initial sync failed (exit code: $?)"
    log "ERROR" "Sync stderr output:"
    cat "${LOG_DIR}/sync-stderr.log" >&2
fi

# Start periodic sync loop in the background
(
    while true; do
        sleep "${SYNC_INTERVAL_SECONDS}"

        log_sync "START" "Starting periodic sync..."
        SYNC_STDOUT="${LOG_DIR}/sync-stdout.log"
        SYNC_STDERR="${LOG_DIR}/sync-stderr.log"

        if joplin sync > "${SYNC_STDOUT}" 2> "${SYNC_STDERR}"; then
            log_sync "PASS" "Periodic sync completed successfully"
        else
            SYNC_EXIT_CODE=$?
            log_sync "FAIL" "Periodic sync failed (exit code: ${SYNC_EXIT_CODE})"
            log "ERROR" "Sync stderr output (exit code ${SYNC_EXIT_CODE}):"
            cat "${SYNC_STDERR}" >&2
        fi
    done
) &
SYNC_LOOP_PID=$!

log "INFO" "Periodic sync loop started (PID: ${SYNC_LOOP_PID})"

# -----------------------------------------------------------------------------
# Keep container alive and handle graceful shutdown
# -----------------------------------------------------------------------------
log "INFO" "============================================="
log "INFO" "joplin-core container is ready"
log "INFO" "  Data API: http://0.0.0.0:${JOPLIN_DATA_API_PORT}"
log "INFO" "  Sync interval: ${SYNC_INTERVAL_SECONDS}s"
log "INFO" "  Log file: ${LOG_FILE}"
log "INFO" "============================================="

cleanup() {
    local signal="$1"
    log "INFO" "Received ${signal}, shutting down gracefully..."

    # Kill the sync loop
    if [ -n "${SYNC_LOOP_PID:-}" ] && kill -0 "${SYNC_LOOP_PID}" 2>/dev/null; then
        kill "${SYNC_LOOP_PID}" 2>/dev/null || true
        log "INFO" "Sync loop stopped"
    fi

    # Kill the Joplin Data API server
    if [ -n "${JOPLIN_SERVER_PID:-}" ] && kill -0 "${JOPLIN_SERVER_PID}" 2>/dev/null; then
        kill "${JOPLIN_SERVER_PID}" 2>/dev/null || true
        log "INFO" "Joplin Data API server stopped"
    fi

    # Final sync before exit
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

# Wait for the Joplin Data API process (foreground)
wait "${JOPLIN_SERVER_PID}"
