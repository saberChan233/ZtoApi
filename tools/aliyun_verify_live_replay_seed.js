#!/usr/bin/env node

const crypto = require('crypto');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { compareCaptchaVerifyParam } = require('./aliyun_captcha_verify_param_local');
const {
  extractReplaySeedFromSolverResult,
  buildPureLocalFlowFromSeed,
  toLiveReplaySeed,
  expandLiveReplaySeed,
} = require('./aliyun_pure_local_full_flow');

function isoTimestampNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoTimestampFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function summarize(seed) {
  return {
    keys: Object.keys(seed || {}).sort(),
    jsonBytes: Buffer.byteLength(JSON.stringify(seed || {}), 'utf8'),
  };
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });

  const seed = extractReplaySeedFromSolverResult(out);
  const liveSeed = toLiveReplaySeed(seed);
  const expandedSameTimes = expandLiveReplaySeed(liveSeed, {
    initTimestamp: seed.initRequest?.timestamp,
    initNonce: seed.initRequest?.nonce,
    verifyTimestamp: seed.verifyRequest?.timestamp,
    verifyNonce: seed.verifyRequest?.nonce,
  });
  const flowFromSeed = buildPureLocalFlowFromSeed(seed);
  const flowFromLiveSameTimes = buildPureLocalFlowFromSeed(expandedSameTimes);
  const now = Date.now();
  const expandedFresh = expandLiveReplaySeed(liveSeed, {
    initTimestamp: isoTimestampFromMs(now),
    initNonce: crypto.randomUUID(),
    verifyTimestamp: isoTimestampFromMs(now + 1000),
    verifyNonce: crypto.randomUUID(),
  });
  const flowFromLiveFresh = buildPureLocalFlowFromSeed(expandedFresh);

  console.log(JSON.stringify({
    liveSeedSummary: summarize(liveSeed),
    checks: {
      sameTimePreidMatch: flowFromSeed.preid.preidPlain === flowFromLiveSameTimes.preid.preidPlain,
      sameTimeCaptchaVerifyParamMatch: compareCaptchaVerifyParam(
        flowFromSeed.captchaVerifyParam,
        flowFromLiveSameTimes.captchaVerifyParam,
      ),
      freshReplayPreidStable: flowFromSeed.preid.preidPlain === flowFromLiveFresh.preid.preidPlain,
      freshReplayCaptchaVerifyParamStable: compareCaptchaVerifyParam(
        flowFromSeed.captchaVerifyParam,
        flowFromLiveFresh.captchaVerifyParam,
      ),
      freshReplayRequestTimestampsChanged: {
        initChanged: flowFromSeed.initRequest.params.Timestamp !== flowFromLiveFresh.initRequest.params.Timestamp,
        verifyChanged: flowFromSeed.verifyRequest.params.Timestamp !== flowFromLiveFresh.verifyRequest.params.Timestamp,
        initNonceChanged: flowFromSeed.initRequest.params.SignatureNonce !== flowFromLiveFresh.initRequest.params.SignatureNonce,
        verifyNonceChanged: flowFromSeed.verifyRequest.params.SignatureNonce !== flowFromLiveFresh.verifyRequest.params.SignatureNonce,
      },
    },
    liveSeed,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
