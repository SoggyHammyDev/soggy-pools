ARG ABC_VERSION=latest
FROM bitcoinabc/bitcoin-abc:${ABC_VERSION}

COPY entrypoint.sh /usr/local/bin/xec-node-entrypoint
USER root
RUN chmod +x /usr/local/bin/xec-node-entrypoint && mkdir -p /data /settings
ENTRYPOINT ["/usr/local/bin/xec-node-entrypoint"]
