# syntax=docker/dockerfile:1

# One image, two roles. The API process sets INGESTION_WORKER_DISABLED and
# REMINDER_WORKER_DISABLED; the worker process leaves them off. The split is
# env-only because the queue boundary already exists (see AudioIngestionWorker).
FROM node:24-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Prisma's engines need OpenSSL; ca-certificates is for the provider calls.
RUN npm install -g pnpm@12.3.4 \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build

# The whole workspace is needed: the API imports @adhd/shared and extends
# @adhd/tsconfig, and pnpm's frozen lockfile covers every importer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @adhd/shared build
RUN pnpm --filter @adhd/api db:generate
RUN pnpm --filter @adhd/api build

# A self-contained tree with production deps only. `prisma` is a runtime
# dependency so `prisma migrate deploy` works as a release command.
RUN pnpm --filter @adhd/api deploy --prod /out

# Generate *after* deploy: the deploy tree gets a fresh node_modules from the
# store, which does not contain the generated client. The URL is only needed to
# satisfy prisma.config.ts's env() check; generate never connects.
WORKDIR /out
RUN DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused \
  ./node_modules/.bin/prisma generate

FROM base AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /out ./

# The node image ships this unprivileged user; nothing here needs root.
USER node

EXPOSE 3001

CMD ["node", "dist/main.js"]
