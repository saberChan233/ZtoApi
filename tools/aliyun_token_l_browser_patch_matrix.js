#!/usr/bin/env node
const fs = require('fs');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime, decodeBase64Utf8 } = require('./feilin_vm_runtime');
const { parseTokenPlain } = require('./feilin_local_token');
const {
  buildTokenLPreviewFromParts,
  parseTokenLPreview,
} = require('./aliyun_token_vector');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];
const DEFAULT_CAPTURE = '/tmp/browser_verify_capture_live.json';
const DEFAULT_DIFF = '/tmp/aliyun_token_l_string_diff.latest.json';

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function pickPart(report, name) {
  return (report?.n0PartLogs || []).find((entry) => entry?.name === name) || null;
}

function cloneParts(parts) {
  return Array.isArray(parts) ? parts.slice() : [];
}

function applyPatchMap(parts, patchMap) {
  const next = cloneParts(parts);
  for (const [key, value] of Object.entries(patchMap || {})) {
    const index = Number(key);
    while (next.length <= index) next.push('');
    next[index] = value == null ? '' : String(value);
  }
  return next;
}

function commonPrefixLen(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const limit = Math.min(left.length, right.length);
  let i = 0;
  while (i < limit && left[i] === right[i]) i += 1;
  return i;
}

function commonSuffixLen(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const limit = Math.min(left.length, right.length);
  let i = 0;
  while (i < limit && left[left.length - 1 - i] === right[right.length - 1 - i]) i += 1;
  return i;
}

function summarizeThird(candidate, browserThird) {
  const out = candidate?.outputString || null;
  return {
    outputType: candidate?.outputType || null,
    thirdLength: out ? out.length : 0,
    thirdPreview: out ? out.slice(0, 220) : null,
    equalsBrowserThird: out === browserThird,
    commonPrefixLen: out ? commonPrefixLen(out, browserThird) : 0,
    commonSuffixLen: out ? commonSuffixLen(out, browserThird) : 0,
  };
}

function buildPatchCases(diffRows) {
  const rows = Array.isArray(diffRows) ? diffRows : [];
  const makePatch = (indices) => {
    const patch = {};
    for (const index of indices) {
      const row = rows.find((item) => item.index === index);
      if (!row) continue;
      patch[index] = row.compare ?? '';
    }
    return patch;
  };

  const autoDiffIndices = rows.map((row) => row.index);
  const cases = [
    { label: 'baseline-no-patch', indices: [], patch: {} },
  ];
  for (const row of rows) {
    cases.push({
      label: `patch-slot:${row.index}`,
      indices: [row.index],
      patch: makePatch([row.index]),
    });
  }
  for (const group of [
    [22, 44],
    [53, 54],
    [72, 73, 74, 75],
    [86, 87, 88],
    [22, 44, 53, 54],
    [53, 54, 72, 73, 74, 75],
    [72, 73, 74, 75, 86, 87, 88],
    autoDiffIndices,
  ]) {
    cases.push({
      label: `patch-group:${group.join(',') || 'none'}`,
      indices: group,
      patch: makePatch(group),
    });
  }
  return cases;
}

async function main() {
  const capturePath = getArg('--capture', DEFAULT_CAPTURE);
  const diffPath = getArg('--diff', DEFAULT_DIFF);
  const outputPath = getArg('--output', null);

  const capture = readJson(capturePath);
  const diff = readJson(diffPath);
  const diffRows = diff?.comparisons?.[0]?.changedSlots || [];
  const browserInitPlain = decodeBase64Utf8(capture?.init_form?.DeviceToken || '');
  const browserInitParsed = parseTokenPlain(browserInitPlain);
  const browserThird = browserInitParsed?.third || '';

  const solverOut = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });

  const v = pickPart(solverOut, 'v');
  const tA = pickPart(solverOut, 'tA');
  const baselineParts = parseTokenLPreview(v?.lPreview || '').parts;
  const patchCases = buildPatchCases(diffRows);

  const evaluated = patchCases.map((item) => {
    const parts = applyPatchMap(baselineParts, item.patch);
    const arg1 = buildTokenLPreviewFromParts(parts);
    const candidate = runtime.computeThirdSegment(tA?.trPreview || 'FqJB6iRNVYdEGpwb', arg1);
    return {
      label: item.label,
      indices: item.indices,
      patch: item.patch,
      arg1Length: arg1.length,
      ...summarizeThird(candidate, browserThird),
    };
  });

  evaluated.sort((a, b) => {
    if (a.equalsBrowserThird !== b.equalsBrowserThird) return a.equalsBrowserThird ? -1 : 1;
    if (a.commonPrefixLen !== b.commonPrefixLen) return b.commonPrefixLen - a.commonPrefixLen;
    if (a.commonSuffixLen !== b.commonSuffixLen) return b.commonSuffixLen - a.commonSuffixLen;
    return b.thirdLength - a.thirdLength;
  });

  const result = {
    browserCapture: {
      second: browserInitParsed?.second || null,
      thirdLength: browserThird.length,
      thirdPreview: browserThird.slice(0, 220),
      fifth: browserInitParsed?.fifth || null,
    },
    localBaseline: {
      trPreview: tA?.trPreview || null,
      xPreview: v?.xPreview || null,
      lLength: typeof v?.lPreview === 'string' ? v.lPreview.length : null,
      changedSlots: diffRows.map((row) => ({
        index: row.index,
        deviceKey: row.deviceKey || null,
        baseline: row.baseline,
        compare: row.compare,
      })),
    },
    topCandidates: evaluated.slice(0, 16),
    exactMatchFound: evaluated.some((row) => row.equalsBrowserThird),
  };

  if (outputPath) {
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
