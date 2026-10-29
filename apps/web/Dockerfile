# syntax=docker/dockerfile:1

FROM node:24-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN npm install -g pnpm@12.3.4 \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

# NEXT_PUBLIC_* is inlined at build time, so it has to be here, not at runtime.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DEV_MODE=false
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_DEV_MODE=$NEXT_PUBLIC_DEV_MODE

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @adhd/shared build
RUN pnpm --filter @adhd/web build
RUN pnpm --filter @adhd/web deploy --prod /out

FROM base AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /out ./

USER node

EXPOSE 3000

CMD ["node_modules/.bin/next", "start", "--port", "3000"]
