#!/usr/bin/env node
const { loadNrDecoder } = require('./aliyun_nr_local');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const decoder = loadNrDecoder('/tmp/aliyun-pe.js');
  const verifyVmContext = out.verifyVmContext || {};
  const samples = [
    [58, 217],
    [49, 52],
    [84, 30],
    [33, 89],
    [65, 7],
    [227, 78],
    [262, 73],
    [187, 62],
  ];
  console.log(JSON.stringify({
    verifyVmContext,
    decodedSamples: samples.map(([x, y]) => ({
      x,
      y,
      to: decoder.safeTo(x, y),
      tm: decoder.safeTm(x, y),
    })),
    runtimeFrame: {
      keyHex: out.verifyDataRuntimeFrame?.keyHex || null,
      runtimeSeedBase64Like: out.verifyDataRuntimeFrame?.runtimeSeedBase64Like || null,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
