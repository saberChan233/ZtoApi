#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { buildTokenLPreviewFromVector } = require('./aliyun_token_vector');

function pickPart(report, name) {
  return (report?.n0PartLogs || []).find((entry) => entry?.name === name) || null;
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const v = pickPart(out, 'v');
  const x = v?.xPreview || out.tokenVector?.xPrefix || null;
  const originalL = v?.lPreview || null;
  const rebuiltL = buildTokenLPreviewFromVector(out.tokenVector);
  const replay = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    rsExperimentInputs: [
      { label: 'original-lpreview', arg0: x, arg1: originalL },
      { label: 'rebuilt-lpreview', arg0: x, arg1: rebuiltL },
    ],
  });
  console.log(JSON.stringify({
    x,
    originalLength: originalL ? originalL.length : 0,
    rebuiltLength: rebuiltL.length,
    exactInputMatch: originalL === rebuiltL,
    rsExperiment: replay.rsExperiment,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
