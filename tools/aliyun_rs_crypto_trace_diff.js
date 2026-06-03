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

function summarizeByStage(logs) {
  const rows = Array.isArray(logs) ? logs : [];
  const grouped = {};
  for (const row of rows) {
    const stage = row?.stage || 'unknown';
    grouped[stage] = grouped[stage] || [];
    grouped[stage].push({
      inputLength: row?.inputLength ?? null,
      inputPreview: typeof row?.inputPreview === 'string' ? row.inputPreview.slice(0, 220) : null,
      sourceBytes: row?.sourceBytes ?? null,
      sourceUtf8Preview: typeof row?.sourceUtf8Preview === 'string' ? row.sourceUtf8Preview.slice(0, 220) : null,
      sourceHexPreview: typeof row?.sourceHexPreview === 'string' ? row.sourceHexPreview.slice(0, 220) : null,
      keyBytes: row?.keyBytes ?? null,
      keyHexPreview: typeof row?.keyHexPreview === 'string' ? row.keyHexPreview.slice(0, 96) : null,
      ivBytes: row?.ivBytes ?? null,
      ivHexPreview: typeof row?.ivHexPreview === 'string' ? row.ivHexPreview.slice(0, 96) : null,
      stackHead: typeof row?.stack === 'string' ? row.stack.split('\n').slice(0, 5) : null,
    });
  }
  return Object.fromEntries(
    Object.entries(grouped).map(([stage, items]) => [stage, {
      count: items.length,
      sample: items.slice(0, 8),
    }]),
  );
}

function summarizeRaTrace(logs) {
  const rows = Array.isArray(logs) ? logs : [];
  const byState = {};
  for (const row of rows) {
    const key = `${row?.stage || 'unknown'}:${row?.i ?? 'na'}`;
    byState[key] = (byState[key] || 0) + 1;
  }
  return {
    count: rows.length,
    states: byState,
    sample: rows.slice(0, 40),
    tail: rows.slice(-20),
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
    cryptoTraceTargets: [success.arg1, nullRow.arg1],
  });

  const rows = Array.isArray(replay.rsExperiment) ? replay.rsExperiment : [];
  const successRow = rows.find((row) => row?.label === 'success-sample') || null;
  const nullReplayRow = rows.find((row) => row?.label === 'null-sample') || null;
  const logs = Array.isArray(replay.cryptoTraceLogs) ? replay.cryptoTraceLogs : [];

  console.log(JSON.stringify({
    successSeed: {
      arg0: success.arg0,
      arg1Length: success.arg1.length,
      arg1Head: success.arg1.slice(0, 220),
      outputHead: success.outputString?.slice(0, 220) || null,
    },
    nullSeed: {
      arg0: nullRow.arg0,
      arg1Length: nullRow.arg1.length,
      arg1Head: nullRow.arg1.slice(0, 220),
      outputHead: nullRow.outputString?.slice(0, 220) || null,
    },
    totals: {
      cryptoTraceLogs: logs.length,
    },
    successTrace: summarizeByStage(successRow?.cryptoTraceLogs),
    nullTrace: summarizeByStage(nullReplayRow?.cryptoTraceLogs),
    successRaTrace: summarizeRaTrace(successRow?.raTraceLogs),
    nullRaTrace: summarizeRaTrace(nullReplayRow?.raTraceLogs),
    rsExperiment: rows.map((row) => ({
      label: row?.label || null,
      outputString: row?.outputString || null,
      innerStages: row?.innerStages || null,
      cryptoTraceCount: Array.isArray(row?.cryptoTraceLogs) ? row.cryptoTraceLogs.length : 0,
      raTraceCount: Array.isArray(row?.raTraceLogs) ? row.raTraceLogs.length : 0,
    })),
    allStages: logs.slice(0, 80).map((row) => ({
      stage: row?.stage || null,
      inputLength: row?.inputLength ?? null,
      sourceBytes: row?.sourceBytes ?? null,
      inputPreview: typeof row?.inputPreview === 'string' ? row.inputPreview.slice(0, 180) : null,
      sourceUtf8Preview: typeof row?.sourceUtf8Preview === 'string' ? row.sourceUtf8Preview.slice(0, 180) : null,
      sourceHexPreview: typeof row?.sourceHexPreview === 'string' ? row.sourceHexPreview.slice(0, 180) : null,
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
