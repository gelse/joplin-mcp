# Stage 1: Build TypeScript application
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Install pnpm
RUN npm install -g pnpm

# Copy dependency manifests first (layer caching)
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: skip esbuild postinstall scripts that require approval on newer pnpm
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source and compile
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN pnpm run build

# Stage 2: Production runtime
FROM node:22-bookworm-slim

# Install system dependencies required by Joplin CLI
# libsecret-1-0: for credential storage (keychain integration)
# ca-certificates: for HTTPS connections to Joplin Server
# curl: for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsecret-1-0 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm and Joplin CLI globally
RUN npm install -g pnpm joplin

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash joplin

# Set up application directory
WORKDIR /app

# Copy built application from builder stage
COPY --from=builder /build/dist ./dist

# Copy dependency manifests and install production dependencies only
COPY --from=builder /build/package.json /build/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy entrypoint script
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Create data directory for Joplin profile
RUN mkdir -p /home/joplin/.config/joplin && chown -R joplin:joplin /home/joplin /app

# Switch to non-root user
USER joplin

# Health check using Joplin Data API ping endpoint
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
    CMD curl -f http://localhost:${JOPLIN_DATA_API_PORT:-41100}/ping || exit 1

ENTRYPOINT ["./entrypoint.sh"]
