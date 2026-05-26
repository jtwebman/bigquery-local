# syntax=docker/dockerfile:1.7
#
# Multi-stage, multi-arch image for bigquery-local.
#
# Base: node:24-bookworm-slim (NOT alpine). DuckDB's published native bindings
# (@duckdb/node-bindings-linux-{x64,arm64}) are compiled against glibc; Alpine
# uses musl and would silently fail to load the .node file at startup.
#
# Stage 1 (deps) installs production deps into a clean layer keyed on the
# lockfile, so source changes don't bust the npm cache. Stage 2 copies the
# resolved node_modules over the runtime image and adds the bin + src.

# ---- Stage 1: production deps ----
FROM node:24-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

# ---- Stage 1b: prebuild DuckDB extension cache ----
# INSTALL + LOAD spatial once at build time so the runtime container
# doesn't hit DuckDB's extension repo on first start. The cache lives
# under $HOME/.duckdb/extensions/<version>/<platform>/.
FROM node:24-bookworm-slim AS extensions
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
RUN node --input-type=module --eval " \
    import { DuckDBInstance } from '@duckdb/node-api'; \
    const i = await DuckDBInstance.create(':memory:'); \
    const c = await i.connect(); \
    await c.run('INSTALL spatial'); \
    await c.run('LOAD spatial'); \
    "

# ---- Stage 2: runtime ----
FROM node:24-bookworm-slim AS runtime

# tini gives the container a real PID-1 — handles SIGTERM properly so docker
# stop doesn't hang waiting for kernel default behavior.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node 24 strips TypeScript types natively, so we ship the source as-is.
# No transpile step is required either at build or at runtime.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Pre-baked DuckDB extension cache (spatial). Owned by `node` so the
# runtime can read it without falling back to a network download.
COPY --from=extensions --chown=node:node /root/.duckdb /home/node/.duckdb

# Run as the unprivileged `node` user that ships with the base image.
USER node

# REST + gRPC defaults from the CLI; documented for `docker run -P`.
EXPOSE 9050 9060

# Healthcheck uses the built-in `node --eval`. Node 24 has fetch, so we don't
# need wget/curl in the runtime image. Exit 0 on a 200, 1 otherwise.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:9050/discovery/v1/apis/bigquery/v2/rest').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/cli.ts"]
CMD ["--port=9050", "--grpc-port=9060"]
