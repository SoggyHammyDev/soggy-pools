FROM zquestz/bitcoin-cash-node:29.1.0

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/bch-solo-bchn-entrypoint
RUN chmod +x /usr/local/bin/bch-solo-bchn-entrypoint

ENTRYPOINT ["/usr/local/bin/bch-solo-bchn-entrypoint"]
