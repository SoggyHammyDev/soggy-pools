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
 && grep -Fqx 'static inline void send_api_response(json_t __maybe_unused *val, const int __maybe_unused sockd) {};' src/ckpool.h \
 && sed -i '/^static inline void send_api_response(/c\static inline void send_api_response(json_t *val, const int sockd) { char *buf; if (unlikely(!val)) { send_unix_msg(sockd, "{}"); return; } buf = json_dumps(val, JSON_COMPACT); json_decref(val); if (unlikely(!buf)) { send_unix_msg(sockd, "{}"); return; } send_unix_msg(sockd, buf); free(buf); }' src/ckpool.h \
 && grep -Fq 'json_dumps(val, JSON_COMPACT)' src/ckpool.h \
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
