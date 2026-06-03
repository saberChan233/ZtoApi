#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { parseTokenPlain, verifyTokenPlain } = require('./feilin_local_token');
const { parseDeviceConfigToken } = require('./aliyun_local_reverse');

function decodeBase64Utf8(value) {
  if (typeof value !== 'string' || !value) return null;
  return Buffer.from(value, 'base64').toString('utf8');
}

function parsePreidTokenPlain(tokenPlain) {
  if (typeof tokenPlain !== 'string' || !tokenPlain) return null;
  const parts = tokenPlain.split('#');
  return {
    raw: tokenPlain,
    partsLength: parts.length,
    prefix: parts[0] ?? null,
    second: parts[1] ?? null,
    third: parts[2] ?? null,
    fourth: parts[3] ?? null,
    fifth: parts[4] ?? null,
  };
}

function summarizePreidThirdSegment(value) {
  if (typeof value !== 'string' || !value) return null;
  let decoded = null;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    decoded = null;
  }
  return {
    length: value.length,
    head: value.slice(0, 120),
    tail: value.slice(-120),
    decodedBytes: decoded ? decoded.length : null,
    decodedHexHead: decoded ? decoded.subarray(0, 48).toString('hex') : null,
  };
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });

  const verifyRaw = out.verifyRequest?.params?.CaptchaVerifyParam || null;
  const verifyPayload = verifyRaw ? JSON.parse(verifyRaw) : null;
  const verifyDeviceTokenPlain = verifyPayload?.deviceToken
    ? decodeBase64Utf8(verifyPayload.deviceToken)
    : null;
  const initDeviceTokenPlain = out.initRequest?.params?.DeviceToken
    ? decodeBase64Utf8(out.initRequest.params.DeviceToken)
    : null;
  const initToken = parseTokenPlain(initDeviceTokenPlain);
  const verifyPreidToken = parsePreidTokenPlain(verifyDeviceTokenPlain);
  const joinLog = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
  const namedParts = joinLog?.namedParts || null;
  const preidBtoa = (out.btoaLogs || []).find((item) =>
    typeof item?.inputPreview === 'string' && item.inputPreview.startsWith('SG_WEB_PREID#')
  ) || null;
  const initDeviceConfig = out.syntheticLog1DeviceConfig
    ? parseDeviceConfigToken(out.syntheticLog1DeviceConfig)
    : null;

  console.log(JSON.stringify({
    initToken,
    initTokenVerify: initDeviceTokenPlain ? verifyTokenPlain(initDeviceTokenPlain) : null,
    verifyPreidToken,
    verifyThirdSegmentSummary: summarizePreidThirdSegment(verifyPreidToken?.third || null),
    joinLog: joinLog ? {
      separatorPreview: joinLog.separatorPreview,
      separatorLength: joinLog.separatorLength,
      namedParts,
      joinedLength: joinLog.joinedLength,
    } : null,
    preidBtoa: preidBtoa ? {
      inputLen: preidBtoa.inputLen,
      outputPreviewHead: preidBtoa.outputPreview ? preidBtoa.outputPreview.slice(0, 120) : null,
      stack: preidBtoa.stack || null,
    } : null,
    syntheticInitDeviceConfig: initDeviceConfig ? {
      appKey: initDeviceConfig.appKey,
      flag: initDeviceConfig.flag,
      sessionId: initDeviceConfig.sessionId,
      version: initDeviceConfig.version,
      timestamp: initDeviceConfig.timestamp,
      ip: initDeviceConfig.ip,
    } : null,
    relations: {
      verifyPlainHeadMatchesJoinInputPreview:
        typeof verifyDeviceTokenPlain === 'string' &&
        typeof preidBtoa?.inputPreview === 'string' &&
        verifyDeviceTokenPlain.startsWith(preidBtoa.inputPreview),
      verifyPlainLengthMatchesJoinInputLen:
        typeof verifyDeviceTokenPlain === 'string' &&
        Number(preidBtoa?.inputLen || 0) === verifyDeviceTokenPlain.length,
      verifyPrefixMatchesJoin: verifyPreidToken?.prefix === namedParts?.tk,
      verifySecondMatchesJoin: verifyPreidToken?.second === namedParts?.nO,
      verifyThirdHeadMatchesJoin:
        typeof verifyPreidToken?.third === 'string' &&
        typeof namedParts?.H === 'string' &&
        verifyPreidToken.third.startsWith(namedParts.H),
      verifyFourthMatchesJoin: verifyPreidToken?.fourth === String(namedParts?.tA),
      verifyFifthMatchesJoin: verifyPreidToken?.fifth === namedParts?.ng,
      initSecondMatchesVerifySecond: initToken?.second === verifyPreidToken?.second,
      initSecondMatchesJoinSecond: initToken?.second === namedParts?.nO,
      syntheticSessionIdMatchesInitSecond: initDeviceConfig?.sessionId === initToken?.second,
      syntheticAppKeyMatchesVerifySecondPrefix:
        typeof verifyPreidToken?.second === 'string' &&
        typeof initDeviceConfig?.appKey === 'string' &&
        verifyPreidToken.second.startsWith(`${initDeviceConfig.appKey}-h-`),
      joinThirdLooksBase64: /^[A-Za-z0-9+/=]+$/.test(String(namedParts?.H || '')),
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
