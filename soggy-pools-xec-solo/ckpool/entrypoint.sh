#!/bin/sh
set -eu

RPC_HOST="${XEC_RPC_HOST:-xec-node}"
RPC_PORT="${XEC_RPC_PORT:-8332}"
RPC_USER="${XEC_RPC_USER:-umbrel-xec}"
RPC_PASSWORD="${XEC_RPC_PASSWORD:-}"
SETTINGS_FILE="${SETTINGS_FILE:-/data/settings.json}"
CONF="/var/lib/ckpool/ckpool.conf"
LOGDIR="/var/lib/ckpool/logs"
COINBASE_SIG="/SoggyPools On Umbrel/"

if [ -z "$RPC_PASSWORD" ]; then
  echo "[xec-solo] ERROR: XEC_RPC_PASSWORD is required" >&2
  exit 2
fi

mkdir -p "$LOGDIR" /tmp/ckpool /data
# Umbrel/Docker can leave these behind after an unclean stop. CKPool refuses to
# start when it sees stale instance state, so clear only its runtime sockets/PIDs.
rm -f /tmp/ckpool/*.pid 2>/dev/null || true
find /tmp/ckpool -maxdepth 1 -type s -delete 2>/dev/null || true

json_setting() {
  key="$1"
  fallback="$2"
  if [ -f "$SETTINGS_FILE" ]; then
    value="$(jq -r --arg key "$key" '.[$key] // empty' "$SETTINGS_FILE" 2>/dev/null || true)"
    if [ -n "$value" ] && [ "$value" != "null" ]; then
      printf '%s' "$value"
      return
    fi
  fi
  printf '%s' "$fallback"
}

rpc() {
  method="$1"
  params="${2:-[]}"
  curl -fsS --max-time 8 \
    --user "$RPC_USER:$RPC_PASSWORD" \
    -H 'content-type: application/json' \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"xec-solo\",\"method\":\"$method\",\"params\":$params}" \
    "http://$RPC_HOST:$RPC_PORT/"
}

PAYOUT=""
while [ -z "$PAYOUT" ]; do
  PAYOUT="$(json_setting payoutAddress '')"
  case "$PAYOUT" in
    ecash:*) ;;
    *) PAYOUT="" ;;
  esac
  if [ -z "$PAYOUT" ]; then
    echo "[xec-solo] Waiting for an ecash: payout address. Set it in the dashboard Settings tab."
    sleep 5
  fi
done

START_DIFF="$(json_setting startDiff 1024)"
MIN_DIFF="$(json_setting vardiffMinDiff 1)"
MAX_DIFF="$(json_setting vardiffMaxDiff 0)"

# Keep Stratum closed until the node is at tip and exposes all current eCash
# mining-template data. This avoids handing miners work that cannot form a valid
# post-upgrade XEC block.
while :; do
  chain="$(rpc getblockchaininfo 2>/dev/null || true)"
  if [ -z "$chain" ]; then
    echo "[xec-solo] Waiting for Bitcoin ABC RPC at $RPC_HOST:$RPC_PORT ..."
    sleep 5
    continue
  fi

  actual_chain="$(printf '%s' "$chain" | jq -r '.result.chain // ""' 2>/dev/null || true)"
  ibd="$(printf '%s' "$chain" | jq -r 'if .result.initialblockdownload == null then "true" else (.result.initialblockdownload | tostring) end' 2>/dev/null || echo true)"
  blocks="$(printf '%s' "$chain" | jq -r '.result.blocks // 0' 2>/dev/null || echo 0)"
  headers="$(printf '%s' "$chain" | jq -r '.result.headers // 0' 2>/dev/null || echo 0)"

  if [ "$actual_chain" != "main" ]; then
    echo "[xec-solo] Waiting: expected eCash mainnet, node reports '$actual_chain'."
    sleep 10
    continue
  fi
  if [ "$ibd" != "false" ] || [ "$blocks" -lt "$headers" ]; then
    echo "[xec-solo] Bitcoin ABC syncing: $blocks / $headers blocks. Stratum remains closed."
    sleep 10
    continue
  fi

  template="$(rpc getblocktemplate '[{"capabilities":["coinbasetxn","workid","coinbase/append"],"rules":["segwit"]}]' 2>/dev/null || true)"
  if [ -z "$template" ] || [ "$(printf '%s' "$template" | jq -r '.error // empty' 2>/dev/null)" != "" ]; then
    echo "[xec-solo] Node is at tip but getblocktemplate is not ready yet."
    sleep 5
    continue
  fi

  minerfund="$(printf '%s' "$template" | jq -r '(.result.coinbasetxn.minerfund // .result.minerfund // empty) | type' 2>/dev/null || true)"
  staking="$(printf '%s' "$template" | jq -r '(.result.coinbasetxn.stakingrewards // .result.stakingrewards // empty) | type' 2>/dev/null || true)"
  rtt="$(printf '%s' "$template" | jq -r '.result.rtt.nexttarget // empty' 2>/dev/null || true)"

  if [ "$minerfund" != "object" ]; then
    echo "[xec-solo] Waiting for miner-fund data in the XEC block template."
    sleep 5
    continue
  fi
  if [ "$staking" != "object" ]; then
    echo "[xec-solo] Waiting for the Avalanche staking-reward payout script."
    sleep 5
    continue
  fi
  if [ -z "$rtt" ]; then
    echo "[xec-solo] Waiting for eCash Heartbeat / RTT nexttarget data."
    sleep 5
    continue
  fi
  break
done

jq -n \
  --arg rpcurl "$RPC_HOST:$RPC_PORT" \
  --arg rpcuser "$RPC_USER" \
  --arg rpcpass "$RPC_PASSWORD" \
  --arg payout "$PAYOUT" \
  --arg sig "$COINBASE_SIG" \
  --arg zmq "tcp://$RPC_HOST:28332" \
  --arg logdir "$LOGDIR" \
  --argjson startdiff "$START_DIFF" \
  --argjson mindiff "$MIN_DIFF" \
  --argjson maxdiff "$MAX_DIFF" \
  '{
    btcd: [{url:$rpcurl, auth:$rpcuser, pass:$rpcpass, notify:false}],
    btcaddress:$payout,
    btcsig:$sig,
    blockpoll:100,
    donation:0.0,
    nonce1length:4,
    nonce2length:8,
    update_interval:30,
    version_mask:"1fffe000",
    serverurl:["0.0.0.0:3333"],
    mindiff:$mindiff,
    startdiff:$startdiff,
    maxdiff:$maxdiff,
    zmqblock:$zmq,
    logdir:$logdir
  }' > "$CONF"
chmod 600 "$CONF"

cat <<EOF2
==============================================================
 Soggy Pools — XEC Solo Pool
==============================================================
 Network:       eCash mainnet
 Backend:       $RPC_HOST:$RPC_PORT
 Payout:        $PAYOUT
 Stratum:       0.0.0.0:3333
 Start diff:    $START_DIFF
 Min diff:      $MIN_DIFF
 Max diff:      $MAX_DIFF (0 = unlimited)
 Pool fee:      0%
 Coinbase tag:  SoggyPools On Umbrel
 eCash mode:    enabled (-x)
 Share logging: enabled (-L)
==============================================================
EOF2

# Fixed-address solo pool: deliberately DO NOT pass -B. In upstream CKPool,
# -B ignores btcaddress and treats miner usernames as payout addresses. Here all
# worker labels mine to the one ecash: address saved in Settings.
exec /usr/local/bin/ckpool -x -L -l 5 -c "$CONF"
