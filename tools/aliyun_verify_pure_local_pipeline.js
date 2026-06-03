#!/usr/bin/env node

const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const {
  extractPayloadForSynthesis,
  rebuildPreidFromSolverResult,
  rebuildPreidUsingRuntimeIvFromSolverResult,
  synthesizeCaptchaVerifyParamFromSolverResult,
} = require('./aliyun_pure_local_pipeline');
const {
  compareCaptchaVerifyParam,
} = require('./aliyun_captcha_verify_param_local');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    securityToken: 'probe-security-token-local-pipeline',
  });
  const payload = extractPayloadForSynthesis(out);
  const localPreidExact = rebuildPreidUsingRuntimeIvFromSolverResult(out);
  const localPreidIv0 = rebuildPreidFromSolverResult(out, {
    iv: Buffer.alloc(16, 0),
  });
  const finalParam = synthesizeCaptchaVerifyParamFromSolverResult(out, 'probe-security-token-local-pipeline');
  console.log(JSON.stringify({
    payloadForSynthesis: payload,
    localPreidExactOk: localPreidExact.ok,
    localPreidExactRuntimeMatches: localPreidExact.runtimeMatches || null,
    localPreidExactPlainPreview: localPreidExact.rebuilt?.preidPlain?.slice(0, 200) || null,
    localPreidIv0Ok: localPreidIv0.ok,
    localPreidIv0RuntimeMatches: localPreidIv0.runtimeMatches || null,
    localPreidHLength: localPreidExact.rebuilt?.H?.length || null,
    runtimeHLength: localPreidExact.context?.runtimeH?.length || null,
    localCaptchaVerifyParamExactCompare: compareCaptchaVerifyParam(
      payload,
      out.localCaptchaVerifyParamExactRuntimeIv || null,
    ),
    localCaptchaVerifyParamDeterministicIv0Compare: compareCaptchaVerifyParam(
      payload,
      out.localCaptchaVerifyParamDeterministicIv0 || null,
    ),
    localInitRequestExactCompare: out.localInitRequestExactCompare || null,
    localVerifyRequestExactCompare: out.localVerifyRequestExactCompare || null,
    localGeneratedPreidCompare: out.localGeneratedPreidCompare || null,
    synthesizedFromModule: finalParam,
    synthesizedFromSolver: out.synthesizedFromSecurityToken || null,
    finalParamMatchesSolver: finalParam?.captcha_verify_param === out.synthesizedFromSecurityToken?.captcha_verify_param,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
