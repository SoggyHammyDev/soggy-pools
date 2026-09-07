FROM debian:bookworm-slim AS ckbuild
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates git build-essential yasm autoconf automake libtool pkg-config \
     libssl-dev libjansson-dev libzmq3-dev \
  && rm -rf /var/lib/apt/lists/*
ARG CKPOOL_REPO=https://github.com/skaisser/ckpool.git
ARG CKPOOL_REF=11692101556501f5d242a83f356d389c086be313
RUN git clone "$CKPOOL_REPO" /src/ckpool \
  && cd /src/ckpool \
  && git checkout "$CKPOOL_REF" \
  && ./autogen.sh \
  && ./configure \
  && make -j"$(nproc)"

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends libssl3 libjansson4 libzmq5 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ckbuild /src/ckpool/src/ckpmsg /usr/local/bin/ckpmsg
WORKDIR /app
COPY server.js /app/server.js
EXPOSE 8081
CMD ["node", "/app/server.js"]
