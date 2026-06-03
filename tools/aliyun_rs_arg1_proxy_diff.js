#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function pickSample(report, kind) {
  const rows = Array.isArray(report?.feilinRsLogs) ? report.feilinRsLogs : [];
  if (kind === 'success') {
    return rows.find((row) =>
      typeof row?.outputString === 'string' &&
      row.outputString !== 'null' &&
      typeof row?.arg0 === 'string' &&
      typeof row?.arg1 === 'string') || null;
  }
  return rows.find((row) =>
    row?.outputString === 'null' &&
    typeof row?.arg0 === 'string' &&
    typeof row?.arg1 === 'string') || null;
}

function summarizeRow(row) {
  return {
    label: row?.label || null,
    outputType: row?.outputType || null,
    outputString: row?.outputString || null,
    innerStages: row?.innerStages || null,
    proxyOps: Array.isArray(row?.arg1ProxyLogs)
      ? row.arg1ProxyLogs.map((entry) => ({
        prop: entry?.prop || null,
        call: !!entry?.call,
        valueType: entry?.valueType || null,
        valuePreview: entry?.valuePreview || null,
        argsPreview: entry?.argsPreview || null,
        stack: entry?.stack || null,
      }))
      : null,
  };
}

async function main() {
  const base = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const success = pickSample(base, 'success');
  const nullRow = pickSample(base, 'null');
  if (!success) throw new Error('missing success sample');
  if (!nullRow) throw new Error('missing null sample');

  const replay = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
    rsExperimentInputs: [
      { label: 'success-proxy', arg0: success.arg0, arg1: success.arg1, thisKind: 'undefined', wrapArg1AsStringProxy: true },
      { label: 'null-proxy', arg0: nullRow.arg0, arg1: nullRow.arg1, thisKind: 'undefined', wrapArg1AsStringProxy: true },
    ],
  });

  console.log(JSON.stringify({
    successSeed: {
      arg0: success.arg0,
      arg1Length: success.arg1.length,
      arg1Head: success.arg1.slice(0, 220),
    },
    nullSeed: {
      arg0: nullRow.arg0,
      arg1Length: nullRow.arg1.length,
      arg1Head: nullRow.arg1.slice(0, 220),
    },
    rows: Array.isArray(replay.rsExperiment) ? replay.rsExperiment.map(summarizeRow) : replay.rsExperiment,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
