# Local development image shared by three independent containers.
FROM node:22.23.2-bookworm-slim AS development
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
