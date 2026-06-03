#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');
const { pickBestTokenVector, buildTokenLPreviewFromVector } = require('./aliyun_token_vector');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function summarizeSelector(entry) {
  if (!entry) return null;
  return {
    stage: entry.stage || null,
    raKey: entry.raKey || null,
    outType: entry.outType || null,
    outSource: typeof entry.outSource === 'string' ? entry.outSource.slice(0, 300) : null,
    arg0: entry.arg0 || null,
    arg1Length: entry.arg1Length ?? null,
  };
}

function summarizeInner(entry) {
  if (!entry) return null;
  return {
    stage: entry.stage || null,
    aId: entry.aId ?? null,
    methodKey: entry.methodKey || null,
    methodType: entry.methodType || null,
    outType: entry.outType || null,
    outPreview: typeof entry.outPreview === 'string' ? entry.outPreview.slice(0, 220) : null,
    error: entry.error || null,
  };
}

async function main() {
  const out = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
    rsExperimentInputs: [],
  });
  const vector = pickBestTokenVector(out) || out.tokenVector;
  const lPreview = buildTokenLPreviewFromVector(vector);
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });

  const direct = runtime.computeThirdSegmentDebug(vector.trPreview, lPreview);
  const probe = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
    rsExperimentInputs: [
      { label: 'best-vector-tr', arg0: vector.trPreview, arg1: lPreview, thisKind: 'undefined' },
    ],
  });
  const probeRow = Array.isArray(probe.rsExperiment) ? probe.rsExperiment[0] : null;

  console.log(JSON.stringify({
    vector: {
      candidateIndex: vector.candidateIndex ?? null,
      second: vector.second || null,
      trPreview: vector.trPreview || null,
      lLength: vector.lLength || lPreview.length,
    },
    directVm: {
      outputStringLength: direct.outputString ? direct.outputString.length : null,
      outputPreview: direct.outputString ? direct.outputString.slice(0, 220) : null,
      selectorLogs: (direct.selectorLogs || []).slice(0, 6).map(summarizeSelector),
      innerLogs: (direct.innerLogs || []).slice(0, 12).map(summarizeInner),
      cryptoTraceTail: (direct.cryptoTraceLogs || []).slice(-8),
    },
    solveCaptchaProbe: probeRow ? {
      outputStringLength: probeRow.outputStringLength ?? null,
      outputPreview: probeRow.outputString ? probeRow.outputString.slice(0, 220) : null,
      lastAId: probeRow.lastAId ?? null,
      innerLogs: (probeRow.innerLogs || []).slice(0, 12).map(summarizeInner),
      cryptoTraceTail: (probeRow.cryptoTraceLogs || []).slice(-8),
    } : null,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
