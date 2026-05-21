FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

EXPOSE 3100

CMD ["node", "dist/index.js"]
