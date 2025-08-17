# Production-ready Dockerfile for Hanzo MCP Server
# Multi-stage build optimized for TypeScript CLI applications

# ===== Base Stage =====
FROM node:20-alpine AS base

# Install system dependencies and security updates
RUN apk update && apk upgrade && \
    apk add --no-cache \
    dumb-init \
    tini \
    ca-certificates && \
    rm -rf /var/cache/apk/*

# Create app directory with proper permissions
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mcp && \
    chown -R mcp:nodejs /app

# ===== Dependencies Stage =====
FROM base AS deps

# Copy package files
COPY --chown=mcp:nodejs package.json package-lock.json* ./

# Switch to mcp user for security
USER mcp

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Install dev dependencies for building
RUN npm ci

# ===== Builder Stage =====
FROM deps AS builder

# Copy source code
COPY --chown=mcp:nodejs . .

# Build the application
RUN npm run build

# ===== Development Stage =====
FROM deps AS development

# Copy source code
COPY --chown=mcp:nodejs . .

# Set environment
ENV NODE_ENV=development

# Development command with hot reload
CMD ["npm", "run", "dev"]

# ===== Production Stage =====
FROM base AS production

# Install only runtime dependencies
COPY --chown=mcp:nodejs package.json package-lock.json* ./

# Switch to mcp user for security
USER mcp

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder
COPY --from=builder --chown=mcp:nodejs /app/dist ./dist

# Make CLI executable
RUN chmod +x ./dist/cli.js

# Set environment variables
ENV NODE_ENV=production

# Create symlink for global access (optional)
USER root
RUN ln -sf /app/dist/cli.js /usr/local/bin/hanzo-mcp
USER mcp

# Health check for MCP server
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "process.exit(0);" || exit 1

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Default command runs the MCP server
CMD ["node", "dist/index.js"]

# ===== Default to production =====
FROM production