'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8081);
const RPC_HOST = process.env.BCH_RPC_HOST || 'bchn';
const RPC_PORT = Number(process.env.BCH_RPC_PORT || 8332);
const RPC_USER = process.env.BCH_RPC_USER || 'umbrel-bch';
const RPC_PASSWORD = process.env.BCH_RPC_PASSWORD || '';
const STRATUM_PORT = Number(process.env.STRATUM_PORT || 3334);
const SETTINGS_FILE = process.env.SETTINGS_FILE || '/data/settings.json';
const CKPOOL_HOST = process.env.CKPOOL_HOST || 'ckpool';
const CKPOOL_PORT = Number(process.env.CKPOOL_PORT || 3333);
const CKPOOL_LOG_ROOT = process.env.CKPOOL_LOG_ROOT || '/var/lib/ckpool';
const COINBASE_SIG = 'SoggyPools On Umbrel';
const DIFF1_HASHES = 4294967296;

const DEFAULTS = Object.freeze({
  network: 'mainnet',
  payoutAddress: '',
  storageMode: 'pruned',
  pruneTargetMb: 10240,
  startDiff: 500,
  vardiffEnabled: true,
  vardiffTargetSec: 10,
  vardiffRetargetSec: 30,
  vardiffTolerance: 0.30,
  vardiffMinDiff: 1,
  vardiffMaxDiff: 1000000000,
  vardiffMaxUpFactor: 8,
  vardiffMaxDownFactor: 4,
  vardiffGraceSec: 15,
});

let rpcId = 0;

function ensureSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
  }
}

function migrateSettings(raw) {
  const next = { ...DEFAULTS, ...(raw || {}) };
  next.network = next.network === 'testnet4' ? 'testnet4' : 'mainnet';
  next.storageMode = next.storageMode === 'archive' ? 'archive' : 'pruned';
  // Migrate the earlier BCH dashboard's min/max names into the canonical ZEC controls.
  if (raw && raw.vardiffMinDiff == null && raw.minDiff != null) next.vardiffMinDiff = raw.minDiff;
  if (raw && raw.vardiffMaxDiff == null && raw.maxDiff != null) next.vardiffMaxDiff = raw.maxDiff;
  delete next.dbCacheMb;
  delete next.coinbaseTag;
  delete next.minDiff;
  delete next.maxDiff;
  delete next.mrrDiff;
  delete next.nicehashDiff;
  return next;
}

function readSettings() {
  ensureSettings();
  try {
    return migrateSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

function atomicWriteSettings(value) {
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS_FILE);
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function rpc(method, params = [], timeout = 4500) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params });
    const auth = Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString('base64');
    const req = http.request({
      host: RPC_HOST,
      port: RPC_PORT,
      method: 'POST',
      path: '/',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (c) => { text += c; });
      response.on('end', () => {
        try {
          const body = JSON.parse(text);
          if (body.error) return reject(new Error(body.error.message || JSON.stringify(body.error)));
          resolve(body.result);
        } catch (e) {
          reject(new Error(`Invalid BCHN RPC response: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`BCHN ${method} timeout`)));
    req.on('error', reject);
    req.end(payload);
  });
}

async function safeRpc(method, params = [], fallback = null) {
  try { return await rpc(method, params); } catch { return fallback; }
}

function extractJson(text) {
  const marker = 'Received response: ';
  let source = String(text || '');
  const markerAt = source.indexOf(marker);
  if (markerAt >= 0) source = source.slice(markerAt + marker.length);
  source = source.replace(/\r?\n/g, '').trim();

  const start = source.search(/[\[{]/);
  if (start < 0) return null;
  source = source.slice(start);

  const open = source[0];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inString = false, escape = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(source.slice(0, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ckpmsg reads commands from stdin. -s is the parent directory, not the socket path.
function ckmsg(command, processName = 'stratifier') {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let child;
    try {
      child = spawn('/usr/local/bin/ckpmsg', ['-s', '/tmp', '-n', 'ckpool', '-N', processName], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      return resolve(null);
    }

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(extractJson(stdout));
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', done);
    child.once('close', done);
    child.stdin.end(String(command) + '\n');
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done();
    }, 2500);
  });
}

function stratumProbe() {
  return new Promise((resolve) => {
    let finished = false;
    let connected = false;
    let data = '';
    const socket = net.createConnection({ host: CKPOOL_HOST, port: CKPOOL_PORT });

    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      connected = true;
      socket.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['SoggyPools-Dashboard/0.1.96'] }) + '\n');
    });
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n') || data.length > 2) done({ open: true, responsive: true, sample: data.slice(0, 256) });
    });
    socket.once('error', () => done({ open: false, responsive: false, sample: '' }));
    const timer = setTimeout(() => done({ open: connected, responsive: data.length > 0, sample: data.slice(0, 256) }), 1800);
  });
}

function number(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeChain(chain) {
  const value = String(chain || '').trim().toLowerCase();
  if (value === 'main' || value === 'mainnet') return 'mainnet';
  // BCHN reports Testnet4 as `test4` in getblockchaininfo. Keep the older
  // aliases too so the dashboard remains compatible across BCHN releases.
  if (value === 'test4' || value === 'testnet4' || value === 'test') return 'testnet4';
  return value || null;
}

function chainMatches(network, chain) {
  return normalizeChain(chain) === (network === 'testnet4' ? 'testnet4' : 'mainnet');
}

function networkLabel(network) {
  return network === 'testnet4' ? 'Testnet4' : 'Mainnet';
}

function dspsToHashrate(dsps) {
  return Math.max(0, number(dsps, 0)) * DIFF1_HASHES;
}

function walkFiles(root, depth = 5, out = []) {
  if (depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(p, depth - 1, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function readTail(file, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, Math.max(0, stat.size - length));
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), stat };
  } catch {
    return null;
  }
}

function createdateMs(value, fallbackMs) {
  const m = String(value || '').match(/^(\d+)(?:,(\d+))?/);
  if (!m) return fallbackMs;
  const sec = Number(m[1]);
  const ns = Number(m[2] || 0);
  return sec * 1000 + Math.floor(ns / 1e6);
}

function recentShareLog(network, currentNetworkDiff) {
  const root = path.join(CKPOOL_LOG_ROOT, network === 'testnet4' ? 'testnet4' : 'mainnet', 'logs');
  const files = walkFiles(root)
    .filter((p) => p.endsWith('.sharelog'))
    .map((p) => { try { return { p, s: fs.statSync(p) }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
    .slice(0, 24);

  const entries = [];
  for (const file of files) {
    const tail = readTail(file.p);
    if (!tail) continue;
    for (const line of tail.text.split(/\r?\n/)) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const raw = JSON.parse(line);
        const atMs = createdateMs(raw.createdate, file.s.mtimeMs);
        const shareDiff = number(raw.sdiff, 0);
        const accepted = raw.result === true;
        entries.push({
          workerName: String(raw.workername || raw.username || 'miner'),
          worker: String(raw.workername || raw.username || 'miner'),
          userAgent: String(raw.agent || ''),
          result: accepted ? 'accepted' : 'rejected',
          reason: accepted ? '' : String(raw['reject-reason'] || (Array.isArray(raw.error) ? raw.error[1] : '') || ''),
          shareDiff,
          networkDiff: number(currentNetworkDiff, 0),
          blockCandidate: shareDiff > 0 && currentNetworkDiff > 0 && shareDiff >= currentNetworkDiff * 0.999,
          at: new Date(atMs).toISOString(),
          atMs,
          hash: String(raw.hash || ''),
          assignedDiff: number(raw.diff, 0),
          sourceFile: path.relative(root, file.p),
        });
      } catch {}
    }
  }

  const deduped = [];
  const seen = new Set();
  entries.sort((a, b) => b.atMs - a.atMs);
  for (const entry of entries) {
    const key = entry.hash || `${entry.workerName}:${entry.atMs}:${entry.shareDiff}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
    if (deduped.length >= 250) break;
  }
  return { entries: deduped, latestFile: files[0] ? path.relative(root, files[0].p) : null };
}

function recentBlocks(network = 'mainnet') {
  const safe = network === 'testnet4' ? 'testnet4' : 'mainnet';
  const root = path.join(CKPOOL_LOG_ROOT, safe, 'logs');
  const candidates = [path.join(root, 'ckpool.log'), ...walkFiles(root, 2).filter((p) => p.endsWith('.log'))];
  const files = [...new Set(candidates)].map((p) => {
    try { return { p, s: fs.statSync(p) }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.s.mtimeMs - a.s.mtimeMs).slice(0, 8);

  const rows = [];
  for (const file of files) {
    const tail = readTail(file.p, 1024 * 1024);
    if (!tail) continue;
    for (const line of tail.text.split(/\r?\n/)) {
      if (!/(Solved and confirmed block|BLOCK ACCEPTED|block solve)/i.test(line)) continue;
      const hash = line.match(/\b[0-9a-f]{64}\b/i)?.[0] || '';
      const height = Number(line.match(/(?:block|height)\D{0,12}(\d{4,})/i)?.[1] || 0);
      const proven = /Solved and confirmed block|BLOCK ACCEPTED/i.test(line);
      const stamp = line.match(/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?)\]/)?.[1];
      const at = stamp ? new Date(stamp.replace(' ', 'T')).toISOString() : new Date(file.s.mtimeMs).toISOString();
      rows.push({ height, result: proven ? 'proven' : 'submitting', hash, at });
    }
  }
  const seen = new Set();
  return rows.filter((b) => {
    const key = b.hash || `${b.height}:${b.at}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 25);
}

function normalizeWorkers(workersRaw, clientsRaw, shareEntries) {
  const workerList = Array.isArray(workersRaw?.workers)
    ? workersRaw.workers
    : (Array.isArray(workersRaw) ? workersRaw : []);

  const clientList = Array.isArray(clientsRaw?.clients)
    ? clientsRaw.clients
    : (Array.isArray(clientsRaw) ? clientsRaw : []);

  const names = new Set();
  const workerByName = new Map();

  for (const w of workerList) {
    const name = String(
      w?.worker ||
      w?.workername ||
      ''
    ).trim();

    if (!name) continue;

    names.add(name);
    workerByName.set(name, w);
  }

  for (const c of clientList) {
    if (c?.authorised === false) continue;

    const name = String(
      c?.workername ||
      c?.worker ||
      ''
    ).trim();

    if (name) names.add(name);
  }

  const shareCounts = new Map();
  const bestShareByName = new Map();
  const latestShareByName = new Map();
  const latestAssignedDiffByName = new Map();

  for (const entry of shareEntries) {
    if (entry.result !== 'accepted') continue;

    const name = String(
      entry.workerName ||
      entry.worker ||
      ''
    ).trim();

    if (!name) continue;

    names.add(name);

    shareCounts.set(
      name,
      (shareCounts.get(name) || 0) + 1
    );

    const shareDiff = number(
      entry.shareDiff,
      0
    );

    const assignedDiff = number(
      entry.assignedDiff,
      0
    );

    bestShareByName.set(
      name,
      Math.max(
        bestShareByName.get(name) || 0,
        shareDiff
      )
    );

    const atMs = number(entry.atMs, 0);

    const atSec = atMs > 0
      ? Math.floor(atMs / 1000)
      : number(entry.at, 0);

    if (
      atSec >=
      (latestShareByName.get(name) || 0)
    ) {
      latestShareByName.set(
        name,
        atSec
      );

      latestAssignedDiffByName.set(
        name,
        assignedDiff
      );
    }
  }

  const now = Math.floor(
    Date.now() / 1000
  );

  const nowMs = Date.now();

  const DIFF1_WORK = 4294967296;

  /*
   * CKPool on this BCH build does not reliably return
   * workers/clients/poolstats over ckpmsg.
   *
   * When native dsps1 data is unavailable, estimate miner
   * hashrate from accepted assigned difficulty:
   *
   *   H/s = sum(assignedDiff * 2^32) / seconds
   *
   * Use up to a five-minute rolling window.
   */

  const acceptedTimes = shareEntries
    .filter((entry) =>
      entry.result === 'accepted' &&
      number(entry.assignedDiff, 0) > 0 &&
      number(entry.atMs, 0) > 0
    )
    .map((entry) =>
      number(entry.atMs, 0)
    );

  const oldestAcceptedMs =
    acceptedTimes.length
      ? Math.min(...acceptedTimes)
      : 0;

  const availableSeconds =
    oldestAcceptedMs > 0
      ? Math.max(
          0,
          (nowMs - oldestAcceptedMs) / 1000
        )
      : 0;

  const estimateWindowSeconds =
    availableSeconds > 0
      ? Math.max(
          60,
          Math.min(
            300,
            availableSeconds
          )
        )
      : 300;

  const estimateCutoffMs =
    nowMs -
    estimateWindowSeconds * 1000;

  return Array.from(names).map((name) => {
    const w =
      workerByName.get(name) ||
      {};

    const clients = clientList.filter((c) => {
      const clientName = String(
        c?.workername ||
        c?.worker ||
        ''
      ).trim();

      return (
        clientName === name &&
        c?.authorised !== false
      );
    });

    const start = clients.reduce(
      (min, c) => {
        const v = number(
          c.starttime,
          0
        );

        return (
          v > 0 &&
          (min === 0 || v < min)
        )
          ? v
          : min;
      },
      0
    );

    const bestClient = clients.reduce(
      (best, c) =>
        number(c.bestdiff, 0) >
        number(best?.bestdiff, 0)
          ? c
          : best,
      null
    );

    const diff =
      clients.reduce(
        (max, c) =>
          Math.max(
            max,
            number(c.diff, 0)
          ),
        0
      ) ||
      number(w.mindiff, 0) ||
      latestAssignedDiffByName.get(name) ||
      0;

    const userAgent =
      bestClient?.useragent ||
      clients.find(
        (c) => c.useragent
      )?.useragent ||
      '';

    const bestDiff = Math.max(
      number(w.bestdiff, 0),
      ...clients.map(
        (c) =>
          number(c.bestdiff, 0)
      ),
      bestShareByName.get(name) || 0,
      0
    );

    const lastShare =
      number(w.lastshare, 0) ||
      latestShareByName.get(name) ||
      null;

    const dot = name.indexOf('.');

    const displayName =
      dot >= 0 &&
      dot < name.length - 1
        ? name.slice(dot + 1)
        : name;

    const upstreamHashrate =
      dspsToHashrate(w.dsps1) ||
      clients.reduce(
        (sum, c) =>
          sum +
          dspsToHashrate(c.dsps1),
        0
      );

    const assignedWork =
      shareEntries.reduce(
        (sum, entry) => {
          if (
            entry.result !==
            'accepted'
          ) {
            return sum;
          }

          const entryName = String(
            entry.workerName ||
            entry.worker ||
            ''
          ).trim();

          if (entryName !== name) {
            return sum;
          }

          const atMs = number(
            entry.atMs,
            0
          );

          if (
            atMs <= 0 ||
            atMs < estimateCutoffMs
          ) {
            return sum;
          }

          return (
            sum +
            number(
              entry.assignedDiff,
              0
            )
          );
        },
        0
      );

    const estimatedHashrate =
      assignedWork > 0
        ? (
            assignedWork *
            DIFF1_WORK /
            estimateWindowSeconds
          )
        : 0;

    return {
      workerName: name,
      worker: name,
      displayName,

      user:
        String(w.user || ''),

      userAgent:
        String(userAgent),

      hashrate1m:
        upstreamHashrate ||
        estimatedHashrate,

      hashrateEstimated:
        upstreamHashrate <= 0 &&
        estimatedHashrate > 0,

      hashrateWindowSeconds:
        estimateWindowSeconds,

      shareDifficulty:
        diff,

      difficulty:
        diff,

      shares:
        shareCounts.get(name) || 0,

      bestDiff,

      connectedSeconds:
        start > 0
          ? Math.max(
              0,
              now - start
            )
          : 0,

      lastShare,

      idle:
        clients.length === 0 &&
        Boolean(w.idle),
    };
  }).filter((w) =>
    w.connectedSeconds > 0 ||
    w.shares > 0 ||
    w.lastShare ||
    !w.idle
  );
}
async function status() {
  const settings = readSettings();
  let chain = null;
  let nodeError = null;
  try {
    chain = await rpc('getblockchaininfo', [], 15000).catch(() => rpc('getblockchaininfo', [], 15000));
  } catch (e) {
    nodeError = e.message;
  }

  const configuredLabel = networkLabel(settings.network);
  const actualChain = chain?.chain || null;
  const networkOk = Boolean(chain && chainMatches(settings.network, actualChain));

  let nodeStatus = 'unavailable';
  if (chain) {
    if (!networkOk) nodeStatus = 'wrong-network';
    else if (chain.initialblockdownload || number(chain.verificationprogress) < 0.9999 || number(chain.blocks) < number(chain.headers)) nodeStatus = 'syncing';
    else nodeStatus = 'ready';
  }

  if (chain && !networkOk) {
    const actualNetwork = normalizeChain(actualChain);
    const actual = actualNetwork === 'mainnet' ? 'Mainnet' : actualNetwork === 'testnet4' ? 'Testnet4' : (actualChain || 'unknown');
    nodeError = `Network mismatch: Settings are ${configuredLabel}, but BCHN is running ${actual}. Restart the BCH Solo Pool app after changing networks.`;
  }

  const nodeReady = nodeStatus === 'ready';
  const [peers, mempool, networkHashps, nodeUptime, difficulty, gbt] = await Promise.all([
    chain ? safeRpc('getconnectioncount') : null,
    chain ? safeRpc('getmempoolinfo') : null,
    chain ? safeRpc('getnetworkhashps') : null,
    chain ? safeRpc('uptime') : null,
    chain ? safeRpc('getdifficulty') : null,
    nodeReady ? safeRpc('getblocktemplate', [{ capabilities: ['coinbasetxn', 'workid', 'coinbase/append'] }]) : null,
  ]);

  const [probe, poolstats, workersRaw, clientsRaw, uptimeRaw, workRaw] = await Promise.all([
    stratumProbe(), ckmsg('poolstats'), ckmsg('workers'), ckmsg('clients'), ckmsg('uptime'), ckmsg('current.workbase')
  ]);

  const shareData = recentShareLog(settings.network, difficulty);
  const workers = normalizeWorkers(workersRaw, clientsRaw, shareData.entries);
  const accepted = number(poolstats?.shares, shareData.entries.filter((s) => s.result === 'accepted').length);
  const rejected = shareData.entries.filter((s) => s.result === 'rejected').length;
  const uptimeSeconds = number(uptimeRaw?.uptime, poolstats?.start ? Math.max(0, Math.floor(Date.now() / 1000) - number(poolstats.start)) : 0);

  let poolStatus = 'offline';
  let poolError = null;
  if (!settings.payoutAddress) {
    poolStatus = 'waiting-address';
    poolError = `Set a ${configuredLabel} payout address, save it, then restart the app.`;
  } else if (!nodeReady) {
    poolStatus = 'waiting-node';
    if (nodeStatus === 'syncing') poolError = `CKPool is intentionally waiting for ${configuredLabel} BCHN to finish syncing before opening Stratum.`;
    else if (nodeStatus === 'wrong-network') poolError = 'CKPool is waiting because BCHN is on the wrong network for the saved setting.';
  } else if (probe.responsive) {
    poolStatus = 'ready';
  } else if (probe.open) {
    poolStatus = 'starting';
    poolError = 'Host reachable but Stratum did not answer a mining.subscribe probe. CKPool may still be building its first workbase.';
  } else {
    poolStatus = 'offline';
    poolError = 'Stratum is not listening yet. CKPool will start automatically once BCHN can provide a valid block template.';
  }

  const candidateHeight = number(gbt?.height, 0) || (chain ? number(chain.blocks) + 1 : null);
  const jobId = workRaw?.jobid ?? workRaw?.id ?? workRaw?.workinfoid ?? (gbt?.longpollid ? String(gbt.longpollid).slice(0, 12) : (gbt?.previousblockhash ? String(gbt.previousblockhash).slice(0, 12) : null));
  const currentBits = gbt?.bits || workRaw?.bits || workRaw?.nbit || null;
  const shareTarget = gbt?.target || workRaw?.target || null;
  const sharesPerMinute = number(poolstats?.sps1, 0) * 60;
  const tape = shareData.entries.filter((s) => s.result === 'accepted' && s.atMs >= Date.now() - 600000).map((s) => s.atMs);

  return {
    node: {
      status: nodeStatus,
      error: nodeError,
      configuredNetwork: settings.network,
      networkLabel: configuredLabel,
      actualChain,
      actualNetwork: normalizeChain(actualChain),
      height: chain?.blocks ?? null,
      headers: chain?.headers ?? null,
      blocksRemaining: chain ? Math.max(0, number(chain.headers) - number(chain.blocks)) : null,
      syncPercent: chain ? Math.max(0, Math.min(100, number(chain.verificationprogress) * 100)) : null,
      peers,
      mempoolBytes: mempool?.bytes ?? mempool?.usage ?? null,
      diskUsedBytes: chain?.size_on_disk ?? null,
      networkHashps,
      difficulty,
      pruned: chain?.pruned ?? null,
      uptimeSeconds: nodeUptime,
    },
    pool: {
      status: poolStatus,
      error: poolError,
      job: jobId,
      jobHeight: candidateHeight,
      currentNetworkDiff: difficulty,
      currentBits,
      shareTarget,
      stratumPort: STRATUM_PORT,
      sharesPerMinute,
      sharesAccepted: accepted,
      sharesRejected: rejected,
      hashrate1m: dspsToHashrate(poolstats?.dsps1) || workers.reduce((sum, w) => sum + number(w.hashrate1m), 0),
      uptimeSeconds,
      bestDiff: workers.reduce((max, w) => Math.max(max, number(w.bestDiff)), 0),
      startDiff: settings.startDiff,
      shareLogFile: shareData.latestFile || 'waiting for first share',
      coinbaseSig: COINBASE_SIG,
      stratumProbe: { open: probe.open, responsive: probe.responsive },
    },
    workers,
    shareLog: shareData.entries.slice(0, 100),
    blocks: recentBlocks(settings.network),
    tape,
    settings,
  };
}

function cleanSettings(body) {
  const out = { ...readSettings() };
  out.network = body.network === 'testnet4' ? 'testnet4' : 'mainnet';

  const addr = String(body.payoutAddress ?? '').trim();
  const mainCashAddr = /^(bitcoincash:)?[qp][a-z0-9]{40,70}$/i;
  const mainLegacy = /^[13][a-km-zA-HJ-NP-Z1-9]{25,40}$/;
  const testCashAddr = /^(bchtest:)[qp][a-z0-9]{40,70}$/i;
  const testLegacy = /^[mn2][a-km-zA-HJ-NP-Z1-9]{25,40}$/;

  if (addr) {
    if (out.network === 'testnet4' && !testCashAddr.test(addr) && !testLegacy.test(addr)) {
      throw new Error('Testnet4 requires a BCH testnet address (bchtest:q… or a legacy testnet address).');
    }
    if (out.network === 'mainnet' && !mainCashAddr.test(addr) && !mainLegacy.test(addr)) {
      throw new Error('Mainnet requires a BCH mainnet address (bitcoincash:q… or a legacy mainnet address).');
    }
  }
  out.payoutAddress = addr;
  out.storageMode = body.storageMode === 'archive' ? 'archive' : 'pruned';

  const integer = (key, min, max, fallback = out[key]) => {
    const value = Math.round(number(body[key] ?? fallback, fallback));
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    out[key] = value;
  };
  const decimal = (key, min, max, fallback = out[key]) => {
    const value = number(body[key] ?? fallback, fallback);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    out[key] = value;
  };

  integer('pruneTargetMb', 2048, 500000);
  integer('startDiff', 1, 10000000000);
  out.vardiffEnabled = body.vardiffEnabled === true || String(body.vardiffEnabled) === 'true';
  integer('vardiffTargetSec', 1, 3600);
  integer('vardiffRetargetSec', 1, 86400);
  decimal('vardiffTolerance', 0, 1);
  integer('vardiffMinDiff', 1, 10000000000);
  integer('vardiffMaxDiff', 1, 100000000000);
  integer('vardiffMaxUpFactor', 1, 1000);
  integer('vardiffMaxDownFactor', 1, 1000);
  integer('vardiffGraceSec', 0, 86400);

  if (out.vardiffMaxDiff < out.vardiffMinDiff) throw new Error('VarDiff maximum difficulty must be at least the minimum difficulty.');
  if (out.startDiff < out.vardiffMinDiff) out.startDiff = out.vardiffMinDiff;
  if (out.startDiff > out.vardiffMaxDiff) out.startDiff = out.vardiffMaxDiff;

  return out;
}

ensureSettings();

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, { settings: readSettings(), coinbaseSig: COINBASE_SIG });
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await status());
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = JSON.parse(await readBody(req) || '{}');
      const settings = cleanSettings(body);
      atomicWriteSettings(settings);
      return json(res, 200, {
        settings,
        coinbaseSig: COINBASE_SIG,
        message: `Saved. Restart BCH Solo Pool to apply changes. ${networkLabel(settings.network)} chain data is kept separately.`,
      });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 400, { error: e.message || String(e) });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`BCH Solo adapter listening on :${PORT}`));
// SOGGY_FAST_SHUTDOWN
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`[shutdown] ${signal} received; stopping BCH adapter`);
    process.exit(0);
  });
}
