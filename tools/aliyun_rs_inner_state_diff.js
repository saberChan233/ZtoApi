#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function pickSample(report, kind) {
  const rows = Array.isArray(report?.feilinRsLogs) ? report.feilinRsLogs : [];
  if (kind === 'success') {
    return rows.find((row) =>
      typeof row?.outputString === 'string' &&
      row.outputString !== 'null' &&
      Array.isArray(row?.innerStages) &&
      row.innerStages.includes('after-method') &&
      typeof row?.arg0 === 'string' &&
      typeof row?.arg1 === 'string') || null;
  }
  return rows.find((row) =>
    row?.outputString === 'null' &&
    Array.isArray(row?.innerStages) &&
    !row.innerStages.includes('after-method') &&
    typeof row?.arg0 === 'string' &&
    typeof row?.arg1 === 'string') || null;
}

function summarizeRow(row) {
  return {
    label: row?.label || null,
    outputType: row?.outputType || null,
    outputString: row?.outputString || null,
    outputDecodedPreview: row?.outputDecodedPreview || null,
    lastAId: row?.lastAId ?? null,
    innerStages: row?.innerStages || null,
    innerThrow: row?.innerThrow
      ? {
        methodKey: row.innerThrow.methodKey || null,
        error: row.innerThrow.error || null,
      }
      : null,
    innerLogs: Array.isArray(row?.innerLogs)
      ? row.innerLogs.map((entry) => ({
        stage: entry?.stage || null,
        aType: entry?.aType || null,
        aId: entry?.aId ?? null,
        aKeys: entry?.aKeys || null,
        aSource: entry?.aSource || null,
        thisType: entry?.thisType || null,
        thisKeys: entry?.thisKeys || null,
        methodKey: entry?.methodKey || null,
        methodType: entry?.methodType || null,
        methodSource: entry?.methodSource || null,
        outType: entry?.outType || null,
        outPreview: entry?.outPreview || null,
        arg1Length: entry?.arg1Length ?? null,
      }))
      : null,
    error: row?.error || null,
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
      { label: 'success-sample', arg0: success.arg0, arg1: success.arg1, thisKind: 'undefined' },
      { label: 'null-sample', arg0: nullRow.arg0, arg1: nullRow.arg1, thisKind: 'undefined' },
    ],
  });

  const rows = Array.isArray(replay.rsExperiment) ? replay.rsExperiment : [];
  console.log(JSON.stringify({
    successSeed: {
      arg0: success.arg0,
      arg1Length: success.arg1Length,
      arg1Head: success.arg1.slice(0, 280),
      outputStringHead: success.outputString.slice(0, 160),
    },
    nullSeed: {
      arg0: nullRow.arg0,
      arg1Length: nullRow.arg1Length,
      arg1Head: nullRow.arg1.slice(0, 280),
      outputString: nullRow.outputString,
    },
    rows: rows.map(summarizeRow),
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
