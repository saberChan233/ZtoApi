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
  const rebuiltL = buildTokenLPreviewFromVector(out.tokenVector);
  const replay = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    rsExperimentInputs: [
      { label: 'window-this', thisKind: 'window', arg0: x, arg1: rebuiltL },
      { label: 'last-rs-this', thisKind: 'last-rs', arg0: x, arg1: rebuiltL },
      { label: 'last-rx-this', thisKind: 'last-rx', arg0: x, arg1: rebuiltL },
      { label: 'null-this', thisKind: 'null', arg0: x, arg1: rebuiltL },
      { label: 'undefined-this', thisKind: 'undefined', arg0: x, arg1: rebuiltL },
    ],
  });
  console.log(JSON.stringify({
    x,
    rebuiltLength: rebuiltL.length,
    recentRsCall: (replay.feilinRsLogs || []).find((row) => row?.arg1Length === rebuiltL.length) || null,
    rsExperiment: replay.rsExperiment,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
