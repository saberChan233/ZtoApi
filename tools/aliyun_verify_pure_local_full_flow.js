#!/usr/bin/env node

const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { compareCaptchaVerifyParam } = require('./aliyun_captcha_verify_param_local');
const { compareRequestShape } = require('./aliyun_verify_request_local');
const {
  extractReplaySeedFromSolverResult,
  buildPureLocalFlowFromSeed,
} = require('./aliyun_pure_local_full_flow');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    securityToken: 'probe-security-token-full-flow',
  });
  const seed = extractReplaySeedFromSolverResult(out);
  const flow = buildPureLocalFlowFromSeed(seed);
  const runtimeCaptchaVerifyPayload = out.verifyRequest?.params?.CaptchaVerifyParam
    ? JSON.parse(out.verifyRequest.params.CaptchaVerifyParam)
    : null;
  console.log(JSON.stringify({
    seed,
    checks: {
      preidHMatch: flow.preid.H === out.localPreidExactRuntimeIv?.rebuilt?.H,
      preidNgMatch: flow.preid.ng === out.localPreidExactRuntimeIv?.rebuilt?.ng,
      preidPlainMatch: flow.preid.preidPlain === out.localPreidExactRuntimeIv?.rebuilt?.preidPlain,
      captchaVerifyParam: compareCaptchaVerifyParam(runtimeCaptchaVerifyPayload, flow.captchaVerifyParam),
      initRequest: compareRequestShape(out.initRequest, flow.initRequest),
      verifyRequest: compareRequestShape(out.verifyRequest, flow.verifyRequest),
      finalCaptchaVerifyParamMatch:
        flow.finalCaptchaVerifyParam?.captcha_verify_param === out.synthesizedFromSecurityToken?.captcha_verify_param,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
