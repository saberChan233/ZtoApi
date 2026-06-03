#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

class ProbeWorkerClient {
  constructor() {
    this.child = null;
    this.rl = null;
    this.stderr = '';
    this.seq = 0;
    this.exited = false;
  }
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
      this.rl?.once('line', onLine);
      this.rl?.once('close', onClose);
    });
  }
  async request(payload) {
    await this.start();
    const request_id = `diff-${++this.seq}`;
    this.child.stdin.write(`${JSON.stringify({ ...payload, request_id })}\n`);
    const line = await this.readLine();
    if (line?.request_id && line.request_id !== request_id) throw new Error(`request_id mismatch: ${JSON.stringify(line)}`);
    if (line?.ok === false) throw new Error(line.error || 'worker returned error');
    return line;
  }
  async close() {
    if (!this.child) return;
    try { if (!this.exited) this.child.stdin.write(`${JSON.stringify({ action: 'shutdown', request_id: `diff-${++this.seq}` })}\n`); } catch {}
    try { this.child.stdin.end(); } catch {}
    if (!this.exited) await new Promise((resolve) => this.child.once('exit', resolve));
  }
}

function parseLString(value) {
  const raw = typeof value === 'string' ? value : '';
  const parts = raw.split('#');
  return parts.map((part, index) => ({ index, value: part, length: part.length }));
}

function buildDiffRows(baseParts, otherParts, deviceDataEntries) {
  const maxLen = Math.max(baseParts.length, otherParts.length, deviceDataEntries.length);
  const rows = [];
  for (let i = 0; i < maxLen; i += 1) {
    const left = baseParts[i]?.value ?? null;
    const right = otherParts[i]?.value ?? null;
    if (left === right) continue;
    const device = deviceDataEntries[i] || null;
    rows.push({
      index: i,
      deviceKey: device?.key || null,
      deviceType: device?.type || null,
      deviceValuePreview: typeof device?.value === 'string' ? device.value.slice(0, 220) : device?.value ?? null,
      baseline: left,
      baselineLen: left == null ? null : String(left).length,
      compare: right,
      compareLen: right == null ? null : String(right).length,
    });
  }
  return rows;
}

async function runCase(worker, name, options) {
  const res = await worker.request({ action: 'probe', options });
  const probe = res.probe || {};
  const lString = probe.firstVLog?.lPreview || '';
  return {
    name,
    thirdLen: probe.postAutoInitUm?.thirdLen ?? null,
    localStorageArmsSession: probe.localStorageArmsSession || null,
    lLength: probe.firstVLog?.lLength ?? null,
    lString,
    lParts: parseLString(lString),
    deviceDataEntries: probe.deviceDataEntries || [],
  };
}

async function main() {
  const browserPath = getArg('--browser');
  const label = getArg('--label', 'after-uploadlog');
  let browserProbe = null;
  if (browserPath) {
    const raw = readJson(browserPath);
    browserProbe = (raw.probes || []).find((item) => item.label === label)?.probe;
    if (!browserProbe) throw new Error(`probe not found: ${label}`);
  }

  const cases = [
    ['baseline', {}],
  ];
  if (browserProbe) {
    cases.push(['browser-env', {
      locationHref: browserProbe.href || 'https://chat.z.ai/',
      localStorageSeed: browserProbe.localStorage || {},
      sessionStorageSeed: browserProbe.sessionStorage || {},
      documentCookie: browserProbe.cookie || '',
      referrer: 'https://chat.z.ai/',
      windowOverrides: {
        _aliyun_device_cvs: browserProbe.deviceCvsPreview || null,
        _aliyun_device_ifr: browserProbe.deviceIfrPreview || null,
      },
    }]);
  }

  const worker = new ProbeWorkerClient();
  try {
    const outputs = [];
    for (const [name, options] of cases) outputs.push(await runCase(worker, name, options));
    const baseline = outputs[0];
    const diffs = outputs.slice(1).map((row) => ({
      name: row.name,
      thirdLen: row.thirdLen,
      lLength: row.lLength,
      changedSlots: buildDiffRows(baseline.lParts, row.lParts, row.deviceDataEntries).slice(0, 120),
    }));
    console.log(JSON.stringify({
      baseline: {
        thirdLen: baseline.thirdLen,
        lLength: baseline.lLength,
        lStringPreview: baseline.lString.slice(0, 2200),
        deviceDataEntries: baseline.deviceDataEntries,
      },
      comparisons: diffs,
    }, null, 2));
  } finally {
    await worker.close();
  }
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
