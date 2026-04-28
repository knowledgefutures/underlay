# --- Build stage ---
FROM node:24-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# --- Dev stage (used by docker-compose.dev.yml) ---
FROM node:24-alpine AS dev
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
CMD ["sh", "-c", "npm run db:migrate && npm run db:seed && npm run dev:server"]

# --- Production stage ---
FROM node:24-alpine AS production
WORKDIR /app
RUN apk add --no-cache curl python3 make g++
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && apk del python3 make g++
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/src/api ./src/api
COPY --from=build /app/src/db ./src/db
COPY --from=build /app/src/lib ./src/lib
COPY --from=build /app/tools ./tools
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 4321 3000

# Run migrations then start both Astro SSR and Fastify API
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && node ./dist/server/entry.mjs & npx tsx src/api/server.ts & wait"]
