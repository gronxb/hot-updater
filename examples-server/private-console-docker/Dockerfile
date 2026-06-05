FROM node:22-slim AS builder

WORKDIR /repo

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY plugins ./plugins

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hot-updater/cli-tools build
RUN pnpm --filter hot-updater build
RUN pnpm --filter @hot-updater/console build

FROM node:22-slim

WORKDIR /repo

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=1422
ENV HOT_UPDATER_CONFIG_PATH=/app/hot-updater.config.ts

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY plugins ./plugins
COPY --from=builder /repo/packages/cli-tools/dist ./packages/cli-tools/dist
COPY --from=builder /repo/packages/hot-updater/dist ./packages/hot-updater/dist
COPY --from=builder /repo/packages/console/.output ./packages/console/.output
COPY examples-server/private-console-docker/hot-updater.config.ts /app/hot-updater.config.ts

RUN pnpm install --prod --frozen-lockfile

EXPOSE 1422

CMD ["node", "packages/console/bin/serve.mjs"]
