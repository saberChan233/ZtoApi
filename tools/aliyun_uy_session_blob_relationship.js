#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function pickPart(row, name) {
  return (row?.n0PartLogs || []).find((item) => item?.name === name) || null;
}

function simplify(label, row) {
  const tA = pickPart(row, 'tA');
  const m = pickPart(row, 'm');
  const B = pickPart(row, 'B');
  const parsed = row?.parsed || {};
  return {
    label,
    sharedPrefixWithSecret: row?.sharedPrefixWithSecret ?? null,
    uyReturn: row?.intermediates?.uyReturn || null,
    second: parsed.second || null,
    secondLen: parsed.second ? String(parsed.second).length : 0,
    third: parsed.third || null,
    thirdLen: parsed.third ? String(parsed.third).length : 0,
    fifth: parsed.fifth || null,
    tA: tA?.value || null,
    tACPreview: tA?.CPreview || null,
    mHexPreview: m?.mHexPreview || null,
    BPreview: B?.value || null,
    directRxOutput: row?.directRxAfterToken?.output || null,
    error: row?.error || null,
  };
}

async function main() {
  const customSessionIdBlobBase64 = process.argv[2] || null;
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    sessionIdBlobExperiment: !customSessionIdBlobBase64,
    customSessionIdBlobBase64,
  });
  const exp = out?.sessionIdBlobExperiment || null;
  const rows = [];
  if (exp?.baseline) {
    rows.push(simplify('baseline', exp.baseline));
  }
  for (const row of exp?.rows || []) {
    rows.push(simplify(row?.label || 'row', row));
  }
  console.log(JSON.stringify({
    customSessionIdBlobBase64Provided: !!customSessionIdBlobBase64,
    secretKeyBytes: exp?.secretKeyBytes || null,
    sessionIdBytes: exp?.sessionIdBytes || null,
    sharedPrefixBytes: exp?.sharedPrefixBytes || null,
    rows,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
