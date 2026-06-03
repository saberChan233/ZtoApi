#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { buildCurrentBundleHelperChain } = require('./aliyun_verify_bundle_helper_local');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const helperChain = buildCurrentBundleHelperChain('/tmp/aliyun-pe.js');
  console.log(JSON.stringify({
    verifyVmContext: out.verifyVmContext || null,
    helperSymbols: helperChain.getKnownBundleSymbols(),
    computedKeyHex: helperChain.computeVerifyKeyHex(out.verifyVmContext?.nQPreview || ''),
    verifyDataCallsiteLogs: out.verifyDataCallsiteLogs || [],
    verifyDataRuntimeFrame: out.verifyDataRuntimeFrame || null,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
