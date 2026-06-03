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

function stackSignature(stack) {
  if (typeof stack !== 'string' || !stack) return 'unknown';
  const lines = stack.split('\n').slice(1, 5).map((line) => line.trim());
  const names = lines.map((line) => {
    const match = line.match(/at\s+([^(\s]+)/);
    return match ? match[1] : line;
  });
  return names.join(' <- ');
}

function classifyRow(row) {
  const arg1 = typeof row?.arg1 === 'string' ? row.arg1 : '';
  const output = typeof row?.outputString === 'string' ? row.outputString : null;
  const sig = stackSignature(row?.stack || '');
  const decodedBytes = Number.isFinite(row?.outputBase64DecodedBytes)
    ? row.outputBase64DecodedBytes
    : Number.isFinite(row?.outputDefaultDecodedBytes)
    ? row.outputDefaultDecodedBytes
    : Number.isFinite(row?.outputWordArrayBytes)
    ? row.outputWordArrayBytes
    : null;
  const resultKind = output === 'null'
    ? 'null'
    : output
    ? `string:${decodedBytes ?? output.length}`
    : row?.outputType || typeof row?.output;
  let semanticKind = 'other';
  if (arg1 === 'W.10051#saf-captcha') {
    semanticKind = 'short-saf-captcha';
  } else if (arg1.startsWith('W.10051#') && arg1.length >= 300 && String(row?.stack || '').includes('iu')) {
    semanticKind = 'token-third-segment';
  } else if (arg1.includes('#CLOUD#0#501#')) {
    semanticKind = 'session-derive';
  }
  return {
    semanticKind,
    resultKind,
    stackSignature: sig,
    arg0: preview(row?.arg0, 48),
    arg1Length: row?.arg1Length || arg1.length || null,
    arg1Head: preview(arg1, 220),
    arg1Tail: arg1.length > 220 ? arg1.slice(-180) : arg1,
    outputHead: preview(output, 220),
    decodedBytes,
  };
}

function summarizeReport(report) {
  const rows = Array.isArray(report?.feilinRsLogs) ? report.feilinRsLogs : [];
  const classified = rows.map(classifyRow);
  const byKind = {};
  for (const row of classified) {
    const key = `${row.semanticKind} | ${row.resultKind} | ${row.stackSignature}`;
    if (!byKind[key]) {
      byKind[key] = {
        count: 0,
        sample: row,
      };
    }
    byKind[key].count += 1;
  }
  return {
    tokenThirdLen: (report?.postAutoInitUmTokenPreview || '').split('#')[2]?.length || 0,
    tokenThirdSegmentCall: classified.find((row) => row.semanticKind === 'token-third-segment') || null,
    shortSafCaptchaCall: classified.find((row) => row.semanticKind === 'short-saf-captcha') || null,
    sessionDeriveCall: classified.find((row) => row.semanticKind === 'session-derive') || null,
    buckets: Object.entries(byKind)
      .map(([key, value]) => ({ key, count: value.count, sample: value.sample }))
      .sort((a, b) => b.count - a.count),
  };
}

async function main() {
  const browserPath = getArg('--browser');
  const label = getArg('--label', 'after-uploadlog');
  const baseOpts = {
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  };
  let envOpts = baseOpts;
  if (browserPath) {
    const raw = readJson(browserPath);
    const browserProbe = (raw.probes || []).find((item) => item.label === label)?.probe;
    if (!browserProbe) throw new Error(`probe not found: ${label}`);
    envOpts = { ...baseOpts, ...pickEnvOptions(browserProbe) };
  }

  const [baseline, browserEnv] = await Promise.all([
    solveCaptcha(baseOpts),
    solveCaptcha(envOpts),
  ]);

  const out = {
    baseline: summarizeReport(baseline),
    browserEnv: summarizeReport(browserEnv),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
