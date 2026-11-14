# godseye runtime image: Node 24 + the compiled gateway.
# The same image runs two services (deploy/docker-compose.yml):
#   gateway  node dist/src/index.js            (spawns the GEV stdio MCP child from /gev)
#   gev      node /gev/node_modules/vite/bin/vite.js preview ...  (GEV clone mounted read-only)
# Built with the classic builder (no BuildKit-only syntax), base pinned by digest.
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 godseye \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin godseye \
 && mkdir -p /data /gev/.gev-cache /gev/.gev-logs /gev/.cache \
 && chown 10001:10001 /data /gev/.gev-cache /gev/.gev-logs /gev/.cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY gev ./gev
COPY data/rail ./data/rail
COPY web ./web
COPY third_party ./third_party
USER 10001:10001
EXPOSE 7700
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7700/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/src/index.js"]
