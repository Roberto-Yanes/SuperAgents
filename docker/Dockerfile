# Imagen única del motor (api + workers). Node 22, pnpm, Prisma 7.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile
COPY apps/server apps/server
RUN cd apps/server && npx prisma generate && pnpm build
RUN pnpm deploy --filter @ega/server --prod --legacy /out \
 && cp -r apps/server/dist apps/server/prisma apps/server/prisma.config.ts /out/

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
RUN useradd --system --uid 10001 ega && mkdir -p /app/data && chown -R ega /app
USER ega
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# prisma (dependencia de producción) aplica las migraciones pendientes al arrancar
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node --enable-source-maps dist/main.js"]
