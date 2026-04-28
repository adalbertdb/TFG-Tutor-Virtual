# ==========================================
# Stage 1: Build Frontend (React/Vite)
# ==========================================
FROM node:22-alpine AS frontend-builder

ARG VITE_BASE_PATH
ARG VITE_BACKEND_URL
ARG VITE_DEV_BYPASS_AUTH

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts

COPY frontend/ .

# Write .env for Vite build (Vite reads these at build time)
RUN printf "VITE_BASE_PATH=%s\nVITE_BACKEND_URL=%s\nVITE_DEV_BYPASS_AUTH=%s\n" \
    "${VITE_BASE_PATH}" "${VITE_BACKEND_URL}" "${VITE_DEV_BYPASS_AUTH}" > .env

RUN npm run build

# ==========================================
# Stage 2: Install backend prod deps
# ==========================================
FROM node:22-alpine AS backend-deps

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ==========================================
# Stage 3: Production
# ==========================================
FROM node:22-alpine AS production

RUN apk add --no-cache tini

WORKDIR /app

# Backend deps
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json backend/package-lock.json ./backend/

# Backend source
COPY backend/src ./backend/src

# Frontend build (backend serves it statically)
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Data files (needed by RAG system)
COPY material-complementario/llm/datasets ./material-complementario/llm/datasets
COPY material-complementario/llm/knowledge-graph ./material-complementario/llm/knowledge-graph

# Non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/src/index.js"]
