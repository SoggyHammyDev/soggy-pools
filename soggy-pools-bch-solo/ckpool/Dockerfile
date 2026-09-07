FROM debian:bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates git build-essential yasm autoconf automake libtool pkg-config python3 \
     libssl-dev libjansson-dev libzmq3-dev \
  && rm -rf /var/lib/apt/lists/*

ARG CKPOOL_REPO=https://github.com/skaisser/ckpool.git
# Pin the upstream source so a future master-branch edit cannot silently break
# our source patch or change mining behaviour between Soggy Pools releases.
ARG CKPOOL_REF=11692101556501f5d242a83f356d389c086be313

COPY apply-soggypools-vardiff.py /tmp/apply-soggypools-vardiff.py
COPY apply-soggypools-test4.py /tmp/apply-soggypools-test4.py

RUN git clone "$CKPOOL_REPO" /src/ckpool
WORKDIR /src/ckpool
RUN git checkout "$CKPOOL_REF"
RUN python3 /tmp/apply-soggypools-vardiff.py
RUN python3 /tmp/apply-soggypools-test4.py
RUN ./autogen.sh
RUN ./configure
RUN make -j"$(nproc)"

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates curl jq python3 libssl3 libjansson4 libzmq5 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/ckpool/src/ckpool /usr/local/bin/ckpool
COPY --from=build /src/ckpool/src/ckpmsg /usr/local/bin/ckpmsg
COPY cashaddr_to_legacy.py /usr/local/bin/cashaddr-to-legacy
COPY entrypoint.sh /usr/local/bin/bch-solo-ckpool-entrypoint
RUN chmod +x /usr/local/bin/cashaddr-to-legacy /usr/local/bin/bch-solo-ckpool-entrypoint

ENTRYPOINT ["/usr/local/bin/bch-solo-ckpool-entrypoint"]
