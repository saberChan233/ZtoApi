#!/usr/bin/env node
const { runProbe } = require('./probe_feilin_runtime');
const { buildTokenVectorFromReport } = require('./aliyun_token_vector');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function summarizeRow(row) {
  if (!row) return null;
  return {
    phase: row.phase || null,
    label: row.label || null,
    outputStringLength: row.outputStringLength ?? null,
    outputPreview: typeof row.outputString === 'string' ? row.outputString.slice(0, 220) : row.outputPreview || null,
    innerStages: row.innerStages || [],
    lastAId: row.lastAId ?? null,
    error: row.error || null,
  };
}

async function main() {
  const report = await runProbe(FILES, {
    rsExperimentPhase: ['pre-auto-init', 'after-auto-init'],
    rsExperimentBuiltinBestVector: true,
  });
  const vector = buildTokenVectorFromReport(report);

  const pre = report.rsExperimentPhases?.['pre-auto-init'] || [];
  const post = report.rsExperimentPhases?.['after-auto-init'] || [];

  console.log(JSON.stringify({
    vector: {
      candidateIndex: vector.candidateIndex ?? null,
      second: vector.second || null,
      trPreview: vector.trPreview || null,
      xPrefix: vector.xPrefix || null,
      lLength: vector.lLength || null,
    },
    preAutoInit: pre.map(summarizeRow),
    afterAutoInit: post.map(summarizeRow),
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
