#!/usr/bin/env node
const fs = require('fs');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}
function readJson(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }

function pickPartLog(out, name) {
  const rows = Array.isArray(out?.n0PartLogs) ? out.n0PartLogs : [];
  return rows.find((row) => row?.name === name) || null;
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

function simplifyRsRow(row) {
  if (!row) return null;
  return {
    label: row.label || null,
    outputType: row.outputType || null,
    outputPreview: row.outputPreview || null,
    outputString: row.outputString || null,
    outputStringLength: row.outputStringLength || null,
    outputDecodedPreview: row.outputDecodedPreview || null,
    outputBufferHexPreview: row.outputBufferHexPreview || null,
    outputCiphertextBase64: row.outputCiphertextBase64 || null,
    outputWordArrayBase64: row.outputWordArrayBase64 || null,
    outputBase64String: row.outputBase64String || null,
    outputDefaultString: row.outputDefaultString || null,
    error: row.error || null,
  };
}

async function main() {
  const browserPath = getArg('--browser');
  const label = getArg('--label', 'after-uploadlog');
  if (!browserPath) throw new Error('missing --browser <probe-json>');
  const raw = readJson(browserPath);
  const browserProbe = (raw.probes || []).find((item) => item.label === label)?.probe;
  if (!browserProbe) throw new Error(`probe not found: ${label}`);

  const baseOpts = { files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'], loaderPath: '/tmp/AliyunCaptcha.js' };
  const envOpts = { ...baseOpts, ...pickEnvOptions(browserProbe) };

  const baseline = await solveCaptcha(baseOpts);
  const browserEnv = await solveCaptcha(envOpts);
  const baselineTALog = pickPartLog(baseline, 'tA');
  const baselineVLog = pickPartLog(baseline, 'v');
  const envTALog = pickPartLog(browserEnv, 'tA');
  const envVLog = pickPartLog(browserEnv, 'v');

  const rsInputs = [
    { label: 'baseline-x-baseline-l', arg0: baselineVLog?.xPreview, arg1: baselineVLog?.lPreview },
    { label: 'baseline-x-env-l', arg0: baselineVLog?.xPreview, arg1: envVLog?.lPreview },
    { label: 'env-x-baseline-l', arg0: envVLog?.xPreview, arg1: baselineVLog?.lPreview },
    { label: 'env-x-env-l', arg0: envVLog?.xPreview, arg1: envVLog?.lPreview },
  ].filter((row) => typeof row.arg0 === 'string' && typeof row.arg1 === 'string');

  const rsRun = await solveCaptcha({ ...envOpts, rsExperimentInputs: rsInputs });
  const directRxBaseline = baselineTALog?.CPreview
    ? await solveCaptcha({ ...envOpts, directRxSessionIdBase64: baselineTALog.CPreview, directRxTr: baselineTALog.trPreview || 'FqJB6iRNVYdEGpwb' })
    : null;
  const directRxEnv = envTALog?.CPreview
    ? await solveCaptcha({ ...envOpts, directRxSessionIdBase64: envTALog.CPreview, directRxTr: envTALog.trPreview || 'FqJB6iRNVYdEGpwb' })
    : null;

  const out = {
    baseline: {
      tokenThirdLen: (baseline.postAutoInitUmTokenPreview || '').split('#')[2]?.length || 0,
      tA: baselineTALog ? { value: baselineTALog.value || null, trPreview: baselineTALog.trPreview || null, CPreview: baselineTALog.CPreview || null } : null,
      v: baselineVLog ? { value: baselineVLog.value || null, xPreview: baselineVLog.xPreview || null, lLength: baselineVLog.lLength || null, lPreview: baselineVLog.lPreview || null } : null,
    },
    browserEnv: {
      tokenThirdLen: (browserEnv.postAutoInitUmTokenPreview || '').split('#')[2]?.length || 0,
      tA: envTALog ? { value: envTALog.value || null, trPreview: envTALog.trPreview || null, CPreview: envTALog.CPreview || null } : null,
      v: envVLog ? { value: envVLog.value || null, xPreview: envVLog.xPreview || null, lLength: envVLog.lLength || null, lPreview: envVLog.lPreview || null } : null,
    },
    rsExperiment: Array.isArray(rsRun.rsExperiment) ? rsRun.rsExperiment.map(simplifyRsRow) : rsRun.rsExperiment,
    directRxBaseline: directRxBaseline?.directRxSessionResult || null,
    directRxEnv: directRxEnv?.directRxSessionResult || null,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
