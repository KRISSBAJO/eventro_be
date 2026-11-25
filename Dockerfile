# Omoshow API — production image.
#   docker build -t eventro-api .
#   docker run -p 4000:4000 --env-file .env.production eventro-api
# On start it applies pending database migrations, then serves on $PORT (default 4000).

FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  # Keep only runtime packages, plus the Prisma CLI for `migrate deploy` at start-up.
  && npm prune --omit=dev \
  && npm install --no-save --omit=dev "prisma@$(node -p "require('./package.json').devDependencies.prisma")"

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
# A private checkout can leave copied files readable only by root.
RUN chmod a+r package.json && chmod -R a+rX prisma
USER node
RUN test -r package.json && test -r prisma/schema.prisma \
  && test -r dist/src/main.js && test -x node_modules/.bin/prisma
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD wget -qO- "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null || exit 1
CMD ["sh", "-c", "npx prisma migrate deploy && node --enable-source-maps dist/src/main.js"]
