#!/bin/bash
set -euo pipefail

# =============================================================================
# Joplin API MCP Server — Entrypoint Script
# =============================================================================
# Validates environment, configures Joplin CLI for server sync, then starts
# the TypeScript MCP server which manages the Joplin Data API as a child process.
# =============================================================================

log() {
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] [$1] $2" >&2
}

# --- Validate required environment variables ---
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
LOG_LEVEL="${LOG_LEVEL:-info}"

log "INFO" "Starting Joplin API MCP Server"
log "INFO" "Joplin Server URL: ${JOPLIN_SERVER_URL}"
# REMOVED: log "INFO" "Joplin Username: ${JOPLIN_USERNAME}"
log "INFO" "Data API Port: ${JOPLIN_DATA_API_PORT}"
log "INFO" "Log Level: ${LOG_LEVEL}"

# --- Configure Joplin CLI for server sync ---
log "INFO" "Configuring Joplin CLI sync target..."

joplin config sync.target 10
joplin config "sync.10.path" "${JOPLIN_SERVER_URL}"
joplin config "sync.10.username" "${JOPLIN_USERNAME}"
joplin config "sync.10.password" "${JOPLIN_PASSWORD}"
# Note: sync.conflictBehavior is not a recognized Joplin CLI config key; removed to avoid startup warnings.
# joplin config sync.conflictBehavior 2

log "INFO" "Joplin CLI configured"

# --- Extract API token from Joplin config ---
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
    exit 1
fi
log "INFO" "Joplin API token obtained"

# --- Export env vars for the TypeScript server ---
export JOPLIN_SERVER_URL
export JOPLIN_USERNAME
export JOPLIN_PASSWORD
export JOPLIN_DATA_API_PORT
export JOPLIN_API_TOKEN
export LOG_LEVEL

# --- Start TypeScript MCP server (foreground) ---
# NOTE: socat proxy is started by the Node.js server AFTER the ClipperServer
# is ready, to avoid a fork bomb from readiness-poll connections.
log "INFO" "Starting Joplin MCP server..."
exec node dist/server.js
