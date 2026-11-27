# syntax=docker/dockerfile:1

# Doom compiled to WebAssembly and the Freedoom IWAD, see bin/build.sh
FROM emscripten/emsdk:7.0.0 AS build
WORKDIR /src
COPY bin/build.sh bin/
COPY doom/ doom/
RUN bin/build.sh

# The build artifacts on their own: docker build --target dist --output web .
FROM scratch AS dist
COPY --from=build /src/web/ /

FROM nginx:1-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 docker/broker-url.sh /docker-entrypoint.d/40-broker-url.sh
COPY web/ /usr/share/nginx/html/
COPY --from=dist / /usr/share/nginx/html/
# Served by gzip_static, the WAD is 28 MB
RUN gzip -k9 /usr/share/nginx/html/freedoom1.wad

# The bot service: Doom as a plain program that plays by itself, see
# doom/native. docker build --target bots -t doomq-bots .
FROM debian:13-slim AS bots-build
RUN apt-get update -q && apt-get install -qy --no-install-recommends gcc libc6-dev libssl-dev make pkg-config zlib1g-dev
WORKDIR /src
COPY doom/ doom/
RUN make -C doom native

FROM debian:13-slim AS bots
RUN apt-get update -q && apt-get install -qy --no-install-recommends ca-certificates libssl3t64 && rm -rf /var/lib/apt/lists/*
COPY --from=bots-build /src/doom/build/native/doomq-bot /usr/local/bin/
# For bots that take on new code while they play, with -botlib
COPY --from=bots-build /src/doom/build/native/bot.so /usr/local/lib/doomq/
COPY --from=dist /freedoom1.wad /usr/share/doomq/
USER nobody
# Sends bots into the games of the lobby that ask for them
ENTRYPOINT ["/usr/local/bin/doomq-bot", "-iwad", "/usr/share/doomq/freedoom1.wad", "-lobby", "-broker"]
CMD ["mqtt://guest:guest@lavinmq:1883"]
