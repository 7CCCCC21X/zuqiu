# Railway / any container host: builds the TypeScript and runs the bot.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json config*.json ./
# journal + state go here; mount a persistent volume at /data and set DATA_DIR=/data
RUN mkdir -p /data
CMD ["node", "dist/index.js", "run"]
