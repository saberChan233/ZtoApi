#!/usr/bin/env node

const crypto = require('crypto');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const {
  extractReplaySeedFromSolverResult,
  buildPureLocalFlowFromSeed,
  toMinimalLiveReplaySeed,
  toUltraMinimalLiveReplaySeed,
  expandMinimalLiveReplaySeed,
  expandUltraMinimalLiveReplaySeed,
} = require('./aliyun_pure_local_full_flow');
const { signCaptchaParams } = require('./aliyun_local_reverse');

function isoTimestampFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
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

function buildFreshReplaySeedFromUltraMinimal(ultraSeed) {
  const now = Date.now();
  return expandUltraMinimalLiveReplaySeed(ultraSeed, {
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

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

async function runVariant(name, minimalSeed, mutate) {
  const replaySeed = buildFreshReplaySeedFromMinimal(mutate({ ...minimalSeed, vd: { ...(minimalSeed.vd || {}) } }));
  const flow = buildPureLocalFlowFromSeed(replaySeed);
  const liveInit = await executeFormRequest(flow.initRequest.url, flow.initRequest.params);
  const certifyId = liveInit?.bodyJson?.CertifyId || replaySeed.runtimeContext.certifyId;
  const liveVerifyRequest = rewriteVerifyRequestCertifyId(flow.verifyRequest, certifyId);
  const liveVerify = await executeFormRequest(liveVerifyRequest.url, liveVerifyRequest.params);
  return {
    name,
    seed: {
      iv: replaySeed.preidIvHex,
      vpt: replaySeed.verifyDataPrefixHex?.slice(0, -2) || null,
      at: replaySeed.verifyDataPayload?.arg || null,
    },
    init: {
      status: liveInit.status,
      code: liveInit.bodyJson?.Code || null,
      certifyId: liveInit.bodyJson?.CertifyId || null,
    },
    verify: {
      status: liveVerify.status,
      code: liveVerify.bodyJson?.Code || null,
      verifyCode: liveVerify.bodyJson?.Result?.VerifyCode || null,
      verifyResult: liveVerify.bodyJson?.Result?.VerifyResult ?? null,
      hasSecurityToken: !!liveVerify.bodyJson?.Result?.securityToken,
    },
  };
}

async function runUltraMinimalVariant(name, ultraSeed) {
  const replaySeed = buildFreshReplaySeedFromUltraMinimal({ ...ultraSeed });
  const flow = buildPureLocalFlowFromSeed(replaySeed);
  const liveInit = await executeFormRequest(flow.initRequest.url, flow.initRequest.params);
  const certifyId = liveInit?.bodyJson?.CertifyId || replaySeed.runtimeContext.certifyId;
  const liveVerifyRequest = rewriteVerifyRequestCertifyId(flow.verifyRequest, certifyId);
  const liveVerify = await executeFormRequest(liveVerifyRequest.url, liveVerifyRequest.params);
  return {
    name,
    seed: {
      iv: replaySeed.preidIvHex,
      vpt: replaySeed.verifyDataPrefixHex?.slice(0, -2) || null,
      at: replaySeed.verifyDataPayload?.arg || null,
      t71: replaySeed.runtimeContext.token71,
    },
    init: {
      status: liveInit.status,
      code: liveInit.bodyJson?.Code || null,
      certifyId: liveInit.bodyJson?.CertifyId || null,
    },
    verify: {
      status: liveVerify.status,
      code: liveVerify.bodyJson?.Code || null,
      verifyCode: liveVerify.bodyJson?.Result?.VerifyCode || null,
      verifyResult: liveVerify.bodyJson?.Result?.VerifyResult ?? null,
      hasSecurityToken: !!liveVerify.bodyJson?.Result?.securityToken,
    },
  };
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const seed = extractReplaySeedFromSolverResult(out);
  const minimal = toMinimalLiveReplaySeed(seed);
  const ultraMinimal = toUltraMinimalLiveReplaySeed(seed);

  const variants = [
    ['exact', (x) => x],
    ['random-iv', (x) => ({ ...x, iv: randomHex(16) })],
    ['drop-iv', (x) => {
      delete x.iv;
      return x;
    }],
    ['random-vpt', (x) => ({ ...x, vpt: randomHex(15) })],
    ['random-at', (x) => ({ ...x, vd: { ...(x.vd || {}), at: randomHex(8) } })],
    ['random-vpt-at', (x) => ({ ...x, vpt: randomHex(15), vd: { ...(x.vd || {}), at: randomHex(8) } })],
  ];

  const results = [];
  for (const [name, mutate] of variants) {
    results.push(await runVariant(name, minimal, mutate));
  }
  results.push(await runUltraMinimalVariant('ultra-minimal-random-all', ultraMinimal));

  console.log(JSON.stringify({
    minimalSeedKeys: Object.keys(minimal).sort(),
    ultraMinimalSeedKeys: Object.keys(ultraMinimal).sort(),
    results,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
