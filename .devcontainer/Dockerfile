FROM node:22-bookworm-slim

# System packages for development (requires root)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    locales \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally (requires root)
RUN npm install -g "pnpm@9"

# Switch to node user for remaining operations
USER node

# Pre-create .vscode-server so bind mounts don't create it as root
RUN mkdir -p /home/node/.vscode-server/data/Machine && \
    mkdir -p /home/node/.roo && \
    mkdir -p /home/node/.vscode-server/data/User/globalStorage && \
    mkdir -p /home/node/.vscode-server/data/User/globalStorage/zoocodeorganization.zoo-code && \
    mkdir -p /home/node/.vscode-server/data/User/globalStorage/emptyWindowChatSessions
