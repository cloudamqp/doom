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
