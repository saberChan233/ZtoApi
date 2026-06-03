#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { executeCurrentBundleTvm } = require('./aliyun_verify_tvm_local');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const verifyVmContext = out.verifyVmContext || {};
  const runtimeFrame = out.verifyDataRuntimeFrame || {};
  const seed = verifyVmContext.nxPreview || null;
  const baseA = verifyVmContext.eWPreview || {};
  const variants = [
    { label: 'captured-tmValue', o: [seed, verifyVmContext.tmValue] },
    { label: 'nQ-prefix', o: [seed, verifyVmContext.nQPreview] },
    { label: 'keyHex-full', o: [seed, runtimeFrame.keyHex || null] },
    { label: 'runtime-seed', o: [runtimeFrame.runtimeSeedBase64Like || null, verifyVmContext.tmValue] },
  ];
  const rows = variants.map((variant) => {
    const execution = executeCurrentBundleTvm({
      n: 0,
      a: baseA,
      o: variant.o,
    });
    return {
      label: variant.label,
      input: variant.o,
      ok: execution.ok,
      result: execution.result,
      error: execution.error,
      finalStackTail: execution.finalStack.slice(-8),
      finalStateKeys: execution.finalState && typeof execution.finalState === 'object'
        ? Object.keys(execution.finalState).slice(0, 20)
        : null,
    };
  });
  console.log(JSON.stringify({
    verifyVmContext,
    runtimeFrame: {
      keyHex: runtimeFrame.keyHex || null,
      runtimeSeedBase64Like: runtimeFrame.runtimeSeedBase64Like || null,
    },
    rows,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
