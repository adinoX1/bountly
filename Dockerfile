# Bountly — explicit Docker build (bypasses Nixpacks apt phase that was
# failing on Railway's builder). Node 18 slim, all deps are pure-JS.
FROM node:18-slim
WORKDIR /app

# Install deps first for layer caching. No package-lock committed → npm install.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
