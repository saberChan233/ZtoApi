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

function pickSessionRows(report) {
  const rows = Array.isArray(report?.reMutationExperiment?.rows) ? report.reMutationExperiment.rows : [];
  return rows
    .filter((row) => row?.field === 'sessionId')
    .map((row) => ({
      assigned: preview(row.assignedPreview, 220),
      decoded: preview(row.decoded, 220),
      error: row.error ? String(row.error).split('\n')[0] : null,
    }));
}

function summarize(report) {
  const token = report?.postAutoInitUmTokenPreview || '';
  const ioBaseSeed = report?.ioMutationExperiment?.baseSeed || null;
  const iuBaseToken = report?.iuMutationExperiment?.baseToken || null;
  const sessionRows = pickSessionRows(report);
  return {
    tokenPreview: preview(token, 220),
    tokenThirdLen: token.split('#')[2]?.length || 0,
    ioBaseSeed: preview(ioBaseSeed, 220),
    ioEndsWithNull: typeof ioBaseSeed === 'string' ? ioBaseSeed.endsWith('#####null') : null,
    ioChangedCount: report?.ioMutationExperiment?.changedCount ?? null,
    iuBaseToken: preview(iuBaseToken, 220),
    iuChangedCount: report?.iuMutationExperiment?.changedCount ?? null,
    sessionRows,
  };
}

async function runOne(opts) {
  const result = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    ioMutationExperiment: true,
    iuMutationExperiment: true,
    reMutationExperiment: true,
    manualTokenExperiment: true,
    ...opts,
  });
  return summarize(result);
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
