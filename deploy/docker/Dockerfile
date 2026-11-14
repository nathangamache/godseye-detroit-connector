# godseye runtime image: Node 24 + the compiled gateway.
# The same image runs three services (deploy/docker-compose.yml):
#   gateway  node dist/src/index.js            (no GEV code: talks to gev-mcp over TCP)
#   gev      node /gev/node_modules/vite/bin/vite.js preview ...  (GEV clone mounted read-only)
#   gev-mcp  node dist/scripts/gev-relay.js    (GEV MCP child; GEV clone mounted read-only)
# Built with the classic builder (no BuildKit-only syntax), base pinned by digest. The FROM
# lines name the image directly (no ARG) so Dependabot can see and update them.
#
# File modes: the classic builder keeps each file's mode from the checkout and makes it
# root's. Under the recommended `umask 077` a checkout is mode 600/700, which the runtime
# user (uid 10001) could not read. So every runtime file is staged in the build stage, its
# modes are normalised there (directories 755, files 644, executables 755, no set-id bits),
# and the runtime stage copies only from the build stage, never from the context. Secrets
# never enter the context (.dockerignore: deploy/secrets, .env, .env.*).
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /app
ENV npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev
COPY gev ./gev
COPY data/rail ./data/rail
COPY web ./web
COPY third_party ./third_party
RUN chmod -R u=rwX,go=rX /app/package.json /app/node_modules /app/dist /app/gev /app/data /app/web /app/third_party

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 godseye \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin godseye \
 && mkdir -p /data /gev/.gev-cache /gev/.gev-logs /gev/.cache \
 && chown 10001:10001 /data /gev/.gev-cache /gev/.gev-logs /gev/.cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/gev ./gev
COPY --from=build /app/data/rail ./data/rail
COPY --from=build /app/web ./web
COPY --from=build /app/third_party ./third_party
USER 10001:10001
EXPOSE 7700
# The gateway's public listener binds HOST (the compose-network address in production).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const h=process.env.HOST||'127.0.0.1';fetch('http://'+(h==='0.0.0.0'?'127.0.0.1':h)+':'+(process.env.PORT||'7700')+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/src/index.js"]
