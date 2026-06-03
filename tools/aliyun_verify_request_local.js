#!/usr/bin/env node

const { KEY_ID, signCaptchaParams } = require('./aliyun_local_reverse');
const { buildFullToken } = require('./feilin_local_token');

const DEFAULT_VERIFY_ENDPOINT = 'https://no8xfe.captcha-open-southeast.aliyuncs.com/';
const DEFAULT_VERSION = '2023-03-05';
const DEFAULT_FORMAT = 'JSON';
const DEFAULT_SIGNATURE_METHOD = 'HMAC-SHA1';
const DEFAULT_SIGNATURE_VERSION = '1.0';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_MODE = 'popup';

function buildBaseParams({ timestamp, nonce, sceneId, action }) {
  if (!timestamp || !nonce || !sceneId || !action) {
    throw new Error('timestamp / nonce / sceneId / action are required');
  }
  return {
    AccessKeyId: KEY_ID,
    SignatureMethod: DEFAULT_SIGNATURE_METHOD,
    SignatureVersion: DEFAULT_SIGNATURE_VERSION,
    Format: DEFAULT_FORMAT,
    Timestamp: timestamp,
    Version: DEFAULT_VERSION,
    Action: action,
    SceneId: sceneId,
    SignatureNonce: nonce,
  };
}

function buildInitCaptchaV3Request({
  timestamp,
  nonce,
  sceneId,
  deviceSecondSegment,
  deviceTokenPlain,
  deviceTokenBase64,
  language = DEFAULT_LANGUAGE,
  mode = DEFAULT_MODE,
  url = DEFAULT_VERIFY_ENDPOINT,
}) {
  const resolvedDeviceTokenBase64 = (() => {
    if (typeof deviceTokenBase64 === 'string' && deviceTokenBase64) return deviceTokenBase64;
    if (typeof deviceTokenPlain === 'string' && deviceTokenPlain) {
      return Buffer.from(deviceTokenPlain, 'utf8').toString('base64');
    }
    if (typeof deviceSecondSegment !== 'string' || !deviceSecondSegment) {
      throw new Error('deviceSecondSegment or deviceTokenPlain/deviceTokenBase64 is required');
    }
    return Buffer.from(buildFullToken(deviceSecondSegment), 'utf8').toString('base64');
  })();
  const params = {
    ...buildBaseParams({ timestamp, nonce, sceneId, action: 'InitCaptchaV3' }),
    Language: language,
    Mode: mode,
    DeviceToken: resolvedDeviceTokenBase64,
  };
  params.Signature = signCaptchaParams(params);
  return { url, params };
}

function buildVerifyCaptchaV3Request({
  timestamp,
  nonce,
  sceneId,
  certifyId,
  captchaVerifyParam,
  url = DEFAULT_VERIFY_ENDPOINT,
}) {
  if (!certifyId || !captchaVerifyParam) {
    throw new Error('certifyId and captchaVerifyParam are required');
  }
  const params = {
    ...buildBaseParams({ timestamp, nonce, sceneId, action: 'VerifyCaptchaV3' }),
    CertifyId: certifyId,
    CaptchaVerifyParam: typeof captchaVerifyParam === 'string'
      ? captchaVerifyParam
      : JSON.stringify(captchaVerifyParam),
  };
  params.Signature = signCaptchaParams(params);
  return { url, params };
}

function compareRequestShape(runtimeRequest, localRequest) {
  if (!runtimeRequest || !localRequest) {
    return { ok: false, error: 'missing request(s)' };
  }
  const runtimeParams = runtimeRequest.params || {};
  const localParams = localRequest.params || {};
  const keys = Array.from(new Set([...Object.keys(runtimeParams), ...Object.keys(localParams)])).sort();
  const fields = Object.fromEntries(keys.map((key) => [key, String(runtimeParams[key] ?? '') === String(localParams[key] ?? '')]));
  const stable = (value) => JSON.stringify(
    Object.fromEntries(
      Object.keys(value || {}).sort().map((key) => [key, String(value[key] ?? '')]),
    ),
  );
  const urlMatch = String(runtimeRequest.url || '') === String(localRequest.url || '');
  const paramsMatch = keys.every((key) => fields[key]);
  return {
    urlMatch,
    paramsMatch,
    exactMatch: urlMatch && stable(runtimeParams) === stable(localParams),
    fields,
  };
}

if (require.main === module) {
  try {
    const payload = JSON.parse(process.argv[2] || '');
    const kind = process.argv[3] || 'verify';
    const out = kind === 'init'
      ? buildInitCaptchaV3Request(payload)
      : buildVerifyCaptchaV3Request(payload);
    console.log(JSON.stringify(out, null, 2));
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exit(1);
  }
} else {
  module.exports = {
    DEFAULT_VERIFY_ENDPOINT,
    DEFAULT_VERSION,
    DEFAULT_FORMAT,
    DEFAULT_SIGNATURE_METHOD,
    DEFAULT_SIGNATURE_VERSION,
    DEFAULT_LANGUAGE,
    DEFAULT_MODE,
    buildBaseParams,
    buildInitCaptchaV3Request,
    buildVerifyCaptchaV3Request,
    compareRequestShape,
  };
}
