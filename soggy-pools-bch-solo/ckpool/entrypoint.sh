#!/usr/bin/env sh
set -eu

SETTINGS_FILE="${SETTINGS_FILE:-/data/settings.json}"
RPC_HOST="${BCH_RPC_HOST:-bchn}"
RPC_PORT="${BCH_RPC_PORT:-8332}"
RPC_USER="${BCH_RPC_USER:-umbrel-bch}"
RPC_PASSWORD="${BCH_RPC_PASSWORD:?BCH_RPC_PASSWORD is required}"
ZMQ_PORT="${BCH_ZMQ_PORT:-29000}"

mkdir -p /data /var/lib/ckpool /tmp/ckpool

# ckpool-runtime is a named volume and survives container recreation. CKPool can
# otherwise see an old main.pid or Unix sockets and loop on startup even though
# the old process no longer exists.
rm -f /tmp/ckpool/*.pid 2>/dev/null || true
find /tmp/ckpool -maxdepth 1 -type s -delete 2>/dev/null || true

if [ ! -f "$SETTINGS_FILE" ]; then
  cat > "$SETTINGS_FILE" <<'JSON'
{
  "network": "mainnet",
  "payoutAddress": "",
  "storageMode": "pruned",
  "pruneTargetMb": 10240,
  "startDiff": 10000,
  "vardiffMinDiff": 1000,
  "vardiffMaxDiff": 2000000
}
JSON
fi

network="$(jq -r '.network // "mainnet"' "$SETTINGS_FILE" 2>/dev/null || echo mainnet)"
case "$network" in
  testnet|testnet4) network="testnet4"; expected_chain="test4" ;;
  *) network="mainnet"; expected_chain="main" ;;
esac

RUNROOT="/var/lib/ckpool/$network"
CONFIG="$RUNROOT/ckpool.conf"
LOGDIR="$RUNROOT/logs"
mkdir -p "$LOGDIR"

rpc_call() {
  method="$1"
  params="${2:-[]}"
  curl -sS --connect-timeout 2 --max-time 8 \
    --user "$RPC_USER:$RPC_PASSWORD" \
    -H 'content-type: application/json' \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"soggypools\",\"method\":\"$method\",\"params\":$params}" \
    "http://${RPC_HOST}:${RPC_PORT}/" 2>/dev/null || true
}

while :; do
  payout="$(jq -r '.payoutAddress // ""' "$SETTINGS_FILE" 2>/dev/null || true)"
  if [ -n "$payout" ]; then
    break
  fi
  echo "[bch-solo] Waiting for $network payout address to be configured in dashboard..."
  sleep 5
done

# Do not expose Stratum until BCHN RPC is genuinely ready, on the requested
# chain, out of IBD, and able to return a usable block template.
while :; do
  info="$(rpc_call getblockchaininfo '[]')"
  actual_chain="$(printf '%s' "$info" | jq -r '.result.chain // empty' 2>/dev/null || true)"
  rpc_error="$(printf '%s' "$info" | jq -r '.error.message // empty' 2>/dev/null || true)"

  if [ -z "$actual_chain" ]; then
    echo "[bch-solo] Waiting for BCHN RPC${rpc_error:+: $rpc_error}..."
    sleep 5
    continue
  fi

  case "$network:$actual_chain" in
    mainnet:main|mainnet:mainnet|testnet4:test4|testnet4:test|testnet4:testnet4) ;;
    *)
      echo "[bch-solo] BCHN network mismatch: settings=$network but RPC chain=$actual_chain. Waiting for app restart/network switch..."
      sleep 5
      continue
      ;;
  esac

  # Preserve a real JSON false; jq's // operator treats false like a missing
  # value and was the cause of the old 100%-synced startup loop.
  ibd="$(printf '%s' "$info" | jq -r 'if .result.initialblockdownload == null then "true" else (.result.initialblockdownload | tostring) end')"
  blocks="$(printf '%s' "$info" | jq -r '.result.blocks // 0')"
  headers="$(printf '%s' "$info" | jq -r '.result.headers // 0')"
  if [ "$ibd" = "true" ] || [ "$blocks" -lt "$headers" ]; then
    echo "[bch-solo] BCHN $network syncing: $blocks/$headers. CKPool will start at chain tip."
    sleep 5
    continue
  fi

  gbt="$(rpc_call getblocktemplate '[{"capabilities":["coinbasetxn","workid","coinbase/append"]}]')"
  if [ "$(printf '%s' "$gbt" | jq -r '(.result != null) and (.error == null)' 2>/dev/null || echo false)" != "true" ]; then
    gbt_error="$(printf '%s' "$gbt" | jq -r '.error.message // "block template unavailable"' 2>/dev/null || echo 'block template unavailable')"
    echo "[bch-solo] BCHN has no usable block template yet: $gbt_error"
    sleep 5
    continue
  fi
  break
done

# Keep the address the user entered for UI/settings, but use a legacy Testnet
# representation for CKPool's configured fallback when a bchtest: CashAddr is
# selected. This avoids the historical BCHN test4/CashAddr prefix mismatch.
ckpool_payout="$payout"
case "$network:$payout" in
  testnet4:bchtest:*)
    if converted="$(cashaddr-to-legacy "$payout" 2>/dev/null)" && [ -n "$converted" ]; then
      ckpool_payout="$converted"
    else
      echo "[bch-solo] Could not convert Testnet4 CashAddr fallback payout: $payout" >&2
      exit 1
    fi
    ;;
esac

start_diff="$(jq -r '.startDiff // 10000' "$SETTINGS_FILE")"
vardiff_min="$(jq -r '.vardiffMinDiff // .minDiff // 1000' "$SETTINGS_FILE")"
vardiff_max="$(jq -r '.vardiffMaxDiff // .maxDiff // 2000000' "$SETTINGS_FILE")"

# SoggyPools SHA256 VarDiff policy.
# Intentionally server-controlled rather than user configurable.
vardiff_enabled=true
vardiff_target=30
vardiff_retarget=120
vardiff_tolerance=0.50
vardiff_up=2
vardiff_down=2
vardiff_grace=60

COINBASE_SIG="SoggyPools On Umbrel"

jq -n \
  --arg rpc "${RPC_HOST}:${RPC_PORT}" \
  --arg user "$RPC_USER" \
  --arg pass "$RPC_PASSWORD" \
  --arg zmq "tcp://${RPC_HOST}:${ZMQ_PORT}" \
  --arg payout "$ckpool_payout" \
  --arg sig "$COINBASE_SIG" \
  --arg logdir "$LOGDIR" \
  --argjson start "$start_diff" \
  --argjson vardiff_enabled "$vardiff_enabled" \
  --argjson vardiff_target "$vardiff_target" \
  --argjson vardiff_retarget "$vardiff_retarget" \
  --argjson vardiff_tolerance "$vardiff_tolerance" \
  --argjson vardiff_min "$vardiff_min" \
  --argjson vardiff_max "$vardiff_max" \
  --argjson vardiff_up "$vardiff_up" \
  --argjson vardiff_down "$vardiff_down" \
  --argjson vardiff_grace "$vardiff_grace" \
  '{
    btcd: [{url:$rpc, auth:$user, pass:$pass, notify:true, zmqnotify:$zmq}],
    bchaddress:$payout,
    btcaddress:$payout,
    pooladdress:$payout,
    poolfee:0,
    btcsig:$sig,
    blockpoll:50,
    update_interval:15,
    logdir:$logdir,
    serverurl:["0.0.0.0:3333"],
    mindiff:$vardiff_min,
    startdiff:$start,
    maxdiff:$vardiff_max,
    vardiff_enabled:$vardiff_enabled,
    vardiff_target_sec:$vardiff_target,
    vardiff_retarget_sec:$vardiff_retarget,
    vardiff_tolerance:$vardiff_tolerance,
    vardiff_max_up_factor:$vardiff_up,
    vardiff_max_down_factor:$vardiff_down,
    vardiff_grace_sec:$vardiff_grace
  }' > "$CONFIG"

# Jansson/CKPool distinguishes integer from real JSON values. jq serializes
# numeric zero as `0` even if written 0.0 in the program, so force the literal
# representation CKPool expects.
sed -i 's/"poolfee": 0,/"poolfee": 0.0,/' "$CONFIG"
if ! grep -q '"poolfee": 0.0,' "$CONFIG"; then
  echo '[bch-solo] Failed to write poolfee as JSON real 0.0' >&2
  exit 1
fi

echo "[bch-solo] Starting BCH CKPool in solo mode on :3333"
echo "[bch-solo] Network: $network (BCHN chain=$actual_chain)"
echo "[bch-solo] Coinbase signature: $COINBASE_SIG"
echo "[bch-solo] Fallback payout address: $payout"
echo "[bch-solo] VarDiff policy: min=$vardiff_min start=$start_diff max=$vardiff_max target=${vardiff_target}s retarget=${vardiff_retarget}s tolerance=50% max-step=2x grace=${vardiff_grace}s"
if [ "$ckpool_payout" != "$payout" ]; then
  echo "[bch-solo] CKPool-compatible payout address: $ckpool_payout"
fi

# Default ckpool socket parent is /tmp and instance name is ckpool, yielding
# /tmp/ckpool/{main.pid,stratifier,...}, which is the shared volume the adapter
# reads via ckpmsg.
exec ckpool -B -L -c "$CONFIG"
