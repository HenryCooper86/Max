# syntax=docker/dockerfile:1

# Voice agent relay: builds the web client and the browser SDK, then runs the
# relay. The relay is TypeScript run through tsx (a runtime dependency), so the
# final image carries the sources plus production dependencies only.
#
#   docker build -t voice-agent-kit .
#   docker run --rm -p 8787:8787 --env-file .env -v voice-agent-data:/data voice-agent-kit

# Node 22.13 or newer is required (node:sqlite). The slim (Debian) image is
# used rather than Alpine so no dependency ever meets musl. Pinned by digest,
# like the speech server's bases, so a rebuild of the same commit gets the same
# Node and Debian packages; bump the tag and digest together.
ARG NODE_IMAGE=node:22.23.5-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# `tsc` needs the dev dependencies, which is why this is its own stage.
RUN npm run build

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOME=/data \
    STUDIO_DIR=/data/.max-relay
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json assistant.config.example.json ./
COPY server ./server
COPY shared ./shared
COPY brand ./brand
COPY --from=build /app/dist ./dist
# Accounts, testing history, Studio settings and companion bindings live under
# HOME. Create it owned by the unprivileged user so a named volume inherits that.
RUN mkdir -p /data/.max-relay && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]
