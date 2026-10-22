# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS dds-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends binutils g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY dds/library/src /src/dds/library/src
COPY native/dds-cli /src/native/dds-cli
COPY scripts/build-linux-dds.sh /src/scripts/build-linux-dds.sh

RUN bash /src/scripts/build-linux-dds.sh /src /out

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DDS_MAX_CONCURRENCY=1 \
    DDS_TT_DEFAULT_MB=95 \
    DDS_TT_LIMIT_MB=95

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node server.js dds-wrapper.js dds-process.js dds-paths.js complex-bridge.js ./
COPY --chown=node:node classic ./classic
COPY --chown=node:node public ./public
COPY --chown=node:node skills ./skills
COPY --chown=node:node scripts/smoke-dds.js ./scripts/smoke-dds.js
COPY --from=dds-builder --chown=node:node /out/dds_calc /out/dds_solve ./bin/

RUN node scripts/smoke-dds.js

USER node
EXPOSE 3000

CMD ["node", "server.js"]
