# better-sqlite3 publie des binaires précompilés pour la glibc, jamais pour musl.
# Sur Alpine, chaque build recompilerait le module natif depuis les sources.
FROM node:20-bookworm-slim AS build
WORKDIR /app
# Voie de repli si le binaire précompilé manque pour cette plateforme.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    DB_PATH=/data/challenge.sqlite \
    PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# Docker initialise un volume nommé vierge à partir du contenu de l'image,
# droits compris : le chown ici évite toute manipulation côté hôte.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
