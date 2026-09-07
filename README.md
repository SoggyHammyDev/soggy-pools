# Soggy Pools Umbrel App Store

Community Umbrel app store for **Soggy Pools**.

## BCH Solo Pool v0.1.8

Self-hosted Bitcoin Cash solo mining with:

- Bitcoin Cash Node (BCHN)
- BlockSniper/CKPool BCH fork in solo mode
- Mainnet and BCH Testnet4
- Fixed coinbase signature: `SoggyPools On Umbrel`
- Configurable pruned/archive storage and prune target
- **The same ZEC-style Overview / Miners / Blocks / Settings dashboard**
- Share heartbeat, recent shares, per-miner best share and odds
- Configurable start difficulty and VarDiff controls
- Stratum exposed on host port `3334`

### v0.1.8 Testnet4 / Stratum runtime fixes

This release carries the working fixes discovered while debugging the Umbrel
Testnet4 deployment:

- Clears stale CKPool PID files and Unix sockets from the persistent
  `ckpool-runtime` volume before startup.
- BCHN explicitly receives the configured `-rpcport` and ZMQ port.
- BCHN launches with `-testnet4` for the Testnet4 setting.
- CKPool waits for BCHN RPC readiness, matching network, completed IBD, and a
  valid `getblocktemplate` before opening Stratum.
- Preserves `initialblockdownload: false` correctly instead of turning it back
  into true with jq's `//` operator.
- Writes CKPool `poolfee` as the JSON real value `0.0` (not integer `0`).
- Recognizes BCHN's Testnet4 chain identifier `test4`.
- Converts a configured `bchtest:` fallback payout to its equivalent legacy
  Testnet address for CKPool configuration while keeping the original
  `bchtest:` value in dashboard settings.
- Includes a narrow CKPool source compatibility patch for `test4` CashAddr
  network selection.
- Keeps mainnet and Testnet4 CKPool logs separate.

### Dashboard

The BCH web UI intentionally stays on the newer ZEC dashboard layout: Overview,
Miners, Blocks, and Settings tabs; share heartbeat; recent shares; miner cards;
node/pool diagnostics; current job panel; and the same visual hierarchy. BCH-only
changes are terminology, H/s formatting, Testnet4, BCH payout addresses, and the
prune target control.

### Build / GHCR

- Every push to `main` launches all four GHCR builds automatically.
- The release tag is read from `umbrel-app.yml` automatically.
- Each image is pushed as both the release version and `latest`.
- CI verifies each published GHCR image before the matrix job completes.

### Mining endpoint

`stratum+tcp://<umbrel-ip>:3334`

Named workers such as `NerdQaxe-1` use the payout address configured in the
dashboard. Pool fee is fixed at 0%.
