#!/usr/bin/env node
const { execFileSync } = require('child_process');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');
const { pickBestTokenVector, buildTokenLPreviewFromVector } = require('./aliyun_token_vector');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function summarizeValue(value) {
  if (typeof value === 'string') return value.slice(0, 220);
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value).slice(0, 220);
  }
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

function buildWarmupInputs(report) {
  const firstIoLog = Array.isArray(report?.feilinIoLogs) ? report.feilinIoLogs[0] || null : null;
  const firstIuLog = Array.isArray(report?.feilinIuLogs) ? report.feilinIuLogs[0] || null : null;
  return {
    ioArgs: firstIoLog?.args ? cloneJson(firstIoLog.args) : null,
    iuArgs: firstIuLog?.args ? cloneJson(firstIuLog.args) : null,
  };
}

function buildSequences(inputs) {
  const ioArgs = Array.isArray(inputs.ioArgs) ? inputs.ioArgs : null;
  const iuArgs = Array.isArray(inputs.iuArgs) ? inputs.iuArgs : null;
  const steps = {
    st: [{ name: 'st' }],
    uY: [{ name: 'uY' }],
    iu: iuArgs ? [{ name: 'iu', args: iuArgs }] : null,
    io: ioArgs ? [{ name: 'io', args: ioArgs }] : null,
    'st->iu': iuArgs ? [{ name: 'st' }, { name: 'iu', args: iuArgs }] : null,
    'uY->iu': iuArgs ? [{ name: 'uY' }, { name: 'iu', args: iuArgs }] : null,
    'io->iu': ioArgs && iuArgs ? [{ name: 'io', args: ioArgs }, { name: 'iu', args: iuArgs }] : null,
    'st->io->iu': ioArgs && iuArgs
      ? [{ name: 'st' }, { name: 'io', args: ioArgs }, { name: 'iu', args: iuArgs }]
      : null,
  };
  return [
    { label: 'baseline', steps: [] },
    ...Object.entries(steps)
      .filter(([, value]) => Array.isArray(value))
      .map(([label, value]) => ({ label, steps: value })),
  ];
}

async function runSequence(vector, lPreview, sequence) {
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });
  const warmup = runtime.runWarmupSequence(sequence.steps);
  const replay = runtime.computeThirdSegmentDebug(vector.trPreview, lPreview);
  return {
    label: sequence.label,
    warmup,
    outputStringLength: replay.outputString ? replay.outputString.length : null,
    outputPreview: replay.outputString ? replay.outputString.slice(0, 220) : null,
    ok: replay.ok,
    selectorLogs: (replay.selectorLogs || []).slice(0, 4),
    innerLogs: (replay.innerLogs || []).slice(0, 12).map(summarizeInner),
    cryptoTraceTail: (replay.cryptoTraceLogs || []).slice(-8),
  };
}

function runSequenceInChild(vector, lPreview, sequence) {
  const payload = Buffer.from(JSON.stringify({ vector, lPreview, sequence }), 'utf8').toString('base64');
  const stdout = execFileSync(process.execPath, [__filename, '--single', payload], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function runSingleFromArg(encoded) {
  const decoded = JSON.parse(Buffer.from(String(encoded || ''), 'base64').toString('utf8'));
  const result = await runSequence(decoded.vector, decoded.lPreview, decoded.sequence);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main() {
  const singleIndex = process.argv.indexOf('--single');
  if (singleIndex >= 0) {
    await runSingleFromArg(process.argv[singleIndex + 1] || '');
    return;
  }
  const baselineReport = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const vector = pickBestTokenVector(baselineReport) || baselineReport.tokenVector;
  if (!vector?.trPreview) {
    throw new Error('missing best token vector trPreview');
  }
  const lPreview = buildTokenLPreviewFromVector(vector);
  const probeReference = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
    rsExperimentInputs: [
      { label: 'best-vector-tr', arg0: vector.trPreview, arg1: lPreview, thisKind: 'undefined' },
    ],
  });
  const probeRow = Array.isArray(probeReference.rsExperiment) ? probeReference.rsExperiment[0] || null : null;
  const inputs = buildWarmupInputs(baselineReport);
  const sequences = buildSequences(inputs);
  const runtimeMeta = (await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  })).getWarmupFunctionSnapshot();
  const rows = [];
  for (const sequence of sequences) {
    rows.push(runSequenceInChild(vector, lPreview, sequence));
  }

  console.log(JSON.stringify({
    vector: {
      candidateIndex: vector.candidateIndex ?? null,
      second: vector.second || null,
      trPreview: vector.trPreview || null,
      xPrefix: vector.xPrefix || null,
      lLength: vector.lLength || lPreview.length,
    },
    warmupInputs: {
      ioArgs: Array.isArray(inputs.ioArgs) ? inputs.ioArgs.map((item) => summarizeValue(item)) : null,
      iuArgs: Array.isArray(inputs.iuArgs) ? inputs.iuArgs.map((item) => summarizeValue(item)) : null,
    },
    runtimeFunctions: runtimeMeta,
    rows,
    solveCaptchaReference: probeRow ? {
      outputStringLength: probeRow.outputStringLength ?? null,
      outputPreview: typeof probeRow.outputString === 'string' ? probeRow.outputString.slice(0, 220) : null,
      innerStages: probeRow.innerStages || [],
      lastAId: probeRow.lastAId ?? null,
    } : null,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
