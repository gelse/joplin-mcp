FROM node:22-bookworm-slim

# System packages for development (requires root)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally (requires root)
RUN npm install -g "pnpm@9"

# Switch to node user for remaining operations
USER node

# Pre-create .vscode-server so bind mounts don't create it as root
RUN mkdir -p /home/node/.vscode-server
