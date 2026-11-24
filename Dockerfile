# Hugo Site Manager — multi-arch image (linux/arm64 for the Raspberry Pi cluster, linux/amd64 too).
#   docker buildx build --platform linux/arm64 -t <registry>/hugo-site-manager:1.0.0 --push .
FROM node:24-bookworm-slim

ARG TARGETARCH
ARG HUGO_VERSION=0.162.1
ARG GO_VERSION=1.27.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# Go is needed for Hugo Modules (the Toha theme is a module).
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" | tar -xz -C /usr/local
# Baseline Hugo; upgrades from the UI are downloaded into the data volume and take precedence.
RUN curl -fsSL "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin hugo \
 && hugo version
# MinIO client for deploys.
RUN curl -fsSL -o /usr/local/bin/mc "https://dl.min.io/client/mc/release/linux-${TARGETARCH}/mc" \
 && chmod +x /usr/local/bin/mc

ENV PATH=/usr/local/go/bin:$PATH \
    HOME=/data/home \
    HSM_DATA_DIR=/data/app \
    HSM_CONFIG=/config/config.json \
    HSM_HOST=0.0.0.0 \
    HSM_PORT=8787 \
    HUGO_CACHEDIR=/data/cache/hugo \
    GOPATH=/data/cache/go \
    npm_config_cache=/data/cache/npm \
    MC_CONFIG_DIR=/data/home/.mc

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY bin ./bin
COPY public ./public

USER 1000:1000
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
