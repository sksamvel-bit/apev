FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY . .

# Run as the unprivileged "node" user; pin-bindings.json must be writable
RUN chown -R node:node /app
USER node

EXPOSE 3000
ENV PORT=3000 NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server.js"]
