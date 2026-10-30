# settle-api: testnet-only settlement service. See docs/docker.md.
FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    SETTLE_DATA_DIR=/var/lib/settle

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY data ./data

# State (quotes, payments, receipt ledger) lives in a volume owned by the unprivileged user.
RUN mkdir -p /var/lib/settle && chown node:node /var/lib/settle
VOLUME ["/var/lib/settle"]
USER node

EXPOSE 8787

# /healthz is the documented liveness endpoint. node:24-slim has no curl, so use the runtime itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "src/server.ts"]
