#!/bin/bash
set -euo pipefail

# =============================================================================
# Container B: joplin-mcp — Entrypoint Script
# =============================================================================
# Validates environment and starts the MCP HTTP server.
# This container is stateless — all data operations go through Container A.
# =============================================================================

log() {
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] [$1] $2" >&2
}

# --- Validate required environment variables ---
REQUIRED_VARS=("JOPLIN_API_TOKEN" "JOPLIN_CORE_URL")
MISSING=()

for VAR in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!VAR:-}" ]; then
        MISSING+=("$VAR")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    log "ERROR" "Missing required environment variables: ${MISSING[*]}"
    log "ERROR" "Please set JOPLIN_API_TOKEN and JOPLIN_CORE_URL"
    exit 1
fi

# --- Set defaults ---
LOG_LEVEL="${LOG_LEVEL:-info}"
MCP_PORT="${MCP_PORT:-3000}"

log "INFO" "Starting Joplin MCP HTTP Server"
log "INFO" "  Joplin Core URL: ${JOPLIN_CORE_URL}"
log "INFO" "  MCP Port: ${MCP_PORT}"
log "INFO" "  Log Level: ${LOG_LEVEL}"

# --- Export env vars for the Node.js server ---
export JOPLIN_API_TOKEN
export JOPLIN_CORE_URL
export LOG_LEVEL
export MCP_PORT

# --- Start MCP HTTP server ---
log "INFO" "Starting MCP HTTP server on port ${MCP_PORT}..."
exec node dist/mcp/entry.js
