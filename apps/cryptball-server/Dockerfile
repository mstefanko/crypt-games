FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build:cryptball:server
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=2567
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/cryptball-server ./dist/cryptball-server
USER node
EXPOSE 2567
CMD ["node", "dist/cryptball-server/main.mjs"]
