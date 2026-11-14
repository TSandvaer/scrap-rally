# Scrap Rally: one Node process serving the built client and the game WebSocket.
# Install scripts stay off (--ignore-scripts): the project does not approve dependency
# install scripts, and nothing here needs them.

FROM node:24.19.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24.19.0-slim
# The server picks production mode (no Vite, serve dist/) from NODE_ENV.
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 3000
CMD ["node", "dist-server/index.js"]
