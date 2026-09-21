# Local development image shared by three independent containers.
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS development
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace
RUN npm install --global pnpm@10.28.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/backend-server/package.json ./apps/backend-server/package.json
COPY apps/ai-server/package.json ./apps/ai-server/package.json
COPY packages/public-contracts/package.json ./packages/public-contracts/package.json
COPY packages/internal-contracts/package.json ./packages/internal-contracts/package.json
RUN pnpm install --frozen-lockfile

COPY . .
CMD ["pnpm", "dev"]

FROM development AS web-build
ENV VITE_USE_MOCK=false
ENV VITE_API_BASE_URL=/api/v1
RUN pnpm --filter @aftercare/web... build

FROM development AS backend-build
RUN pnpm --filter @aftercare/backend-server... build \
    && pnpm --filter @aftercare/backend-server deploy --legacy --prod /opt/backend

FROM development AS ai-build
RUN pnpm --filter @aftercare/ai-server... build \
    && pnpm --filter @aftercare/ai-server deploy --legacy --prod /opt/ai

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]

FROM runtime AS backend-production
COPY --from=backend-build --chown=node:node /opt/backend ./

FROM runtime AS ai-production
COPY --from=ai-build --chown=node:node /opt/ai ./

FROM nginxinc/nginx-unprivileged:1.31.6-alpine@sha256:b54ac358b83fc6c965793fd271839b4ea4cdb6e99895bb19618cbc2ca152d972 AS web-production
ENV PORT=8080 BACKEND_ORIGIN=http://backend-server:8080 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER="^(PORT|BACKEND_ORIGIN|NGINX_LOCAL_RESOLVERS)$"
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web-build /workspace/apps/web/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
