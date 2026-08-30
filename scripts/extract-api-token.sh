#!/bin/bash
set -euo pipefail

SETTINGS_FILE="/joplin-data/settings.json"
MAX_RETRIES=30
RETRY_DELAY=2

echo "[extract-api-token] Waiting for API token in ${SETTINGS_FILE}..."

for i in $(seq 1 $MAX_RETRIES); do
    if [ -f "$SETTINGS_FILE" ]; then
        JOPLIN_API_TOKEN=$(grep -o '"api\.token"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" \
            | grep -o '[^"]*"$' | tr -d '"' || true)
        if [ -n "$JOPLIN_API_TOKEN" ]; then
            export JOPLIN_API_TOKEN
            echo "[extract-api-token] API token extracted successfully"
            exec ./entrypoint-mcp.sh
        fi
    fi
    if [ "$i" -eq "$MAX_RETRIES" ]; then
        echo "[extract-api-token] ERROR: Could not extract API token after ${MAX_RETRIES} attempts" >&2
        exit 1
    fi
    echo "[extract-api-token] Token not ready (attempt ${i}/${MAX_RETRIES}), retrying in ${RETRY_DELAY}s..."
    sleep "$RETRY_DELAY"
done
