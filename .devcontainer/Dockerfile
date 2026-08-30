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

# Install Docker CLI, Compose plugin, and Buildx plugin (for integration tests)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# Create docker group (GID 955 matches host) and add node user for socket access
RUN getent group docker || groupadd -g 955 docker; usermod -aG docker node

# Switch to node user for remaining operations
USER node

# Pre-create .vscode-server so bind mounts don't create it as root
RUN mkdir -p /home/node/.vscode-server/data/Machine && \
    mkdir -p /home/node/.roo && \
    mkdir -p /home/node/.vscode-server/data/User/globalStorage && \
    mkdir -p /home/node/.vscode-server/data/User/globalStorage/zoocodeorganization.zoo-code && \
    mkdir -p /home/node/.vscode-server/data/User/globalStorage/emptyWindowChatSessions
