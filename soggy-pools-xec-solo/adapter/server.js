'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8081);
const RPC_HOST = process.env.XEC_RPC_HOST || 'xec-node';
const RPC_PORT = Number(process.env.XEC_RPC_PORT || 8332);
const RPC_USER = process.env.XEC_RPC_USER || 'umbrel-xec';
const RPC_PASSWORD = process.env.XEC_RPC_PASSWORD || '';
const STRATUM_PORT = Number(process.env.STRATUM_PORT || 3335);
const SETTINGS_FILE = process.env.SETTINGS_FILE || '/data/settings.json';
const CKPOOL_HOST = process.env.CKPOOL_HOST || 'ckpool';
const CKPOOL_PORT = Number(process.env.CKPOOL_PORT || 3333);
const CKPOOL_LOG_ROOT = process.env.CKPOOL_LOG_ROOT || '/var/lib/ckpool/logs';
const COINBASE_SIG = 'SoggyPools On Umbrel';
const DIFF1_HASHES = 4294967296;
const DIFF1_TARGET = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');

const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CASHADDR_GENERATORS = [
  0x98f2bc8e61n,
  0x79b76d99e2n,
  0xf33e5fb3c4n,
  0xae2eabe2a8n,
  0x1e4f43e470n,
];

function cashaddrPolymod(values) {
  let checksum = 1n;
  for (const value of values) {
    const top = checksum >> 35n;
    checksum = ((checksum & 0x07ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < CASHADDR_GENERATORS.length; i++) {
      if (((top >> BigInt(i)) & 1n) !== 0n) checksum ^= CASHADDR_GENERATORS[i];
    }
  }
  return checksum;
}

function validateEcashCashaddr(input) {
  const text = String(input || '').trim();
  if (!text) return { ok: true, address: '' };
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) {
    return { ok: false, error: 'eCash CashAddr cannot mix uppercase and lowercase characters.' };
  }
  const address = text.toLowerCase();
  const split = address.split(':');
  if (split.length !== 2 || split[0] !== 'ecash') {
    return { ok: false, error: 'Payout address must be a mainnet eCash CashAddr beginning with ecash:.' };
  }
  const payload = split[1];
  if (!/^[qp][a-z0-9]{20,100}$/.test(payload)) {
    return { ok: false, error: 'Payout address must be a standard mainnet eCash q... or p... CashAddr.' };
  }
  const values = [];
  for (const ch of payload) {
    const value = CASHADDR_CHARSET.indexOf(ch);
    if (value < 0) return { ok: false, error: 'Payout address contains an invalid eCash CashAddr character.' };
    values.push(value);
  }
  const prefixValues = [...'ecash'].map((ch) => ch.charCodeAt(0) & 31).concat(0);
  if (cashaddrPolymod(prefixValues.concat(values)) !== 1n) {
    return { ok: false, error: 'Payout address checksum is invalid.' };
  }
  return { ok: true, address };
}

const DEFAULTS = Object.freeze({
  network: 'mainnet',
  payoutAddress: '',
  storageMode: 'pruned',
  pruneTargetMb: 5000,
  startDiff: 1024,
  vardiffMinDiff: 1,
  vardiffMaxDiff: 0,
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
  next.network = 'mainnet';
  next.storageMode = next.storageMode === 'archive' ? 'archive' : 'pruned';
  if (raw && raw.vardiffMinDiff == null && raw.minDiff != null) next.vardiffMinDiff = raw.minDiff;
  if (raw && raw.vardiffMaxDiff == null && raw.maxDiff != null) next.vardiffMaxDiff = raw.maxDiff;
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

function rpc(method, params = [], timeout = 5000) {
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
          reject(new Error(`Invalid Bitcoin ABC RPC response: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Bitcoin ABC ${method} timeout`)));
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

// ckpmsg -s receives the parent socket directory. CKPool's default sockets are
// /tmp/ckpool/{stratifier,generator,connector,...} and that directory is shared.
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
      socket.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['SoggyPools-XEC-Dashboard/0.1.0'] }) + '\n');
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

function dspsToHashrate(dsps) {
  return Math.max(0, number(dsps, 0)) * DIFF1_HASHES;
}

function compactToTarget(bitsHex) {
  const clean = String(bitsHex || '').replace(/^0x/i, '').trim();
  if (!/^[0-9a-fA-F]{1,8}$/.test(clean)) return null;
  const bits = parseInt(clean, 16) >>> 0;
  const exponent = bits >>> 24;
  const mantissa = bits & 0x007fffff;
  if (!mantissa) return null;
  if (exponent <= 3) return BigInt(mantissa) >> BigInt(8 * (3 - exponent));
  return BigInt(mantissa) << BigInt(8 * (exponent - 3));
}

function difficultyFromTarget(target) {
  if (!target || target <= 0n) return null;
  const scaled = (DIFF1_TARGET * 100000000n) / target;
  const value = Number(scaled) / 1e8;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function difficultyFromBits(bitsHex) {
  return difficultyFromTarget(compactToTarget(bitsHex));
}

function difficultyFromTargetHex(targetHex) {
  const clean = String(targetHex || '').replace(/^0x/i, '').trim();
  if (!/^[0-9a-fA-F]{1,64}$/.test(clean)) return null;
  try { return difficultyFromTarget(BigInt(`0x${clean}`)); } catch { return null; }
}

function effectiveTemplateDifficulty(gbt, fallback) {
  // eCash Real Time Target/Heartbeat can make the current candidate block's
  // effective difficulty differ from getdifficulty(). Bitcoin ABC exposes the
  // compact effective target as rtt.nexttarget. Prefer it for share/block odds.
  const rtt = difficultyFromBits(gbt?.rtt?.nexttarget);
  if (rtt) return rtt;
  const target = difficultyFromTargetHex(gbt?.target);
  if (target) return target;
  const bits = difficultyFromBits(gbt?.bits);
  if (bits) return bits;
  return number(fallback, 0);
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

function recentShareLog(currentNetworkDiff) {
  const root = CKPOOL_LOG_ROOT;
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

function recentBlocks() {
  const root = CKPOOL_LOG_ROOT;
  const candidates = [path.join(root, 'ckpool.log'), ...walkFiles(root, 3).filter((p) => p.endsWith('.log'))];
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
  const workerList = Array.isArray(workersRaw?.workers) ? workersRaw.workers : [];
  const clientList = Array.isArray(clientsRaw?.clients) ? clientsRaw.clients : [];
  const shareCounts = new Map();
  for (const s of shareEntries) {
    if (s.result !== 'accepted') continue;
    shareCounts.set(s.workerName, (shareCounts.get(s.workerName) || 0) + 1);
  }
  return workerList.map((w) => {
    const name = String(w.worker || 'miner');
    const clients = clientList.filter((c) => String(c.workername || '') === name && c.authorised !== false);
    const now = Math.floor(Date.now() / 1000);
    const start = clients.reduce((min, c) => {
      const v = number(c.starttime, 0);
      return v > 0 && (min === 0 || v < min) ? v : min;
    }, 0);
    const bestClient = clients.reduce((best, c) => number(c.bestdiff, 0) > number(best?.bestdiff, 0) ? c : best, null);
    const diff = clients.reduce((max, c) => Math.max(max, number(c.diff, 0)), 0) || number(w.mindiff, 0);
    const userAgent = bestClient?.useragent || clients.find((c) => c.useragent)?.useragent || '';
    const bestDiff = Math.max(number(w.bestdiff, 0), ...clients.map((c) => number(c.bestdiff, 0)), 0);
    return {
      workerName: name,
      worker: name,
      user: String(w.user || ''),
      userAgent: String(userAgent),
      hashrate1m: dspsToHashrate(w.dsps1),
      shareDifficulty: diff,
      difficulty: diff,
      shares: shareCounts.get(name) || 0,
      bestDiff,
      connectedSeconds: start > 0 ? Math.max(0, now - start) : 0,
      lastShare: number(w.lastshare, 0) || null,
      idle: Boolean(w.idle),
    };
  }).filter((w) => !w.idle || w.connectedSeconds > 0 || w.lastShare);
}

async function status() {
  const settings = readSettings();
  let chain = null;
  let nodeError = null;
  try {
    chain = await rpc('getblockchaininfo');
  } catch (e) {
    nodeError = e.message;
  }

  let nodeStatus = 'unavailable';
  if (chain) {
    if (String(chain.chain || '').toLowerCase() !== 'main') {
      nodeStatus = 'unavailable';
      nodeError = `Expected eCash mainnet but Bitcoin ABC reports chain ${chain.chain || 'unknown'}.`;
    } else if (chain.initialblockdownload || number(chain.verificationprogress) < 0.9999 || number(chain.blocks) < number(chain.headers)) {
      nodeStatus = 'syncing';
    } else {
      nodeStatus = 'ready';
    }
  }

  const nodeReady = nodeStatus === 'ready';
  const [networkInfo, mempool, networkHashps, nodeUptime, baseDifficulty, gbt] = await Promise.all([
    chain ? safeRpc('getnetworkinfo') : null,
    chain ? safeRpc('getmempoolinfo') : null,
    chain ? safeRpc('getnetworkhashps') : null,
    chain ? safeRpc('uptime') : null,
    chain ? safeRpc('getdifficulty') : null,
    nodeReady ? safeRpc('getblocktemplate', [{ capabilities: ['coinbasetxn', 'workid', 'coinbase/append'], rules: ['segwit'] }]) : null,
  ]);

  const currentNetworkDiff = effectiveTemplateDifficulty(gbt, baseDifficulty);
  const [probe, poolstats, workersRaw, clientsRaw, uptimeRaw, workRaw] = await Promise.all([
    stratumProbe(), ckmsg('poolstats'), ckmsg('workers'), ckmsg('clients'), ckmsg('uptime'), ckmsg('current.workbase')
  ]);

  const shareData = recentShareLog(currentNetworkDiff);
  const workers = normalizeWorkers(workersRaw, clientsRaw, shareData.entries);
  const accepted = number(poolstats?.shares, shareData.entries.filter((s) => s.result === 'accepted').length);
  const rejected = shareData.entries.filter((s) => s.result === 'rejected').length;
  const uptimeSeconds = number(uptimeRaw?.uptime, poolstats?.start ? Math.max(0, Math.floor(Date.now() / 1000) - number(poolstats.start)) : 0);

  let poolStatus = 'offline';
  let poolError = null;
  if (!settings.payoutAddress) {
    poolStatus = 'waiting-address';
    poolError = 'Set an ecash: payout address in Settings. CKPool will wait until an address is configured.';
  } else if (!nodeReady) {
    poolStatus = 'waiting-node';
    poolError = nodeStatus === 'syncing'
      ? 'CKPool is intentionally waiting for Bitcoin ABC to finish syncing before opening Stratum.'
      : 'CKPool is waiting for Bitcoin ABC RPC.';
  } else if (probe.responsive) {
    poolStatus = 'ready';
  } else if (probe.open) {
    poolStatus = 'starting';
    poolError = 'Stratum is reachable but has not answered mining.subscribe yet. CKPool may still be building its first eCash workbase.';
  } else {
    poolStatus = 'offline';
    poolError = 'Stratum is not listening yet. CKPool starts automatically after Bitcoin ABC can return a valid eCash block template.';
  }

  const candidateHeight = number(gbt?.height, 0) || (chain ? number(chain.blocks) + 1 : null);
  const jobId = workRaw?.jobid ?? workRaw?.id ?? workRaw?.workinfoid ??
    (gbt?.longpollid ? String(gbt.longpollid).slice(0, 12) : (gbt?.previousblockhash ? String(gbt.previousblockhash).slice(0, 12) : null));
  const effectiveBits = gbt?.rtt?.nexttarget || gbt?.bits || workRaw?.bits || workRaw?.nbit || null;
  const shareTarget = workRaw?.target || gbt?.target || null;
  const sharesPerMinute = number(poolstats?.sps1, 0) * 60;
  const tape = shareData.entries
    .filter((s) => s.result === 'accepted' && s.atMs >= Date.now() - 600000)
    .map((s) => s.atMs);

  return {
    node: {
      status: nodeStatus,
      error: nodeError,
      configuredNetwork: 'mainnet',
      networkLabel: 'Mainnet',
      actualChain: chain?.chain ?? null,
      height: chain?.blocks ?? null,
      headers: chain?.headers ?? null,
      blocksRemaining: chain ? Math.max(0, number(chain.headers) - number(chain.blocks)) : null,
      syncPercent: chain ? Math.max(0, Math.min(100, number(chain.verificationprogress) * 100)) : null,
      heightPercent: chain && number(chain.headers) > 0
        ? Math.max(0, Math.min(100, number(chain.blocks) / number(chain.headers) * 100))
        : null,
      peers: networkInfo?.connections ?? null,
      peersIn: networkInfo?.connections_in ?? null,
      peersOut: networkInfo?.connections_out ?? null,
      mempoolBytes: mempool?.bytes ?? mempool?.usage ?? null,
      diskUsedBytes: chain?.size_on_disk ?? null,
      networkHashps,
      baseDifficulty,
      effectiveDifficulty: currentNetworkDiff,
      rttActive: Boolean(gbt?.rtt?.nexttarget),
      pruned: chain?.pruned ?? null,
      pruneHeight: chain?.pruneheight ?? null,
      pruneTargetBytes: chain?.prune_target_size ?? null,
      uptimeSeconds: nodeUptime,
      subversion: networkInfo?.subversion ?? null,
    },
    pool: {
      status: poolStatus,
      error: poolError,
      job: jobId,
      jobHeight: candidateHeight,
      currentNetworkDiff,
      baseNetworkDiff: baseDifficulty,
      currentBits: effectiveBits,
      baseBits: gbt?.bits || null,
      rttActive: Boolean(gbt?.rtt?.nexttarget),
      shareTarget,
      stratumPort: STRATUM_PORT,
      sharesPerMinute,
      sharesAccepted: accepted,
      sharesRejected: rejected,
      hashrate1m: dspsToHashrate(poolstats?.dsps1) || workers.reduce((sum, w) => sum + number(w.hashrate1m), 0),
      uptimeSeconds,
      bestDiff: workers.reduce((max, w) => Math.max(max, number(w.bestDiff)), 0),
      startDiff: settings.startDiff,
      minDiff: settings.vardiffMinDiff,
      maxDiff: settings.vardiffMaxDiff,
      shareLogFile: shareData.latestFile || 'waiting for first share',
      coinbaseSig: COINBASE_SIG,
      stratumProbe: { open: probe.open, responsive: probe.responsive },
    },
    workers,
    shareLog: shareData.entries.slice(0, 100),
    blocks: recentBlocks(),
    tape,
    settings,
  };
}

function cleanSettings(body) {
  const out = { ...readSettings(), network: 'mainnet' };
  const checkedAddress = validateEcashCashaddr(body.payoutAddress ?? '');
  if (!checkedAddress.ok) throw new Error(checkedAddress.error);
  out.payoutAddress = checkedAddress.address;
  out.storageMode = body.storageMode === 'archive' ? 'archive' : 'pruned';

  const integer = (key, min, max, fallback = out[key]) => {
    const raw = body[key] ?? fallback;
    const value = Math.round(number(raw, NaN));
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${key} must be between ${min} and ${max}.`);
    }
    out[key] = value;
  };

  integer('pruneTargetMb', 1100, 500000);
  integer('startDiff', 1, 100000000000);
  integer('vardiffMinDiff', 1, 100000000000);
  integer('vardiffMaxDiff', 0, 100000000000);
  if (out.vardiffMaxDiff !== 0 && out.vardiffMaxDiff < out.vardiffMinDiff) {
    throw new Error('Maximum difficulty must be 0 (unlimited) or at least the minimum difficulty.');
  }
  if (out.startDiff < out.vardiffMinDiff) out.startDiff = out.vardiffMinDiff;
  if (out.vardiffMaxDiff !== 0 && out.startDiff > out.vardiffMaxDiff) out.startDiff = out.vardiffMaxDiff;
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
        message: 'Saved. Restart XEC Solo Pool from Umbrel to apply node storage or CKPool difficulty changes.',
      });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 400, { error: e.message || String(e) });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`XEC Solo adapter listening on :${PORT}`));
