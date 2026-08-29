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

# Pre-create .vscode-server with correct ownership so bind mounts don't create it as root
RUN mkdir -p /home/node/.vscode-server && chown -R node:node /home/node
