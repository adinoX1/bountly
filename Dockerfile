# Bountly — explicit Docker build (bypasses Nixpacks apt phase that was
# failing on Railway's builder). Node 18 slim, all deps are pure-JS.
FROM node:18-slim
WORKDIR /app

# Install deps first for layer caching. `npm ci` needs the lockfile and gives a
# reproducible tree — `npm install` without one silently re-resolved every
# dependency on each build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

# App source
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
