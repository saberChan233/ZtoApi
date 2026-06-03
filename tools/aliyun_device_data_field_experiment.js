#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}
function readJson(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }

class ProbeWorkerClient {
  constructor() { this.child = null; this.rl = null; this.stderr = ''; this.seq = 0; this.exited = false; }
  async start() {
    if (this.child) return;
    this.child = spawn('node', ['tools/pure_code_captcha_worker.js'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd() });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk || '');
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000);
    });
    this.child.once('exit', () => { this.exited = true; });
    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    const ready = await this.readLine();
    if (!ready?.ready) throw new Error(`worker not ready: ${JSON.stringify(ready)} stderr=${this.stderr}`);
  }
  readLine() {
    return new Promise((resolve, reject) => {
      const onLine = (line) => { cleanup(); try { resolve(JSON.parse(line)); } catch (err) { reject(err); } };
      const onClose = () => { cleanup(); reject(new Error(`worker stdout closed stderr=${this.stderr}`)); };
      const cleanup = () => { this.rl?.off('line', onLine); this.rl?.off('close', onClose); };
      this.rl?.once('line', onLine); this.rl?.once('close', onClose);
    });
  }
  async request(payload) {
    await this.start();
    const request_id = `devdata-${++this.seq}`;
    this.child.stdin.write(`${JSON.stringify({ ...payload, request_id })}\n`);
    const line = await this.readLine();
    if (line?.request_id && line.request_id !== request_id) throw new Error(`request_id mismatch: ${JSON.stringify(line)}`);
    if (line?.ok === false) throw new Error(line.error || 'worker returned error');
    return line;
  }
  async close() {
    if (!this.child) return;
    try { if (!this.exited) this.child.stdin.write(`${JSON.stringify({ action: 'shutdown', request_id: `devdata-${++this.seq}` })}\n`); } catch {}
    try { this.child.stdin.end(); } catch {}
    if (!this.exited) await new Promise((resolve) => this.child.once('exit', resolve));
  }
}

function entriesToMap(entries) {
  const out = {};
  for (const row of entries || []) out[row.key] = row.value;
  return out;
}

async function probe(worker, options = {}) {
  const res = await worker.request({ action: 'probe', options });
  return res.probe || {};
}

function pickBrowserEnvOptions(browserProbe) {
  return {
    locationHref: browserProbe.href || 'https://chat.z.ai/',
    localStorageSeed: browserProbe.localStorage || {},
    sessionStorageSeed: browserProbe.sessionStorage || {},
    documentCookie: browserProbe.cookie || '',
    referrer: 'https://chat.z.ai/',
    windowOverrides: {
      _aliyun_device_cvs: browserProbe.deviceCvsPreview || null,
      _aliyun_device_ifr: browserProbe.deviceIfrPreview || null,
    },
  };
}

function diffDeviceData(baseMap, envMap) {
  const keys = [...new Set([...Object.keys(baseMap), ...Object.keys(envMap)])];
  return keys.filter((key) => JSON.stringify(baseMap[key]) !== JSON.stringify(envMap[key]));
}

function diffDeviceDataDefinedOverrides(baseMap, envMap) {
  return diffDeviceData(baseMap, envMap).filter((key) => Object.prototype.hasOwnProperty.call(envMap, key));
}

function groupOverrides(changedKeys, envMap) {
  const pick = (predicate) => Object.fromEntries(changedKeys.filter(predicate).map((key) => [key, envMap[key]]));
  return [
    { label: 'route-only', overrides: pick((k) => k === 'dfghfgdh6' || k === 'mooXgKbkcxvs') },
    { label: 'cookie-like-only', overrides: pick((k) => ['asf65445', 'gfdc6456', 'hgvh4435'].includes(k)) },
    { label: 'time-only', overrides: pick((k) => ['gfdc6456', 'gdffd98u9', 'cxvcx324', 'h9w87s9', 'v8w7102'].includes(k)) },
    { label: 'flags-only', overrides: pick((k) => ['gdfh6574', 'gdfgs23145'].includes(k)) },
    { label: 'all-changed', overrides: Object.fromEntries(changedKeys.map((key) => [key, envMap[key]])) },
  ].filter((row) => Object.keys(row.overrides).length > 0);
}

async function main() {
  const browserPath = getArg('--browser');
  const label = getArg('--label', 'after-uploadlog');
  if (!browserPath) throw new Error('missing --browser <probe-json>');
  const raw = readJson(browserPath);
  const browserProbe = (raw.probes || []).find((item) => item.label === label)?.probe;
  if (!browserProbe) throw new Error(`probe not found: ${label}`);

  const worker = new ProbeWorkerClient();
  try {
    const baseline = await probe(worker, {});
    const browserEnvOptions = pickBrowserEnvOptions(browserProbe);
    const browserEnv = await probe(worker, browserEnvOptions);
    const baseMap = entriesToMap(baseline.deviceDataEntries || []);
    const envMap = entriesToMap(browserEnv.deviceDataEntries || []);
    const changedKeys = diffDeviceData(baseMap, envMap);
    const changedOverrideKeys = diffDeviceDataDefinedOverrides(baseMap, envMap);
    const inputRows = [
      ...changedOverrideKeys.map((key) => ({ label: `only:${key}`, overrides: { [key]: envMap[key] } })),
      ...groupOverrides(changedOverrideKeys, envMap),
    ];
    const res = await worker.request({ action: 'probe', options: { deviceDataOverrideExperimentInputs: inputRows } });
    const exp = res.probe?.deviceDataOverrideExperiment || res.result?.deviceDataOverrideExperiment || null;
    const rows = (exp?.rows || []).map((row) => ({
      label: row.label,
      overrideKeys: row.overrideKeys,
      thirdLen: row.parsed?.third?.length ?? (typeof row.decoded === 'string' ? (row.decoded.split('#')[2] || '').length : null),
      secondPreview: row.parsed?.second ? String(row.parsed.second).slice(0, 140) : null,
      firstVValue: row.firstVLog?.value ?? null,
      firstVLLength: row.firstVLog?.lLength ?? null,
      firstVLPreview: row.firstVLog?.lPreview ? String(row.firstVLog.lPreview).slice(0, 600) : null,
      error: row.error || null,
    }));
    console.log(JSON.stringify({
      baseline: {
        thirdLen: baseline.postAutoInitUm?.thirdLen ?? null,
        deviceDataCount: (baseline.deviceDataEntries || []).length,
      },
      browserEnv: {
        thirdLen: browserEnv.postAutoInitUm?.thirdLen ?? null,
        localStorageArmsSession: browserEnv.localStorageArmsSession || null,
        changedKeys,
        changedOverrideKeys,
      },
      rows,
    }, null, 2));
  } finally {
    await worker.close();
  }
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
