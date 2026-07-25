# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Accept the Git commit SHA at build time (defaults to "unknown")
ARG GIT_COMMIT=unknown

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci

# Copy source and compile TypeScript → dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies so only production deps are copied to runtime stage
RUN npm ci --omit=dev

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Re-declare ARG so the value is available in this stage, then bake it into
# the image as an ENV so the running container can read it via process.env.
ARG GIT_COMMIT=unknown

# Non-root user for least-privilege runtime
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy compiled output and production node_modules from builder
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json ./

# Create a directory for the SQLite database file and give the app user ownership
RUN mkdir -p /data && chown appuser:appgroup /data

USER appuser

# Expose the default API port
EXPOSE 4000

# Set default DB path to the /data volume mount
ENV DB_PATH=/data/scout-off.db \
    NODE_ENV=production \
    PORT=4000 \
    GIT_COMMIT=$GIT_COMMIT

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/health/liveness || exit 1

CMD ["node", "dist/index.js"]
