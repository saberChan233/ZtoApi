#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const {
  buildTokenLPreviewFromParts,
  parseTokenLPreview,
} = require('./aliyun_token_vector');

function pickNullRsSample(report) {
  const rows = Array.isArray(report?.feilinRsLogs) ? report.feilinRsLogs : [];
  const candidates = rows.filter((row) =>
    row?.outputString === 'null' &&
    typeof row?.arg0 === 'string' &&
    typeof row?.arg1 === 'string' &&
    row.arg1.includes('#') &&
    row.arg1.length > 300);
  candidates.sort((a, b) => (b.arg1Length || 0) - (a.arg1Length || 0));
  return candidates[0] || null;
}

function cloneParts(parts) {
  return Array.isArray(parts) ? parts.slice() : [];
}

function setPart(parts, index, value) {
  const next = cloneParts(parts);
  while (next.length <= index) next.push('');
  next[index] = value == null ? '' : String(value);
  return next;
}

function applyIndices(parts, donorParts, indices) {
  let next = cloneParts(parts);
  for (const index of indices) {
    next = setPart(next, index, donorParts[index] ?? '');
  }
  return next;
}

function buildVariants(baseSample, altSample) {
  const baseParts = baseSample.parts;
  const altParts = altSample.parts;
  const variants = [];
  const autoDiffIndices = [];
  for (let i = 0; i < Math.max(baseParts.length, altParts.length); i += 1) {
    if ((baseParts[i] ?? null) !== (altParts[i] ?? null)) autoDiffIndices.push(i);
  }

  const slotDefs = [
    ['uy', 22],
    ['o6', 33],
    ['permutationTrace', 44],
    ['stateFingerprint', 53],
    ['currentUrl', 54],
    ['scene', 68],
    ['ce', 72],
    ['ceTimestamp', 73],
    ['ci', 74],
    ['ciTimestamp', 75],
    ['deviceClass', 76],
    ['md5ish', 79],
    ['uaTail', 81],
    ['secondTimestamp', 88],
    ['chromiumBrands', 111],
  ];

  variants.push({
    label: 'base-exact',
    arg0: baseSample.arg0,
    arg1: baseSample.raw,
    meta: { kind: 'baseline' },
  });
  variants.push({
    label: 'alt-exact',
    arg0: altSample.arg0,
    arg1: altSample.raw,
    meta: { kind: 'alternate' },
  });
  variants.push({
    label: 'alt-lpreview-with-base-arg0',
    arg0: baseSample.arg0,
    arg1: altSample.raw,
    meta: { kind: 'alternate-lpreview' },
  });

  for (const [name, index] of slotDefs) {
    variants.push({
      label: `swap:${name}`,
      arg0: baseSample.arg0,
      arg1: buildTokenLPreviewFromParts(setPart(baseParts, index, altParts[index] ?? '')),
      meta: { kind: 'swap-slot', name, index, from: baseParts[index] ?? null, to: altParts[index] ?? null },
    });
    variants.push({
      label: `blank:${name}`,
      arg0: baseSample.arg0,
      arg1: buildTokenLPreviewFromParts(setPart(baseParts, index, '')),
      meta: { kind: 'blank-slot', name, index, from: baseParts[index] ?? null, to: '' },
    });
  }

  const groups = [
    ['timestamps', [73, 75, 88]],
    ['ce-ci', [72, 73, 74, 75]],
    ['fingerprint-core', [44, 53, 79]],
    ['url-and-scene', [54, 68]],
    ['browser-env', [7, 8, 37, 38, 81, 111]],
    ['null-hot-path', [22, 33, 44, 53, 54, 72, 73, 74, 75, 79, 88, 111]],
    ['auto-diff-all', autoDiffIndices],
  ];
  for (const [name, indices] of groups) {
    variants.push({
      label: `swap-group:${name}`,
      arg0: baseSample.arg0,
      arg1: buildTokenLPreviewFromParts(applyIndices(baseParts, altParts, indices)),
      meta: { kind: 'swap-group', name, indices },
    });
    variants.push({
      label: `blank-group:${name}`,
      arg0: baseSample.arg0,
      arg1: buildTokenLPreviewFromParts(indices.reduce((acc, idx) => setPart(acc, idx, ''), baseParts)),
      meta: { kind: 'blank-group', name, indices },
    });
  }

  for (const index of autoDiffIndices) {
    variants.push({
      label: `swap-diff-index:${index}`,
      arg0: baseSample.arg0,
      arg1: buildTokenLPreviewFromParts(setPart(baseParts, index, altParts[index] ?? '')),
      meta: { kind: 'swap-diff-index', index, from: baseParts[index] ?? null, to: altParts[index] ?? null },
    });
    variants.push({
      label: `blank-diff-index:${index}`,
      arg0: baseSample.arg0,
      arg1: buildTokenLPreviewFromParts(setPart(baseParts, index, '')),
      meta: { kind: 'blank-diff-index', index, from: baseParts[index] ?? null, to: '' },
    });
  }

  return variants;
}

function summarizeResult(row, meta) {
  return {
    label: row?.label || meta?.label || null,
    kind: meta?.kind || null,
    name: meta?.name || null,
    indices: meta?.indices || null,
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
    arg1Length: row?.arg1Length ?? null,
    changedToNonNull: row?.outputString != null && row.outputString !== 'null',
    error: row?.error || null,
  };
}

async function loadOne() {
  return solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
}

async function main() {
  const [base, alt] = await Promise.all([loadOne(), loadOne()]);
  const baseNull = pickNullRsSample(base);
  const altNull = pickNullRsSample(alt);
  if (!baseNull || !altNull) {
    throw new Error('missing null rs sample');
  }

  const baseParsed = parseTokenLPreview(baseNull.arg1);
  const altParsed = parseTokenLPreview(altNull.arg1);
  const variants = buildVariants(
    { arg0: baseNull.arg0, raw: baseNull.arg1, parts: baseParsed.parts },
    { arg0: altNull.arg0, raw: altNull.arg1, parts: altParsed.parts },
  );

  const replay = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    rsExperimentInputs: variants.map((row) => ({
      label: row.label,
      arg0: row.arg0,
      arg1: row.arg1,
      thisKind: 'undefined',
    })),
  });

  const rsRows = Array.isArray(replay.rsExperiment) ? replay.rsExperiment : [];
  const summary = rsRows.map((row, index) => summarizeResult(row, variants[index]?.meta || { label: variants[index]?.label }));
  const changed = summary.filter((row) => row.changedToNonNull || row.error || row.innerThrow);
  console.log(JSON.stringify({
    baseNull: {
      arg0: baseNull.arg0,
      arg1Length: baseNull.arg1Length,
      arg1Head: baseNull.arg1.slice(0, 280),
    },
    altNull: {
      arg0: altNull.arg0,
      arg1Length: altNull.arg1Length,
      arg1Head: altNull.arg1.slice(0, 280),
    },
    totalVariants: summary.length,
    changedCount: changed.length,
    changed,
    summary,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
