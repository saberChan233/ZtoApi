#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { deobfuscateSource } = require('./aliyun_verify_g_callsite_deob');
const { buildCurrentBundleHelperChain } = require('./aliyun_verify_bundle_helper_local');
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const helperChain = buildCurrentBundleHelperChain('/tmp/aliyun-pe.js');
  const deob = deobfuscateSource(snapshot.gCallsiteSource || '', helperChain);
  console.log(JSON.stringify({
    deobSource: deob.deob,
    tmPairs: deob.tmPairs,
    verifyGCallsiteLogs: out.verifyGCallsiteLogs || [],
    verifyVmContext: out.verifyVmContext || null,
    verifyDataRuntimeFrame: out.verifyDataRuntimeFrame || null,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
