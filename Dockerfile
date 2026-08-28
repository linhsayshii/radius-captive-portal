FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:portal && npm run build:admin
RUN npm prune --omit=dev
EXPOSE 3000
CMD ["npm", "start"]
