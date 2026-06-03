#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const { signCaptchaParams } = require('./aliyun_local_reverse');

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

function sanitizeReplayHeaders(headers) {
  const next = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    const lower = String(key).toLowerCase();
    if (lower.startsWith(':')) {
      continue;
    }
    if ([
      'content-length',
      'host',
      'authority',
      'accept-encoding',
      'connection',
      'content-type',
    ].includes(lower)) {
      continue;
    }
    next[key] = String(value);
  }
  return next;
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
    ok: response.ok,
    bodyText,
    bodyJson,
  };
}

function isoTimestampNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function randomNonce() {
  return crypto.randomUUID();
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function refreshSignedParams(params) {
  const next = { ...params };
  next.Timestamp = isoTimestampNow();
  next.SignatureNonce = randomNonce();
  next.Signature = signCaptchaParams(next);
  return next;
}

function rewriteCertifyId(params, certifyId) {
  const next = { ...params, CertifyId: certifyId };
  const parsed = JSON.parse(next.CaptchaVerifyParam);
  parsed.certifyId = certifyId;
  next.CaptchaVerifyParam = JSON.stringify(parsed);
  next.Signature = signCaptchaParams(next);
  return next;
}

function rewriteUploadCertifyId(params, certifyId) {
  const next = { ...params };
  if ('CertifyId' in next) {
    next.CertifyId = certifyId;
  }
  if (typeof next.Data === 'string' && next.Data.includes('"certifyId"')) {
    try {
      const parsed = JSON.parse(next.Data);
      if (parsed && typeof parsed === 'object') {
        parsed.certifyId = certifyId;
        next.Data = JSON.stringify(parsed);
      }
    } catch {
      // ignore
    }
  }
  next.Signature = signCaptchaParams(next);
  return next;
}

async function runVariant(name, url, params, extraHeaders = null) {
  try {
    const result = await executeFormRequest(url, params, extraHeaders);
    return {
      name,
      request: {
        certifyId: params.CertifyId || null,
        timestamp: params.Timestamp || null,
        nonce: params.SignatureNonce || null,
        headerKeys: extraHeaders ? Object.keys(extraHeaders).sort() : [],
      },
      response: {
        status: result.status,
        code: result.bodyJson?.Code || null,
        verifyCode: result.bodyJson?.Result?.VerifyCode || null,
        verifyResult: result.bodyJson?.Result?.VerifyResult ?? null,
        hasSecurityToken: !!result.bodyJson?.Result?.securityToken,
        securityTokenPreview: result.bodyJson?.Result?.securityToken
          ? String(result.bodyJson.Result.securityToken).slice(0, 64)
          : null,
      },
    };
  } catch (error) {
    return {
      name,
      error: String(error && error.stack || error),
    };
  }
}

async function runInitVariant(name, url, params, extraHeaders = null) {
  try {
    const result = await executeFormRequest(url, params, extraHeaders);
    return {
      name,
      request: {
        sceneId: params.SceneId || null,
        timestamp: params.Timestamp || null,
        nonce: params.SignatureNonce || null,
        headerKeys: extraHeaders ? Object.keys(extraHeaders).sort() : [],
      },
      response: {
        status: result.status,
        code: result.bodyJson?.Code || null,
        certifyId: result.bodyJson?.CertifyId || null,
      },
    };
  } catch (error) {
    return {
      name,
      error: String(error && error.stack || error),
    };
  }
}

async function main() {
  const capturePath = getArg('--browser');
  if (!capturePath) {
    throw new Error('missing --browser <capture-json>');
  }
  const url = getArg('--url', 'https://no8xfe.captcha-open-southeast.aliyuncs.com/');

  const capture = readJson(capturePath);
  const params = capture.verify_form || null;
  const initParams = capture.init_form || null;
  const uploadParams = capture.upload_form || null;
  const verifyHeaders = sanitizeReplayHeaders(capture.verify_headers || {});
  const initHeaders = sanitizeReplayHeaders(capture.init_headers || {});
  const uploadHeaders = sanitizeReplayHeaders(capture.upload_headers || {});
  if (!params || !params.CaptchaVerifyParam) {
    throw new Error('browser capture missing verify_form');
  }

  const exactParams = clone(params);
  const refreshedParams = refreshSignedParams(clone(params));
  const refreshedAndSameCertParams = rewriteCertifyId(refreshedParams, params.CertifyId);

  const results = [];
  let initReplay = null;
  results.push(await runVariant('exact-captured-request', url, exactParams));
  results.push(await runVariant('refreshed-signed-same-certify', url, refreshedAndSameCertParams));
  results.push(await runVariant('refreshed-signed-same-certify-browser-headers', url, refreshedAndSameCertParams, verifyHeaders));
  if (initParams && initParams.DeviceToken) {
    const refreshedInit = refreshSignedParams(clone(initParams));
    initReplay = await runInitVariant('refreshed-init-request', url, refreshedInit);
    results.push(await runInitVariant('refreshed-init-request-browser-headers', url, refreshedInit, initHeaders));
    const freshCertifyId = initReplay?.response?.certifyId || null;
    if (freshCertifyId) {
      if (uploadParams && Object.keys(uploadParams).length > 0) {
        const refreshedUpload = rewriteUploadCertifyId(refreshSignedParams(clone(uploadParams)), freshCertifyId);
        results.push(await runVariant('fresh-init-then-browser-uploadlog', url, refreshedUpload));
        results.push(await runVariant('fresh-init-then-browser-uploadlog-browser-headers', url, refreshedUpload, uploadHeaders));
      }
      const verifyAfterFreshInit = rewriteCertifyId(refreshSignedParams(clone(params)), freshCertifyId);
      results.push(await runVariant('fresh-init-then-browser-verify-payload', url, verifyAfterFreshInit));
      results.push(await runVariant('fresh-init-then-browser-verify-payload-browser-headers', url, verifyAfterFreshInit, verifyHeaders));
    }
  }

  console.log(JSON.stringify({
    browserCapture: {
      initSceneId: initParams?.SceneId || null,
      initTimestamp: initParams?.Timestamp || null,
      initNonce: initParams?.SignatureNonce || null,
      certifyId: params.CertifyId || null,
      sceneId: params.SceneId || null,
      timestamp: params.Timestamp || null,
      nonce: params.SignatureNonce || null,
      captchaVerifyParamLength: params.CaptchaVerifyParam.length,
    },
    initReplay,
    results,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
