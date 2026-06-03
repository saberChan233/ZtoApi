#!/usr/bin/env node

const { encodeVerifyDataPureLocal } = require('./aliyun_verify_data_local');

function encodeDeviceTokenFromPreidPlain(preidPlain) {
  if (typeof preidPlain !== 'string' || !preidPlain) {
    throw new Error('preidPlain must be a non-empty string');
  }
  return Buffer.from(preidPlain, 'utf8').toString('base64');
}

function buildCaptchaVerifyParam({ certifyId, sceneId, preidPlain, data, riskData }) {
  if (typeof certifyId !== 'string' || !certifyId) {
    throw new Error('certifyId must be a non-empty string');
  }
  if (typeof sceneId !== 'string' || !sceneId) {
    throw new Error('sceneId must be a non-empty string');
  }
  if (typeof data !== 'string' || !data) {
    throw new Error('data must be a non-empty string');
  }
  const payload = {
    sceneId,
    certifyId,
    deviceToken: encodeDeviceTokenFromPreidPlain(preidPlain),
    data,
  };
  if (typeof riskData === 'string' && riskData) {
    payload.riskData = riskData;
  }
  return payload;
}

function buildCaptchaVerifyParamFromParts({
  certifyId,
  sceneId,
  preidPlain,
  verifyDataPrefixHex,
  verifyDataPayload,
  riskData,
}) {
  const data = encodeVerifyDataPureLocal(verifyDataPrefixHex, verifyDataPayload);
  return buildCaptchaVerifyParam({
    certifyId,
    sceneId,
    preidPlain,
    data,
    riskData,
  });
}

function compareCaptchaVerifyParam(runtimePayload, localPayload) {
  if (!runtimePayload || !localPayload) {
    return {
      ok: false,
      error: 'missing payload(s)',
    };
  }
  return {
    sceneIdMatch: runtimePayload.sceneId === localPayload.sceneId,
    certifyIdMatch: runtimePayload.certifyId === localPayload.certifyId,
    deviceTokenMatch: runtimePayload.deviceToken === localPayload.deviceToken,
    dataMatch: runtimePayload.data === localPayload.data,
    riskDataMatch: runtimePayload.riskData === localPayload.riskData,
    exactMatch: JSON.stringify(runtimePayload) === JSON.stringify(localPayload),
  };
}

if (require.main === module) {
  try {
    const payload = JSON.parse(process.argv[2] || '');
    console.log(JSON.stringify(buildCaptchaVerifyParamFromParts(payload), null, 2));
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exit(1);
  }
} else {
  module.exports = {
    encodeDeviceTokenFromPreidPlain,
    buildCaptchaVerifyParam,
    buildCaptchaVerifyParamFromParts,
    compareCaptchaVerifyParam,
  };
}
