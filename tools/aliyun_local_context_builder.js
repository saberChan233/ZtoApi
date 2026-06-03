#!/usr/bin/env node

const crypto = require('crypto');
const { buildPreidTTFromContext } = require('./aliyun_preid_tt_local');
const { buildPreidHFromParts, getDefaultPreidHPrefixBuffer } = require('./aliyun_preid_h_local');
const { computePreidNg, buildPreidPlain } = require('./aliyun_preid_local');

const DEFAULTS = {
  prefix: 'no8xfe',
  region: 'sgp',
  appName: 'saf-captcha',
  appKey: '3795d28242a11619bc25f786f84e53d4',
  browserName: 'Chrome',
  browserVersion: '141.0.0.0',
  osName: 'Linux',
  osArch: 'x86_64',
  ip: '1.2.3.4',
  pageUrl: 'https://chat.z.ai/',
  fullUserAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  shortUserAgent: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  fontsNum: 264,
  numericSlotA: 8,
  numericSlotB: 8,
  truthyFlag: 'true',
  deviceClass: 'desktop',
  brands: '[Chromium,Google Chrome]',
};

function generateHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateBase62(length = 40) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function buildSecondSegment({
  appKey = DEFAULTS.appKey,
  sessionTimestamp = Date.now(),
  sessionNonceHex = generateHex(16),
}) {
  return `${appKey}-h-${sessionTimestamp}-${sessionNonceHex}`;
}

function buildPreidRuntimeContext(seed = {}) {
  const appKey = seed.appKey || DEFAULTS.appKey;
  const sessionTimestamp = String(seed.sessionTimestamp ?? Date.now());
  const initTime = Number(seed.initTime ?? Date.now());
  const finalTimestamp = String(seed.finalTimestamp ?? initTime + 500);
  const token71 = seed.token71 || generateBase62(40);
  const certifyId = seed.certifyId || `probe-certify-id-${Math.random().toString(16).slice(2, 10)}`;
  const nO = seed.nO || buildSecondSegment({
    appKey,
    sessionTimestamp,
    sessionNonceHex: seed.sessionNonceHex || generateHex(16),
  });
  return {
    prefix: seed.prefix || DEFAULTS.prefix,
    region: seed.region || DEFAULTS.region,
    appName: seed.appName || DEFAULTS.appName,
    appKey,
    browserName: seed.browserName || DEFAULTS.browserName,
    browserVersion: seed.browserVersion || DEFAULTS.browserVersion,
    osName: seed.osName || DEFAULTS.osName,
    osArch: seed.osArch || DEFAULTS.osArch,
    osFull: seed.osFull || `${seed.osName || DEFAULTS.osName} ${seed.osArch || DEFAULTS.osArch}`,
    ip: seed.ip || DEFAULTS.ip,
    pageUrl: seed.pageUrl || DEFAULTS.pageUrl,
    fullUserAgent: seed.fullUserAgent || DEFAULTS.fullUserAgent,
    shortUserAgent: seed.shortUserAgent || DEFAULTS.shortUserAgent,
    fontsNum: seed.fontsNum ?? DEFAULTS.fontsNum,
    numericSlotA: seed.numericSlotA ?? DEFAULTS.numericSlotA,
    numericSlotB: seed.numericSlotB ?? DEFAULTS.numericSlotB,
    truthyFlag: seed.truthyFlag ?? DEFAULTS.truthyFlag,
    deviceClass: seed.deviceClass || DEFAULTS.deviceClass,
    brands: Array.isArray(seed.brands)
      ? `[${seed.brands.join(',')}]`
      : (seed.brands || DEFAULTS.brands),
    initTime: String(initTime),
    sessionTimestamp,
    finalTimestamp,
    token71,
    certifyId,
    nO,
  };
}

function buildSnapshotPreviewFromRuntimeContext(context) {
  const fullUa = context.fullUserAgent;
  const shortUa = context.shortUserAgent;
  const brandsArray = String(context.brands || DEFAULTS.brands)
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .filter(Boolean);
  return {
    prefix: { type: 'string', value: context.prefix },
    region: { type: 'string', value: context.region },
    appName: { type: 'string', value: context.appName },
    appKey: { type: 'string', value: context.appKey },
    initTime: { type: 'number', value: Number(context.initTime) },
    preCollectData: { type: 'object', value: { fontsNum: Number(context.fontsNum) } },
    deviceConfig: {
      type: 'object',
      value: {
        key: context.appKey,
        switch: 513,
        sessionId: context.nO,
        version: '3.25.0',
        pluginElements: '',
        pluginResource: '',
        globalVariable: '',
        timestamp: String(context.sessionTimestamp),
        ip: context.ip,
      },
    },
    deviceData: {
      type: 'object',
      value: {
        osFull: context.osFull,
        browserName: context.browserName,
        browserVersion: context.browserVersion,
        fontsNum: Number(context.fontsNum),
        numericSlotA: Number(context.numericSlotA),
        numericSlotB: Number(context.numericSlotB),
        osName: context.osName,
        osArch: context.osArch,
        ip: context.ip,
        truthyFlag: context.truthyFlag === true || context.truthyFlag === 'true',
        pageUrl: context.pageUrl,
        browserVersion2: context.browserVersion,
        fullUserAgent: fullUa,
        appName: context.appName,
        appStage: 2,
        token71: context.token71,
        initTime: Number(context.initTime),
        randomToken: generateBase62(42),
        finalTimestamp: Number(context.finalTimestamp),
        deviceClass: context.deviceClass,
        certifyId: context.certifyId,
        shortUserAgent: shortUa,
        shortUserAgent2: shortUa,
        sessionTimestamp: String(context.sessionTimestamp),
        brands: brandsArray,
        brands2: brandsArray,
      },
    },
  };
}

function computePreidFromRuntimeContext(seed = {}, options = {}) {
  const context = buildPreidRuntimeContext(seed);
  const tT = buildPreidTTFromContext(context, { finalTimestamp: context.finalTimestamp });
  const prefix = options.prefix || getDefaultPreidHPrefixBuffer();
  const built = buildPreidHFromParts(prefix, tT.slice(288), context.nO, options.iv);
  const ng = computePreidNg({ nO: context.nO, H: built.H });
  return {
    context,
    snapshotPreview: buildSnapshotPreviewFromRuntimeContext(context),
    tT,
    H: built.H,
    ng,
    iv: built.iv,
    preidPlain: buildPreidPlain({ nO: context.nO, H: built.H }, { ng }),
  };
}

if (require.main === module) {
  try {
    const seed = JSON.parse(process.argv[2] || '{}');
    const out = computePreidFromRuntimeContext(seed);
    console.log(JSON.stringify({
      context: out.context,
      tT: out.tT,
      H: out.H,
      ng: out.ng,
      preidPlain: out.preidPlain,
      snapshotPreview: out.snapshotPreview,
    }, null, 2));
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exit(1);
  }
} else {
  module.exports = {
    DEFAULTS,
    generateHex,
    generateBase62,
    buildSecondSegment,
    buildPreidRuntimeContext,
    buildSnapshotPreviewFromRuntimeContext,
    computePreidFromRuntimeContext,
  };
}
