#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function pickPart(report, name) {
  return (report?.n0PartLogs || []).find((entry) => entry?.name === name) || null;
}

function pickBeOutput(report, needle) {
  const row = (report?.feilinBeLogs || []).find((entry) =>
    typeof entry?.calleeSource === 'string' && entry.calleeSource.includes(needle)
  );
  return row?.output ?? null;
}

function buildSummary(report, label) {
  const v = pickPart(report, 'v');
  const l = String(v?.lPreview || '');
  return {
    label,
    uy: (report?.feilinUyLogs || []).find((x) => x?.stage === 'return')?.value || null,
    ci: pickBeOutput(report, 'function ci(){'),
    ce: pickBeOutput(report, 'function ce(){'),
    o6: pickBeOutput(report, 'function o6(){'),
    mHex: pickPart(report, 'm')?.mHexPreview || null,
    second: pickPart(report, 'tA')?.value || null,
    l,
    parts: l.split('#'),
  };
}

async function loadCustom(baseOptions, offset, mode) {
  const exp = await solveCaptcha({ ...baseOptions, sessionIdBlobExperiment: true });
  const baseC = pickPart(exp.sessionIdBlobExperiment?.baseline, 'tA')?.CPreview;
  if (!baseC) throw new Error('missing baseline session blob');
  const buf = Buffer.from(baseC, 'base64');
  if (mode === 'zero') buf[offset] = 0;
  else buf[offset] ^= 0xff;
  return solveCaptcha({ ...baseOptions, customSessionIdBlobBase64: buf.toString('base64') });
}

async function main() {
  const offset = Number(process.argv[2] || '90');
  const mode = String(process.argv[3] || 'zero');
  const baseOptions = {
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  };
  const [baseline, mutated] = await Promise.all([
    solveCaptcha(baseOptions),
    loadCustom(baseOptions, offset, mode),
  ]);
  const left = buildSummary(baseline, 'baseline');
  const right = buildSummary(mutated, `${mode}-${offset}`);
  const maxLen = Math.max(left.parts.length, right.parts.length);
  const diffs = [];
  for (let i = 0; i < maxLen; i += 1) {
    const a = left.parts[i] ?? null;
    const b = right.parts[i] ?? null;
    if (a !== b) {
      diffs.push({
        index: i,
        baseline: a,
        mutated: b,
      });
    }
  }
  console.log(JSON.stringify({
    meta: {
      offset,
      mode,
      baselineUy: left.uy,
      mutatedUy: right.uy,
      baselineSecond: left.second,
      mutatedSecond: right.second,
      baselineCi: left.ci,
      mutatedCi: right.ci,
      baselineCe: left.ce,
      mutatedCe: right.ce,
      baselineO6: left.o6,
      mutatedO6: right.o6,
      baselineMHex: left.mHex,
      mutatedMHex: right.mHex,
      baselineParts: left.parts.length,
      mutatedParts: right.parts.length,
    },
    diffs,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
