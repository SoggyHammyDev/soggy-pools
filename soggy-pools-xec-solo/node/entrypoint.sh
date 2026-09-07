#!/bin/sh
set -eu

RPC_USER="${XEC_RPC_USER:-umbrel-xec}"
RPC_PASSWORD="${XEC_RPC_PASSWORD:-}"
RPC_PORT="${XEC_RPC_PORT:-8332}"
SETTINGS_FILE="${SETTINGS_FILE:-/settings/settings.json}"

if [ -z "$RPC_PASSWORD" ]; then
  echo "[xec-node] ERROR: XEC_RPC_PASSWORD is required" >&2
  exit 2
fi

storage_mode="pruned"
prune_target="5000"
if [ -f "$SETTINGS_FILE" ]; then
  # settings.json is produced by the adapter with a predictable compact schema.
  mode="$(sed -n 's/.*"storageMode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SETTINGS_FILE" | head -n1 || true)"
  target="$(sed -n 's/.*"pruneTargetMb"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$SETTINGS_FILE" | head -n1 || true)"
  [ "$mode" = "archive" ] && storage_mode="archive"
  [ -n "$target" ] && prune_target="$target"
fi

if [ "$storage_mode" = "archive" ]; then
  prune_arg="0"
else
  case "$prune_target" in
    ''|*[!0-9]*) prune_target="5000" ;;
  esac
  [ "$prune_target" -lt 1100 ] && prune_target="1100"
  prune_arg="$prune_target"
fi

echo "[xec-node] Starting Bitcoin ABC mainnet"
echo "[xec-node] Storage: $storage_mode (prune=$prune_arg MiB)"
echo "[xec-node] RPC is private to the app Docker network"

exec bitcoind \
  -datadir=/data \
  -server=1 \
  -printtoconsole=1 \
  -rpcbind=0.0.0.0 \
  -rpcallowip=0.0.0.0/0 \
  -rpcport="$RPC_PORT" \
  -rpcuser="$RPC_USER" \
  -rpcpassword="$RPC_PASSWORD" \
  -prune="$prune_arg" \
  -txindex=0 \
  -persistrecentheaderstime=1 \
  -zmqpubhashblock=tcp://0.0.0.0:28332
