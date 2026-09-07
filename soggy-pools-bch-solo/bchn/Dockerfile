FROM debian:bookworm-slim

ARG TARGETARCH
ARG BCHN_VERSION=29.1.0

# Official Bitcoin Cash Node v29.1.0 release asset SHA-256 hashes.
ARG BCHN_AMD64_SHA256=2d52f6c3091351095839415bfd9ad6ee5cdd34aa6c726f2078ae28aa9015acc4
ARG BCHN_ARM64_SHA256=15c5c0400c828d6690970200ad59c18207313c7047b29d571f7e9870d06300ea

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates curl jq libgcc-s1 \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) \
        BCHN_ARCH="x86_64"; \
        BCHN_SHA256="${BCHN_AMD64_SHA256}"; \
        ;; \
      arm64) \
        BCHN_ARCH="aarch64"; \
        BCHN_SHA256="${BCHN_ARM64_SHA256}"; \
        ;; \
      *) \
        echo "Unsupported architecture: ${TARGETARCH}" >&2; \
        exit 1; \
        ;; \
    esac; \
    BCHN_FILE="bitcoin-cash-node-${BCHN_VERSION}-${BCHN_ARCH}-linux-gnu.tar.gz"; \
    BCHN_URL="https://github.com/bitcoin-cash-node/bitcoin-cash-node/releases/download/v${BCHN_VERSION}/${BCHN_FILE}"; \
    echo "Downloading ${BCHN_URL}"; \
    curl -fL --retry 5 --retry-delay 2 \
      "${BCHN_URL}" \
      -o /tmp/bchn.tar.gz; \
    echo "${BCHN_SHA256}  /tmp/bchn.tar.gz" | sha256sum -c -; \
    mkdir -p /tmp/bchn; \
    tar -xzf /tmp/bchn.tar.gz \
      -C /tmp/bchn \
      --strip-components=1; \
    install -m 0755 \
      /tmp/bchn/bin/bitcoind \
      /usr/local/bin/bitcoind; \
    install -m 0755 \
      /tmp/bchn/bin/bitcoin-cli \
      /usr/local/bin/bitcoin-cli; \
    rm -rf /tmp/bchn /tmp/bchn.tar.gz

COPY entrypoint.sh /usr/local/bin/bch-solo-bchn-entrypoint

RUN chmod +x /usr/local/bin/bch-solo-bchn-entrypoint \
  && bitcoind --version | head -n 2

ENTRYPOINT ["/usr/local/bin/bch-solo-bchn-entrypoint"]