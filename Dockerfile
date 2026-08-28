FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build:portal && npm run build:admin
EXPOSE 3000
CMD ["npm", "start"]
