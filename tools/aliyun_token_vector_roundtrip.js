#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const {
  buildTokenLPreviewFromVector,
  parseTokenLPreview,
} = require('./aliyun_token_vector');

function pickPart(report, name) {
  return (report?.n0PartLogs || []).find((entry) => entry?.name === name) || null;
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const original = String(pickPart(out, 'v')?.lPreview || '');
  const rebuilt = buildTokenLPreviewFromVector(out.tokenVector);
  const reparsed = parseTokenLPreview(rebuilt);
  console.log(JSON.stringify({
    originalLength: original.length,
    rebuiltLength: rebuilt.length,
    exactMatch: original === rebuilt,
    firstDiffIndex: (() => {
      const len = Math.max(original.length, rebuilt.length);
      for (let i = 0; i < len; i += 1) {
        if (original[i] !== rebuilt[i]) return i;
      }
      return -1;
    })(),
    vector: {
      uy: reparsed.uy,
      ce: reparsed.ce,
      ci: reparsed.ci,
      o6: reparsed.o6,
      secondTimestamp: reparsed.secondTimestamp,
    },
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
