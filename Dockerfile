FROM node:26.13.1-bookworm-slim AS build

WORKDIR /app
RUN npm install --global corepack@0.34.5 && corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
RUN yarn install --immutable
COPY . .
RUN yarn build && yarn workspaces focus @calendar/api --production

FROM node:26.13.1-bookworm-slim

ENV SERVE_STATIC=1 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/api-client/package.json ./packages/api-client/package.json

USER node
EXPOSE 3000
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then node apps/api/dist/cli.js migrate || exit 1; fi && exec node apps/api/dist/server.js"]
