FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/browser-bridge/package.json ./packages/browser-bridge/
RUN npm install --omit=dev

FROM node:25-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/browser-bridge/package.json ./packages/browser-bridge/
RUN npm install
COPY . .
RUN npm run build

FROM node:25-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/.mcp-use ./.mcp-use
COPY package.json ./
EXPOSE 3000
CMD ["npm", "start"]
