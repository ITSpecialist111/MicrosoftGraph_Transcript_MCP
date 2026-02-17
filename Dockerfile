# ── Stage 1: Build ──────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Production ────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Azure App Service expects port 8080 by default
ENV PORT=8080
EXPOSE 8080

# Non-root user for security
RUN addgroup -S mcpgroup && adduser -S mcpuser -G mcpgroup
USER mcpuser

CMD ["node", "dist/server.js"]
