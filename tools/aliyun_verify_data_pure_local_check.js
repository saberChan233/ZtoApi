#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const {
  buildVerifyDataSeed,
  encodeRuntimeSeedFromSeedPureLocal,
  encodeVerifyDataPureLocal,
} = require('./aliyun_verify_data_local');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const reverse = out.verifyDataReverse || {};
  if (!reverse.seedPrefix || !reverse.seedJsonParsed) {
    throw new Error('missing verifyDataReverse seed info');
  }
  const seed = buildVerifyDataSeed(reverse.seedPrefix, reverse.seedJsonParsed);
  const runtimeSeed = encodeRuntimeSeedFromSeedPureLocal(seed);
  const finalData = encodeVerifyDataPureLocal(reverse.seedPrefix, reverse.seedJsonParsed);
  console.log(JSON.stringify({
    keyHex: out.verifyDataRuntimeFrame?.keyHex || null,
    runtimeSeedMatch: runtimeSeed === out.verifyDataRuntimeFrame?.runtimeSeedBase64Like,
    finalDataMatch: finalData === reverse.dataValue,
    runtimeSeedPreview: runtimeSeed.slice(0, 160),
    finalDataPreview: finalData.slice(0, 200),
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
