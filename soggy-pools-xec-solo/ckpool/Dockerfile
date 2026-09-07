FROM debian:bookworm-slim AS build

ARG CKPOOL_REPO=https://github.com/Bitcoin-ABC/ecash-ckpool-solo.git
ARG CKPOOL_REF=master

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential yasm autoconf automake libtool pkgconf libssl-dev libjansson-dev libzmq3-dev \
 && rm -rf /var/lib/apt/lists/*

RUN git clone "$CKPOOL_REPO" /src/ecash-ckpool \
 && cd /src/ecash-ckpool \
 && git checkout "$CKPOOL_REF" \
 && ./autogen.sh \
 && ./configure \
 && make -j"$(nproc)" \
 && git rev-parse HEAD > .soggypools-build-commit

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq libssl3 libjansson4 libzmq5 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/ecash-ckpool/src/ckpool /usr/local/bin/ckpool
COPY --from=build /src/ecash-ckpool/src/ckpmsg /usr/local/bin/ckpmsg
# Keep the exact GPLv3 corresponding source alongside the binary we distribute.
COPY --from=build /src/ecash-ckpool /usr/src/ecash-ckpool-solo
COPY entrypoint.sh /usr/local/bin/xec-ckpool-entrypoint
RUN chmod +x /usr/local/bin/xec-ckpool-entrypoint \
 && mkdir -p /var/lib/ckpool/logs /tmp/ckpool /data

EXPOSE 3333
ENTRYPOINT ["/usr/local/bin/xec-ckpool-entrypoint"]
