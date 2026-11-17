# syntax=docker/dockerfile:1

# Chocolate Doom compiled to WebAssembly
FROM emscripten/emsdk:7.0.0 AS wasm
WORKDIR /doom
COPY doom/ .
RUN make -j"$(nproc)"

# Freedoom: Phase 1, a free Doom IWAD
FROM alpine:3 AS wad
ARG FREEDOOM_VERSION=0.13.0
ARG FREEDOOM_SHA256=3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59
ADD --checksum=sha256:${FREEDOOM_SHA256} \
    https://github.com/freedoom/freedoom/releases/download/v${FREEDOOM_VERSION}/freedoom-${FREEDOOM_VERSION}.zip \
    /freedoom.zip
RUN unzip -j /freedoom.zip "*/freedoom1.wad" -d /out && gzip -k9 /out/freedoom1.wad

# The build artifacts on their own: docker build --target dist --output web .
FROM scratch AS dist
COPY --from=wasm /doom/build/doom.js /doom/build/doom.wasm /
COPY --from=wad /out/ /

FROM nginx:1-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 docker/broker-url.sh /docker-entrypoint.d/40-broker-url.sh
COPY web/ /usr/share/nginx/html/
COPY --from=dist / /usr/share/nginx/html/
