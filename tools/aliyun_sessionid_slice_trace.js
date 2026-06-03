#!/usr/bin/env node
const fs = require('fs');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function pickEnvOptions(browserProbe) {
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

function preview(value, limit = 180) {
  if (typeof value !== 'string') return value;
  return value.slice(0, limit);
}

function slimSliceLogs(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 80).map((row) => ({
    raw: preview(row.raw, 220),
    rawLength: row.rawLength ?? null,
    args: row.args || null,
    output: preview(row.output, 220),
    outputLength: row.outputLength ?? null,
    stack: String(row.stack || '').split('\n').slice(0, 6),
  }));
}

async function runOne(extraOpts) {
  const first = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    ...extraOpts,
  });
  const tA = (first.n0PartLogs || []).find((x) => x.name === 'tA');
  const second = tA?.value || null;
  const sessionBlob = tA?.CPreview || null;
  const traced = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    stringSliceTargets: [sessionBlob, second].filter(Boolean),
    ...extraOpts,
  });
  return {
    second: preview(second, 220),
    sessionBlob: preview(sessionBlob, 220),
    token: preview(traced.postAutoInitUmTokenPreview, 220),
    tokenThirdLen: (traced.postAutoInitUmTokenPreview || '').split('#')[2]?.length || 0,
    sliceLogs: slimSliceLogs(traced.stringSliceLogs),
    ubLogs: (traced.feilinUbLogs || []).slice(0, 10).map((row) => ({
      stage: row.stage || null,
      arg0: preview(row.arg0, 120),
      arg1: preview(row.arg1, 120),
      stack: String(row.stack || '').split('\n').slice(0, 6),
    })),
    uyLogs: (traced.feilinUyLogs || []).slice(0, 12).map((row) => ({
      stage: row.stage || null,
      ubKey: row.ubKey || null,
      value: preview(row.value, 120),
      nSource: preview(row.nSource, 180),
      callableSource: preview(row.callableSource, 180),
    })),
  };
}

async function main() {
  const browserPath = getArg('--browser');
  const label = getArg('--label', 'after-uploadlog');
  let envOpts = {};
  if (browserPath) {
    const raw = readJson(browserPath);
    const browserProbe = (raw.probes || []).find((item) => item.label === label)?.probe;
    if (!browserProbe) throw new Error(`probe not found: ${label}`);
    envOpts = pickEnvOptions(browserProbe);
  }
  const [baseline, browserEnv] = await Promise.all([
    runOne({}),
    runOne(envOpts),
  ]);
  console.log(JSON.stringify({ baseline, browserEnv }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
