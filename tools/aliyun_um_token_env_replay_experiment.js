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
    this.child = spawn('node', ['tools/pure_code_captcha_worker.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk || '');
      if (this.stderr.length > 8000) {
        this.stderr = this.stderr.slice(-8000);
      }
    });
    this.child.once('exit', () => {
      this.exited = true;
    });
    this.rl = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    const ready = await this.readLine();
    if (!ready?.ready) {
      throw new Error(`worker not ready: ${JSON.stringify(ready)} stderr=${this.stderr}`);
    }
  }

  readLine() {
    return new Promise((resolve, reject) => {
      const onLine = (line) => {
        cleanup();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`worker stdout closed stderr=${this.stderr}`));
      };
      const cleanup = () => {
        this.rl?.off('line', onLine);
        this.rl?.off('close', onClose);
      };
      this.rl?.once('line', onLine);
      this.rl?.once('close', onClose);
    });
  }

  async request(payload) {
    await this.start();
    const request_id = `probe-${++this.seq}`;
    this.child.stdin.write(`${JSON.stringify({ ...payload, request_id })}\n`);
    const line = await this.readLine();
    if (line?.request_id && line.request_id !== request_id) {
      throw new Error(`request_id mismatch: ${JSON.stringify(line)}`);
    }
    if (line?.ok === false) {
      throw new Error(line.error || 'worker returned error');
    }
    return line;
  }

  async close() {
    if (!this.child) return;
    try {
      if (!this.exited) {
        this.child.stdin.write(`${JSON.stringify({ action: 'shutdown', request_id: `probe-${++this.seq}` })}\n`);
      }
    } catch {}
    try {
      this.child.stdin.end();
    } catch {}
    if (!this.exited) {
      await new Promise((resolve) => this.child.once('exit', resolve));
    }
  }
}

async function runCase(worker, name, options) {
  const res = await worker.request({
    action: 'probe',
    options: {
      files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
      loaderPath: '/tmp/AliyunCaptcha.js',
      ...options,
    },
  });
  const probe = res.probe || {};
  return {
    name,
    pre: { um: probe.um || null, zUm: probe.zUm || null },
    post: { um: probe.postAutoInitUm || null, zUm: probe.postAutoInitZUm || null },
    sessionDerive: probe.sessionDerive || null,
    runtime: {
      href: probe.runtimeHref || null,
      deviceConfigSessionId: probe.runtimeDeviceConfigSessionId || null,
      localStorageKeys: probe.localStorageKeys || [],
      sessionStorageKeys: probe.sessionStorageKeys || [],
      localStorageArmsSession: probe.localStorageArmsSession || null,
      cookiePreview: probe.documentCookiePreview || null,
    },
    verify: {
      initDeviceTokenPreview: probe.initDeviceToken?.preview || null,
      verifyCode: probe.verifyCode || null,
    },
  };
}

async function main() {
  const browserPath = getArg('--browser');
  if (!browserPath) throw new Error('missing --browser <probe-json>');
  const label = getArg('--label', 'after-uploadlog');
  const raw = readJson(browserPath);
  const probe = (raw.probes || []).find((item) => item.label === label)?.probe;
  if (!probe) throw new Error(`probe not found: ${label}`);

  const baseLocalStorage = probe.localStorage || {};
  const baseSessionStorage = probe.sessionStorage || {};
  const browserHref = probe.href || 'https://chat.z.ai/';
  const browserCookie = probe.cookie || '';
  const browserPathname = probe.pathname || null;
  const browserTitle = probe.title || null;
  const browserDeviceCvs = probe.deviceCvsPreview || null;
  const browserDeviceIfr = probe.deviceIfrPreview || null;

  const cases = [
    ['baseline', {}],
    ['browser-href-only', { locationHref: browserHref }],
    ['browser-storage-only', { localStorageSeed: baseLocalStorage }],
    ['browser-cookie-only', { documentCookie: browserCookie }],
    ['browser-storage-plus-sessionstorage', {
      localStorageSeed: baseLocalStorage,
      sessionStorageSeed: baseSessionStorage,
    }],
    ['browser-cookie-seed-only', {
      cookieSeed: Object.fromEntries(
        browserCookie
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const eq = part.indexOf('=');
            return eq === -1 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)];
          }),
      ),
    }],
    ['browser-window-route-shape', {
      locationHref: browserHref,
      windowOverrides: {
        __BROWSER_RUNTIME_ROUTE__: browserPathname,
      },
    }],
    ['browser-device-objects-only', {
      windowOverrides: {
        _aliyun_device_cvs: browserDeviceCvs,
        _aliyun_device_ifr: browserDeviceIfr,
      },
    }],
    ['browser-everything-plus-device-objects', {
      locationHref: browserHref,
      localStorageSeed: baseLocalStorage,
      sessionStorageSeed: baseSessionStorage,
      documentCookie: browserCookie,
      referrer: 'https://chat.z.ai/',
      windowOverrides: {
        _aliyun_device_cvs: browserDeviceCvs,
        _aliyun_device_ifr: browserDeviceIfr,
      },
    }],
    ['browser-href-storage-cookie-referrer', {
      locationHref: browserHref,
      localStorageSeed: baseLocalStorage,
      sessionStorageSeed: baseSessionStorage,
      documentCookie: browserCookie,
      referrer: 'https://chat.z.ai/',
    }],
    ['browser-href-storage-cookie', {
      locationHref: browserHref,
      localStorageSeed: baseLocalStorage,
      documentCookie: browserCookie,
    }],
  ];

  const worker = new ProbeWorkerClient();
  try {
    const rows = [];
    for (const [name, options] of cases) {
      rows.push(await runCase(worker, name, options));
    }

    console.log(JSON.stringify({
      browser: {
        label,
        href: browserHref,
        cookiePreview: browserCookie.slice(0, 240),
        pathname: browserPathname,
        title: browserTitle,
        localStorageKeys: Object.keys(baseLocalStorage).sort(),
        sessionStorageKeys: Object.keys(baseSessionStorage).sort(),
        deviceCvsKeys: browserDeviceCvs ? Object.keys(browserDeviceCvs).sort() : [],
        deviceIfrKeys: browserDeviceIfr ? Object.keys(browserDeviceIfr).sort() : [],
        umGetTokenDecoded: probe.umGetToken?.decoded || null,
        zUmGetTokenDecoded: probe.zUmGetToken?.decoded || null,
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
