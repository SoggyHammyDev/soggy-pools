#!/usr/bin/env sh
set -eu

SETTINGS_FILE="${SETTINGS_FILE:-/settings/settings.json}"
RPC_USER="${BCH_RPC_USER:-umbrel-bch}"
RPC_PASSWORD="${BCH_RPC_PASSWORD:?BCH_RPC_PASSWORD is required}"
RPC_PORT="${BCH_RPC_PORT:-8332}"
ZMQ_PORT="${BCH_ZMQ_PORT:-29000}"

network="mainnet"
storage_mode="pruned"
prune_mb="10240"
dbcache_mb="1024"

if [ -f "$SETTINGS_FILE" ]; then
  network="$(jq -r '.network // "mainnet"' "$SETTINGS_FILE" 2>/dev/null || echo mainnet)"
  storage_mode="$(jq -r '.storageMode // "pruned"' "$SETTINGS_FILE" 2>/dev/null || echo pruned)"
  prune_mb="$(jq -r '.pruneTargetMb // 10240' "$SETTINGS_FILE" 2>/dev/null || echo 10240)"
  dbcache_mb="$(jq -r '.dbCacheMb // 1024' "$SETTINGS_FILE" 2>/dev/null || echo 1024)"
fi

case "$prune_mb" in
  ''|*[!0-9]*) prune_mb=10240 ;;
esac
case "$dbcache_mb" in
  ''|*[!0-9]*) dbcache_mb=1024 ;;
esac

case "$network" in
  testnet|testnet4)
    network="testnet4"
    chain_arg="-testnet4"
    ;;
  mainnet|*)
    network="mainnet"
    chain_arg=""
    ;;
esac

if [ "$storage_mode" = "archive" ]; then
  prune_arg="-prune=0"
else
  [ "$prune_mb" -lt 2048 ] && prune_mb=2048
  prune_arg="-prune=$prune_mb"
fi

echo "[bch-solo] Starting BCHN network=$network rpc=$RPC_PORT zmq=$ZMQ_PORT"

# Keep RPC and ZMQ on fixed private Docker-network ports on both chains.
# Testnet4's default P2P port is 28333, so ZMQ intentionally uses 29000.
set -- \
  -datadir=/data \
  -printtoconsole=1 \
  -server=1 \
  -listen=1 \
  -rpcbind=0.0.0.0 \
  -rpcallowip=0.0.0.0/0 \
  -rpcport="$RPC_PORT" \
  -rpcuser="$RPC_USER" \
  -rpcpassword="$RPC_PASSWORD" \
  -zmqpubhashblock="tcp://0.0.0.0:$ZMQ_PORT" \
  -dbcache="$dbcache_mb" \
  "$prune_arg"

if [ -n "$chain_arg" ]; then
  set -- "$chain_arg" "$@"
fi

exec bitcoind "$@"
