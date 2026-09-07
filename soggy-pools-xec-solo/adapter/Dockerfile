FROM debian:bookworm-slim AS ckbuild

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates git build-essential yasm autoconf automake libtool pkgconf libssl-dev libjansson-dev libzmq3-dev \
    && rm -rf /var/lib/apt/lists/*

ARG CKPOOL_REPO=https://github.com/Bitcoin-ABC/ecash-ckpool-solo.git
ARG CKPOOL_REF=master
RUN git clone --depth 1 --branch "${CKPOOL_REF}" "${CKPOOL_REPO}" /src/ckpool \
    && cd /src/ckpool \
    && ./autogen.sh \
    && ./configure \
    && make -j"$(nproc)"

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libssl3 libjansson4 libzmq5 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ckbuild /src/ckpool/src/ckpmsg /usr/local/bin/ckpmsg
# Include the exact GPLv3 corresponding source for the ckpmsg binary.
COPY --from=ckbuild /src/ckpool /usr/src/ecash-ckpool-solo
WORKDIR /app
COPY server.js /app/server.js
EXPOSE 8081
CMD ["node", "/app/server.js"]
