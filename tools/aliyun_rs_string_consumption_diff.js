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

function summarizeOps(logs) {
  const rows = Array.isArray(logs) ? logs : [];
  const counts = {};
  for (const row of rows) {
    const key = row?.op || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return {
    total: rows.length,
    counts,
    sample: rows.slice(0, 40).map((row) => ({
      op: row?.op || null,
      rawLength: row?.rawLength ?? null,
      sep: row?.sep || null,
      needle: row?.needle || null,
      limit: row?.limit ?? null,
      fromIndex: row?.fromIndex ?? null,
      result: row?.result ?? null,
      outCount: row?.outCount ?? null,
      outHead: row?.outHead || null,
      stackHead: typeof row?.stack === 'string' ? row.stack.split('\n').slice(0, 4) : null,
    })),
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
    stringOpTargets: [success.arg1, nullRow.arg1],
    stringSliceTargets: [success.arg1, nullRow.arg1],
  });

  const stringOps = Array.isArray(replay.stringOpLogs) ? replay.stringOpLogs : [];
  const successOps = stringOps.filter((row) => row?.rawLength === success.arg1.length);
  const nullOps = stringOps.filter((row) => row?.rawLength === nullRow.arg1.length);
  const stringSlices = Array.isArray(replay.stringSliceLogs) ? replay.stringSliceLogs : [];

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
    successOps: summarizeOps(successOps),
    nullOps: summarizeOps(nullOps),
    stringSliceLogs: stringSlices.slice(0, 60).map((row) => ({
      rawLength: row?.rawLength ?? null,
      start: row?.start ?? null,
      end: row?.end ?? null,
      outputLength: row?.outputLength ?? null,
      outputPreview: row?.outputPreview || null,
      stackHead: typeof row?.stack === 'string' ? row.stack.split('\n').slice(0, 4) : null,
    })),
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
