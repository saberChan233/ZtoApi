#!/usr/bin/env node
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { executeCurrentBundleTvm } = require('./aliyun_verify_tvm_local');
const { buildCurrentBundleHelperChain } = require('./aliyun_verify_bundle_helper_local');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const verifyVmContext = out.verifyVmContext || {};
  const runtimeFrame = out.verifyDataRuntimeFrame || {};
  const helperChain = buildCurrentBundleHelperChain('/tmp/aliyun-pe.js');
  const execution = executeCurrentBundleTvm({
    n: 0,
    r: snapshot.R,
    i: snapshot.q,
    a: verifyVmContext.eWPreview || {},
    o: verifyVmContext.oPreview || [],
  });
  console.log(JSON.stringify({
    verifyVmContext,
    helperSymbols: helperChain.getKnownBundleSymbols(),
    computedKeyHex: helperChain.computeVerifyKeyHex(verifyVmContext.nQPreview || ''),
    result: execution.result,
    error: execution.error,
    finalStackLength: execution.finalStack.length,
    finalStackTail: execution.finalStack.slice(-12),
    finalAKeys: execution.finalState && typeof execution.finalState === 'object'
      ? Object.keys(execution.finalState).slice(0, 40)
      : null,
    finalA: execution.finalState,
    runtimeFrame: {
      keyHex: runtimeFrame.keyHex || null,
      runtimeSeedBase64Like: runtimeFrame.runtimeSeedBase64Like || null,
      initialPermTable: runtimeFrame.initialPermTable || null,
      rawBinaryPreview: runtimeFrame.rawBinaryPreview || null,
      finalDataBase64: runtimeFrame.finalDataBase64 || null,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
