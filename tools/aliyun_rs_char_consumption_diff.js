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

function summarizeCharOps(rows) {
  const logs = Array.isArray(rows) ? rows : [];
  const counts = {};
  const indices = {};
  for (const row of logs) {
    const op = row?.op || 'unknown';
    counts[op] = (counts[op] || 0) + 1;
    const idx = String(row?.index);
    indices[idx] = (indices[idx] || 0) + 1;
  }
  const topIndices = Object.entries(indices)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([index, count]) => ({ index: Number(index), count }));
  return {
    total: logs.length,
    counts,
    topIndices,
    sample: logs.slice(0, 60).map((row) => ({
      op: row?.op || null,
      rawLength: row?.rawLength ?? null,
      index: row?.index ?? null,
      code: row?.code ?? null,
      ch: row?.ch || null,
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
    stringCharOpTargets: [success.arg1, nullRow.arg1],
  });

  const charOps = Array.isArray(replay.stringCharOpLogs) ? replay.stringCharOpLogs : [];
  const successOps = charOps.filter((row) => row?.rawLength === success.arg1.length);
  const nullOps = charOps.filter((row) => row?.rawLength === nullRow.arg1.length);

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
    successCharOps: summarizeCharOps(successOps),
    nullCharOps: summarizeCharOps(nullOps),
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
