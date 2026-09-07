# XEC Solo Pool for Umbrel

Self-hosted eCash (XEC) SHA-256 solo mining for the Soggy Pools Umbrel App Store.

## Components

- **Official Bitcoin ABC Docker image** (0.33.11 at v0.1.0 packaging time), mainnet only in v0.1.0
- **Bitcoin-ABC/ecash-ckpool-solo** built from upstream `master`
- Fixed, checksum-validated `ecash:` coinbase payout address
- `SoggyPools On Umbrel` coinbase tag
- ZEC-style Overview / Miners / Blocks / Settings dashboard
- Pruned or archive mode; default prune target is 5,000 MiB
- CKPool start/min/max difficulty controls
- 0% pool fee / donation
- Share logging and best-share telemetry
- eCash Heartbeat / Real Time Target-aware dashboard odds

## Ports

- Umbrel dashboard: **3281**
- Stratum: **3335** (`stratum+tcp://<umbrel-ip>:3335`)
- Bitcoin ABC RPC is not published to the host/LAN.

## First run

1. Install the app from the Soggy Pools community store.
2. Open **Settings** and save a mainnet `ecash:` payout address.
3. Leave the default 5,000 MiB prune target or choose Archive.
4. Restart the app after settings changes.
5. Let Bitcoin ABC finish Initial Block Download.
6. CKPool automatically waits for a complete XEC mining template before opening Stratum.
7. Point a SHA-256 ASIC at `stratum+tcp://<umbrel-ip>:3335`, use any friendly worker name, and password `x`.

## Fixed payout behavior

This app deliberately starts CKPool with `-x` but **without `-B`**. CKPool's `-B` mode treats miner usernames as payout addresses and ignores `btcaddress`. Without `-B`, this app uses the one fixed `ecash:` address saved in Settings, so names like `NerdQaxe-1` are safe worker labels.

## XEC template safety

Stratum remains closed until Bitcoin ABC is synced and its current block template exposes:

- miner-fund data,
- Avalanche staking-reward payout data, and
- `rtt.nexttarget` for eCash Heartbeat / Real Time Targeting.

The node runs with `persistrecentheaderstime=1` so RTT has the recent header timing data it needs after restarts.
