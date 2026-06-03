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

function pickIuRows(report) {
  const rows = Array.isArray(report.feilinIuLogs) ? report.feilinIuLogs : [];
  const sessionBootstrap = rows.find((row) =>
    typeof row?.args?.[1] === 'string' &&
    typeof row?.args?.[2] === 'string' &&
    row.args[1].length === 32 &&
    row.args[2].includes('-h-')
  ) || null;
  const tokenBuild = rows.find((row) =>
    row?.args?.[1] == null &&
    row?.args?.[2] == null &&
    row?.args?.[3] === true &&
    String(row?.stack || '').includes('Object.sb [as getToken]')
  ) || null;
  return { sessionBootstrap, tokenBuild };
}

function summarizeDeviceObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const fields = [
    '0', 'sdfg433', 'sdfgsf4', 'sdfgfds4', 'gdfhvcb6', 'fhgjgfhd675', 'fghjcv3',
    'dfghfg64', 'lk4n6ll', 'zvcxv234', 'fghjfghe', 'nghjdfgsh', 'csdfgdfd', 'tyjhtyge',
    'jcvhve', 'dfghcbn', 'dfghfgdh6', 'knfRaXglbmBg', 'wertwer', 'wertdxfgs', 'sdfghtrh',
    'hdfghgf', 'gfdsfd675', 'gdfggc', 'asf65445', 'gfdc6456', 'hgvh4435', 'gdffd98u9',
    'cxvcx324', 'fvcb343', 'xcvbrt454', 'vcxb45', 'bytrre54', 'rewtq2354', 'MKqAvrKgwURj',
    'gdfh6574', 'gdfgs23145', 'h9w87s9', 'gs8d67g9', 'as78f5', 'xjxshsadhda467',
  ];
  const out = {};
  for (const key of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      out[key] = Array.isArray(value) ? value.slice(0, 8) : preview(value, 220);
    }
  }
  return out;
}

function summarizeIuRow(row) {
  if (!row) return null;
  return {
    stack: String(row.stack || '').split('\n').slice(0, 6),
    arg0Summary: summarizeDeviceObject(row.args?.[0]),
    arg1: preview(row.args?.[1], 140),
    arg2: preview(row.args?.[2], 180),
    arg3: row.args?.[3] ?? null,
  };
}

function summarizeTokenPath(report) {
  const rows = Array.isArray(report.tokenPathLogs) ? report.tokenPathLogs : [];
  const iuCall = rows.find((row) => row?.type === 'iu-callsite' && String(row?.stack || '').includes('Object.sb [as getToken]')) || null;
  const ioCall = rows.find((row) => row?.type === 'io-callsite') || null;
  return {
    iuCall: iuCall ? {
      sKeys: iuCall.sKeys || null,
      sPreview: summarizeDeviceObject(iuCall.sPreview),
      dPreview: preview(iuCall.dPreview, 180),
      yPreview: preview(iuCall.yPreview, 220),
      stack: String(iuCall.stack || '').split('\n').slice(0, 6),
    } : null,
    ioCall: ioCall ? {
      tKeys: ioCall.tKeys || null,
      dPreview: summarizeDeviceObject(ioCall.dPreview),
      lPreview: ioCall.lPreview ?? null,
      hPreview: ioCall.hPreview ?? null,
      pPreview: ioCall.pPreview ?? null,
      wPreview: preview(ioCall.wPreview, 220),
      stack: String(ioCall.stack || '').split('\n').slice(0, 6),
    } : null,
  };
}

function summarizeExtend(report) {
  const rows = Array.isArray(report.extendConsumeLogs) ? report.extendConsumeLogs : [];
  const decodedRows = rows.filter((row) => row?.stage === 'decode');
  const interestingAccess = rows.filter((row) => row?.stage === 'access' && typeof row?.cPreview === 'string');
  return {
    decodeRows: decodedRows.slice(0, 8).map((row) => ({
      arg: row.arg,
      sType: row.sType || null,
      sPreview: preview(row.sPreview, 220),
    })),
    interestingAccess: interestingAccess.slice(0, 8).map((row) => ({
      arg: row.arg,
      cType: row.cType || null,
      cPreview: preview(row.cPreview, 220),
    })),
  };
}

function summarize(report) {
  const iu = pickIuRows(report);
  return {
    tokenThirdLen: (report?.postAutoInitUmTokenPreview || '').split('#')[2]?.length || 0,
    iu: {
      sessionBootstrap: summarizeIuRow(iu.sessionBootstrap),
      tokenBuild: summarizeIuRow(iu.tokenBuild),
    },
    tokenPath: summarizeTokenPath(report),
    extend: summarizeExtend(report),
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

  console.log(JSON.stringify({
    baseline: summarize(baseline),
    browserEnv: summarize(browserEnv),
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
