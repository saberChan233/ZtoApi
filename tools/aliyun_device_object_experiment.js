#!/usr/bin/env node
const readline = require('readline');
const { spawn } = require('child_process');

class ProbeWorkerClient {
  constructor() { this.child = null; this.rl = null; this.stderr = ''; this.seq = 0; this.exited = false; }
  async start() {
    if (this.child) return;
    this.child = spawn('node', ['tools/pure_code_captcha_worker.js'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd() });
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk || ''); if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000); });
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
    const request_id = `devobj-${++this.seq}`;
    this.child.stdin.write(`${JSON.stringify({ ...payload, request_id })}\n`);
    const line = await this.readLine();
    if (line?.request_id && line.request_id !== request_id) throw new Error(`request_id mismatch: ${JSON.stringify(line)}`);
    if (line?.ok === false) throw new Error(line.error || 'worker returned error');
    return line;
  }
  async close() {
    if (!this.child) return;
    try { if (!this.exited) this.child.stdin.write(`${JSON.stringify({ action: 'shutdown', request_id: `devobj-${++this.seq}` })}\n`); } catch {}
    try { this.child.stdin.end(); } catch {}
    if (!this.exited) await new Promise((resolve) => this.child.once('exit', resolve));
  }
}

async function main() {
  const worker = new ProbeWorkerClient();
  try {
    const rows = [
      { label: 'replace-null-both', mode: 'replace', cvs: null, ifr: null },
      { label: 'replace-empty-both', mode: 'replace', cvs: {}, ifr: {} },
      { label: 'replace-empty-cvs', mode: 'replace', cvs: {}, ifr: undefined },
      { label: 'replace-empty-ifr', mode: 'replace', cvs: undefined, ifr: {} },
      { label: 'replace-minimal-dom-like', mode: 'replace', cvs: { tagName: 'CANVAS', width: 300, height: 150 }, ifr: { tagName: 'IFRAME' } },
      { label: 'assign-zero-size', mode: 'assign', cvs: { width: 0, height: 0, clientWidth: 0, clientHeight: 0 }, ifr: { clientWidth: 0, clientHeight: 0 } },
      { label: 'assign-remove-content-window', mode: 'assign', ifr: { contentWindow: null, contentDocument: null } },
      { label: 'assign-remove-cvs-style', mode: 'assign', cvs: { style: {}, className: '', innerText: '' } },
    ];
    const res = await worker.request({ action: 'probe', options: { deviceObjectOverrideExperimentInputs: rows } });
    const exp = res.probe?.deviceObjectOverrideExperiment || res.result?.deviceObjectOverrideExperiment || null;
    const outRows = (exp?.rows || []).map((row) => ({
      label: row.label,
      thirdLen: row.parsed?.third?.length ?? (typeof row.decoded === 'string' ? (row.decoded.split('#')[2] || '').length : null),
      firstVValue: row.firstVLog?.value ?? null,
      firstVLLength: row.firstVLog?.lLength ?? null,
      cvsKeys: row.cvsShape?.keys || [],
      ifrKeys: row.ifrShape?.keys || [],
      error: row.error || null,
    }));
    console.log(JSON.stringify({
      baseline: exp?.baseline || null,
      rows: outRows,
    }, null, 2));
  } finally {
    await worker.close();
  }
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
