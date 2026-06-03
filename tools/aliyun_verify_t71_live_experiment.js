#!/usr/bin/env node

const crypto = require('crypto');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { encodeFinalCaptchaVerifyParam } = require('./probe_feilin_runtime');
const {
  extractReplaySeedFromSolverResult,
  buildPureLocalFlowFromSeed,
  toLiveReplaySeed,
  toMinimalLiveReplaySeed,
  expandLiveReplaySeed,
  expandMinimalLiveReplaySeed,
} = require('./aliyun_pure_local_full_flow');
const { signCaptchaParams } = require('./aliyun_local_reverse');

function isoTimestampFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildFreshReplaySeedFromLive(liveSeed) {
  const now = Date.now();
  return expandLiveReplaySeed(liveSeed, {
    initTimestamp: isoTimestampFromMs(now),
    initNonce: crypto.randomUUID(),
    verifyTimestamp: isoTimestampFromMs(now + 1000),
    verifyNonce: crypto.randomUUID(),
  });
}

function buildFreshReplaySeedFromMinimal(minimalSeed) {
  const now = Date.now();
  return expandMinimalLiveReplaySeed(minimalSeed, {
    initTimestamp: isoTimestampFromMs(now),
    initNonce: crypto.randomUUID(),
    verifyTimestamp: isoTimestampFromMs(now + 1000),
    verifyNonce: crypto.randomUUID(),
  });
}

function serializeForm(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    body.set(key, value == null ? '' : String(value));
  }
  return body.toString();
}

async function executeFormRequest(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: serializeForm(params),
  });
  const bodyText = await response.text();
  let bodyJson = null;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = null;
  }
  return {
    status: response.status,
    ok: response.ok,
    bodyText,
    bodyJson,
  };
}

function rewriteVerifyRequestCertifyId(verifyRequest, certifyId) {
  const nextParams = { ...verifyRequest.params, CertifyId: certifyId };
  const parsed = JSON.parse(nextParams.CaptchaVerifyParam);
  parsed.certifyId = certifyId;
  nextParams.CaptchaVerifyParam = JSON.stringify(parsed);
  nextParams.Signature = signCaptchaParams(nextParams);
  return {
    url: verifyRequest.url,
    params: nextParams,
  };
}

function randomBase62(length = 40) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function runVariant(name, liveSeed, transformSeed) {
  const replaySeed = buildFreshReplaySeedFromLive(transformSeed(liveSeed));
  const flow = buildPureLocalFlowFromSeed(replaySeed);
  const liveInit = await executeFormRequest(flow.initRequest.url, flow.initRequest.params);
  const certifyId = liveInit?.bodyJson?.CertifyId || replaySeed.runtimeContext.certifyId;
  const liveVerifyRequest = rewriteVerifyRequestCertifyId(flow.verifyRequest, certifyId);
  const liveVerify = await executeFormRequest(liveVerifyRequest.url, liveVerifyRequest.params);
  const securityToken = liveVerify?.bodyJson?.Result?.securityToken || null;
  return {
    name,
    t71: replaySeed.runtimeContext.token71,
    init: {
      status: liveInit.status,
      bodyJson: liveInit.bodyJson,
    },
    verify: {
      status: liveVerify.status,
      bodyJson: liveVerify.bodyJson,
      hasSecurityToken: !!securityToken,
    },
    finalCaptchaVerifyParam: securityToken
      ? encodeFinalCaptchaVerifyParam({
        certifyId,
        sceneId: replaySeed.sceneId,
        securityToken,
      })
      : null,
  };
}

async function runMinimalVariant(name, minimalSeed) {
  const replaySeed = buildFreshReplaySeedFromMinimal(minimalSeed);
  const flow = buildPureLocalFlowFromSeed(replaySeed);
  const liveInit = await executeFormRequest(flow.initRequest.url, flow.initRequest.params);
  const certifyId = liveInit?.bodyJson?.CertifyId || replaySeed.runtimeContext.certifyId;
  const liveVerifyRequest = rewriteVerifyRequestCertifyId(flow.verifyRequest, certifyId);
  const liveVerify = await executeFormRequest(liveVerifyRequest.url, liveVerifyRequest.params);
  const securityToken = liveVerify?.bodyJson?.Result?.securityToken || null;
  return {
    name,
    t71: replaySeed.runtimeContext.token71,
    init: {
      status: liveInit.status,
      bodyJson: liveInit.bodyJson,
    },
    verify: {
      status: liveVerify.status,
      bodyJson: liveVerify.bodyJson,
      hasSecurityToken: !!securityToken,
    },
  };
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const seed = extractReplaySeedFromSolverResult(out);
  const liveSeed = toLiveReplaySeed(seed);
  const minimalLiveSeed = toMinimalLiveReplaySeed(seed);
  const exactResult = await runVariant('exact-t71', liveSeed, (value) => value);
  const randomResult = await runVariant('random-t71', liveSeed, (value) => ({
    ...value,
    t71: randomBase62(String(value.t71 || '').length || 40),
  }));
  const minimalResult = await runMinimalVariant('minimal-seed-random-t71', minimalLiveSeed);
  console.log(JSON.stringify({
    seedSummary: {
      liveSeedKeys: Object.keys(liveSeed).sort(),
      minimalLiveSeedKeys: Object.keys(minimalLiveSeed).sort(),
      originalT71: liveSeed.t71,
    },
    exactResult,
    randomResult,
    minimalResult,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
