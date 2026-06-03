#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { signCaptchaParams } = require('./aliyun_local_reverse');

const VERIFY_URL = 'https://no8xfe.captcha-open-southeast.aliyuncs.com/';
const FILES = ['/tmp/feilin052.js', '/tmp/aliyun-pe-088.js', '/tmp/AliyunCaptcha.js'];

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function serializeForm(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    body.set(key, value == null ? '' : String(value));
  }
  return body.toString();
}

async function executeFormRequest(url, params, extraHeaders = null) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...(extraHeaders || {}),
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
    bodyText,
    bodyJson,
  };
}

function isoTimestampNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function refreshSignedParams(params) {
  const next = { ...params };
  next.Timestamp = isoTimestampNow();
  next.SignatureNonce = crypto.randomUUID();
  next.Signature = signCaptchaParams(next);
  return next;
}

function rewriteUploadCertifyId(params, certifyId) {
  const next = refreshSignedParams({ ...params });
  if ('CertifyId' in next) {
    next.CertifyId = certifyId;
  }
  if (typeof next.Data === 'string' && next.Data.includes('"certifyId"')) {
    try {
      const parsed = JSON.parse(next.Data);
      parsed.certifyId = certifyId;
      next.Data = JSON.stringify(parsed);
    } catch {
      // ignore
    }
  }
  next.Signature = signCaptchaParams(next);
  return next;
}

function buildVerifyParams(baseParams, certifyId, payload) {
  const next = {
    ...baseParams,
    Timestamp: isoTimestampNow(),
    SignatureNonce: crypto.randomUUID(),
    CertifyId: certifyId,
    CaptchaVerifyParam: JSON.stringify({
      ...payload,
      certifyId,
    }),
  };
  next.Signature = signCaptchaParams(next);
  return next;
}

async function main() {
  const capturePath = getArg('--capture', '/tmp/browser_verify_capture_live.json');
  const capture = readJson(capturePath);
  const browserPayload = JSON.parse(capture.verify_form.CaptchaVerifyParam);

  const out = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const localPayload = JSON.parse(out.verifyRequest.params.CaptchaVerifyParam);

  const freshInit = refreshSignedParams({ ...capture.init_form });
  const initResult = await executeFormRequest(VERIFY_URL, freshInit);
  const freshCertifyId = initResult.bodyJson?.CertifyId || null;
  if (!freshCertifyId) {
    throw new Error(`fresh init missing CertifyId: ${JSON.stringify(initResult.bodyJson)}`);
  }

  const freshUpload = capture.upload_form
    ? rewriteUploadCertifyId({ ...capture.upload_form }, freshCertifyId)
    : null;
  const uploadResult = freshUpload
    ? await executeFormRequest(VERIFY_URL, freshUpload)
    : null;

  const variants = [
    ['browser+browser', { ...browserPayload }],
    ['localToken+browserData', {
      ...browserPayload,
      deviceToken: localPayload.deviceToken,
    }],
    ['browserToken+localData', {
      ...browserPayload,
      data: localPayload.data,
    }],
    ['local+local', {
      ...browserPayload,
      deviceToken: localPayload.deviceToken,
      data: localPayload.data,
    }],
  ];

  const rows = [];
  for (const [name, payload] of variants) {
    const verifyParams = buildVerifyParams(capture.verify_form, freshCertifyId, payload);
    const result = await executeFormRequest(VERIFY_URL, verifyParams);
    rows.push({
      name,
      status: result.status,
      verifyCode: result.bodyJson?.Result?.VerifyCode || null,
      verifyResult: result.bodyJson?.Result?.VerifyResult ?? null,
      hasSecurityToken: !!result.bodyJson?.Result?.securityToken,
    });
  }

  console.log(JSON.stringify({
    freshInit: {
      status: initResult.status,
      certifyId: freshCertifyId,
    },
    freshUpload: uploadResult
      ? {
        status: uploadResult.status,
        code: uploadResult.bodyJson?.Code || null,
      }
      : null,
    localVmVerifyCode: out.liveVerify?.bodyJson?.Result?.VerifyCode || null,
    browserTokenLength: browserPayload.deviceToken.length,
    localTokenLength: localPayload.deviceToken.length,
    browserDataLength: browserPayload.data.length,
    localDataLength: localPayload.data.length,
    rows,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
