FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --omit=dev \
  && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV DB_PATH=/data/gewicht.db
ENV PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
RUN rm -f server/*.test.js && mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
