FROM node:22-bookworm-slim

# System packages for development
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally (matching Dockerfile.core and Dockerfile.mcp)
RUN npm install -g "pnpm@9"

# The default 'node' user (uid 1000) matches remoteUser in devcontainer.json
