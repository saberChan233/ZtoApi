#!/usr/bin/env node

const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { compareCaptchaVerifyParam } = require('./aliyun_captcha_verify_param_local');
const { compareRequestShape } = require('./aliyun_verify_request_local');
const {
  extractReplaySeedFromSolverResult,
  buildPureLocalFlowFromSeed,
  compareReplaySeeds,
  toCompactReplaySeed,
  expandCompactReplaySeed,
} = require('./aliyun_pure_local_full_flow');

function summarizeCompactSeed(compact) {
  return {
    keys: Object.keys(compact || {}).sort(),
    jsonBytes: Buffer.byteLength(JSON.stringify(compact || {}), 'utf8'),
  };
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    securityToken: 'probe-security-token-compact-seed',
  });

  const seed = extractReplaySeedFromSolverResult(out);
  const compact = toCompactReplaySeed(seed);
  const expanded = expandCompactReplaySeed(compact);
  const flowFromSeed = buildPureLocalFlowFromSeed(seed);
  const flowFromCompact = buildPureLocalFlowFromSeed(expanded);
  const runtimeCaptchaVerifyPayload = out.verifyRequest?.params?.CaptchaVerifyParam
    ? JSON.parse(out.verifyRequest.params.CaptchaVerifyParam)
    : null;

  console.log(JSON.stringify({
    compactSummary: summarizeCompactSeed(compact),
    checks: {
      seedRoundtripMatch: compareReplaySeeds(seed, expanded),
      preidHMatch: flowFromSeed.preid.H === flowFromCompact.preid.H,
      preidNgMatch: flowFromSeed.preid.ng === flowFromCompact.preid.ng,
      preidPlainMatch: flowFromSeed.preid.preidPlain === flowFromCompact.preid.preidPlain,
      captchaVerifyParamMatch: compareCaptchaVerifyParam(
        flowFromSeed.captchaVerifyParam,
        flowFromCompact.captchaVerifyParam,
      ),
      initRequestMatch: compareRequestShape(flowFromSeed.initRequest, flowFromCompact.initRequest),
      verifyRequestMatch: compareRequestShape(flowFromSeed.verifyRequest, flowFromCompact.verifyRequest),
      runtimeCaptchaVerifyParamMatch: compareCaptchaVerifyParam(runtimeCaptchaVerifyPayload, flowFromCompact.captchaVerifyParam),
      finalCaptchaVerifyParamMatch:
        flowFromCompact.finalCaptchaVerifyParam?.captcha_verify_param === out.synthesizedFromSecurityToken?.captcha_verify_param,
    },
    compact,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
