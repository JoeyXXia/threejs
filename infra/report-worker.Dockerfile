FROM node:22.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/simulation/package.json packages/simulation/package.json
RUN pnpm --filter warehouse-twin --filter @warehouse-twin/api... install --frozen-lockfile --ignore-scripts
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/contracts/src packages/contracts/src
COPY packages/simulation/tsconfig.json packages/simulation/tsconfig.json
COPY packages/simulation/src packages/simulation/src
COPY packages/database/index.cjs packages/database/index.d.ts packages/database/reconcile.cjs packages/database/
COPY packages/database/prisma/schema.prisma packages/database/prisma/schema.prisma
RUN pnpm --filter @warehouse-twin/database generate \
    && pnpm --filter @warehouse-twin/contracts --filter @warehouse-twin/simulation build \
    && pnpm --filter @warehouse-twin/api build
USER node
CMD ["node", "apps/api/dist/jobs/main.js"]
