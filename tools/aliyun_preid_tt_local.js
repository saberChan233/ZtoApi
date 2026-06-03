#!/usr/bin/env node

const PREID_TT_PREFIX = 'W.10001.c';
const PREID_TT_LENGTH = 111;
const PREID_TT_APP_STAGE = '2';
const PREID_TT_DEFAULT_BOOL = 'true';
const PREID_TT_BRANDS_DEFAULT = '[Not-A.Brand,Chromium,Google Chrome]';
const PREID_TT_FINAL_TIMESTAMP_RULE = 'Date.now() at PREID.H generation';

function stringifyBrands(value) {
  if (typeof value === 'string' && value) {
    return value;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => String(item || '')).join(',')}]`;
  }
  throw new Error('missing brands');
}

function getPreviewValue(node) {
  return node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, 'value')
    ? node.value
    : node;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function computePreidTTFinalTimestamp(now = Date.now()) {
  return String(now);
}

function buildPreidTTFromContext(context, options = {}) {
  const finalTimestamp = String(
    options.finalTimestamp ??
      context.finalTimestamp ??
      computePreidTTFinalTimestamp(),
  );
  const values = new Array(PREID_TT_LENGTH).fill('');
  values[0] = PREID_TT_PREFIX;
  values[5] = String(context.osFull);
  values[6] = String(context.browserName);
  values[7] = String(context.browserVersion);
  values[20] = String(context.fontsNum);
  values[22] = String(context.numericSlotA ?? 8);
  values[34] = String(context.numericSlotB ?? 8);
  values[36] = String(context.osName);
  values[37] = String(context.osArch);
  values[42] = context.ttIp != null ? String(context.ttIp) : String(context.ip ?? '');
  values[44] = String(context.truthyFlag ?? PREID_TT_DEFAULT_BOOL);
  values[53] = String(context.pageUrl);
  values[63] = String(context.browserVersion);
  values[64] = String(context.fullUserAgent);
  values[67] = String(context.appName);
  values[68] = String(context.appStage ?? PREID_TT_APP_STAGE);
  values[71] = String(context.token71);
  values[72] = String(context.initTime);
  values[74] = finalTimestamp;
  values[75] = String(context.deviceClass);
  values[77] = context.ttCertifyId != null ? String(context.ttCertifyId) : String(context.certifyId ?? '');
  values[80] = String(context.shortUserAgent);
  values[87] = context.ttSessionTimestamp != null ? String(context.ttSessionTimestamp) : String(context.sessionTimestamp ?? '');
  values[110] = String(context.ttBrands || context.brands);

  for (const index of [5, 6, 7, 20, 22, 34, 36, 37, 44, 53, 63, 64, 67, 68, 71, 72, 74, 75, 80, 110]) {
    if (!isNonEmptyString(values[index])) {
      throw new Error(`missing PREID.tT field at index ${index}`);
    }
  }
  return values.join('#');
}

function derivePreidTTContextFromTT(tTFull) {
  if (typeof tTFull !== 'string' || !tTFull) {
    throw new Error('missing tTFull');
  }
  const values = tTFull.split('#');
  if (values.length !== PREID_TT_LENGTH) {
    throw new Error(`unexpected PREID.tT field count: ${values.length}`);
  }
  return {
    osFull: values[5] || '',
    browserName: values[6] || '',
    browserVersion: values[7] || '',
    fontsNum: values[20] || '',
    numericSlotA: values[22] || '',
    numericSlotB: values[34] || '',
    osName: values[36] || '',
    osArch: values[37] || '',
    ttIp: values[42] || '',
    truthyFlag: values[44] || PREID_TT_DEFAULT_BOOL,
    pageUrl: values[53] || '',
    fullUserAgent: values[64] || '',
    appName: values[67] || '',
    appStage: values[68] || PREID_TT_APP_STAGE,
    token71: values[71] || '',
    initTime: values[72] || '',
    finalTimestamp: values[74] || '',
    deviceClass: values[75] || '',
    ttCertifyId: values[77] || '',
    shortUserAgent: values[80] || '',
    ttSessionTimestamp: values[87] || '',
    ttBrands: values[110] || PREID_TT_BRANDS_DEFAULT,
  };
}

function derivePreidTTContextFromSnapshot(snapshotPreview, options = {}) {
  const appName = getPreviewValue(snapshotPreview?.appName);
  const initTime = getPreviewValue(snapshotPreview?.initTime);
  const deviceConfig = getPreviewValue(snapshotPreview?.deviceConfig) || {};
  const preCollectData = getPreviewValue(snapshotPreview?.preCollectData) || {};
  const deviceData = getPreviewValue(snapshotPreview?.deviceData) || {};
  const values = Object.values(deviceData);
  const valueEntries = Object.entries(deviceData);

  const fullUserAgent = values.find((value) => isNonEmptyString(value) && /^Mozilla\/5\.0 /.test(value));
  const shortUserAgent = values.find((value) => isNonEmptyString(value) && /^5\.0 /.test(value));
  const pageUrl = values.find((value) => isNonEmptyString(value) && /^https:\/\/chat\.z\.ai\/?$/.test(value));
  const certifyId = values.find((value) => isNonEmptyString(value) && /^probe-certify-id-/.test(value));
  const browserName = values.find((value) => value === 'Chrome') || options.browserName || 'Chrome';
  const browserVersion = values.find((value) => isNonEmptyString(value) && /^\d+\.\d+\.\d+\.\d+$/.test(value)) ||
    options.browserVersion;
  const osName = values.find((value) => value === 'Linux') || options.osName || 'Linux';
  const osArch = values.find((value) => value === 'x86_64') || options.osArch || 'x86_64';
  const osFull = values.find((value) => value === `${osName} ${osArch}`) || options.osFull || `${osName} ${osArch}`;
  const deviceClass = values.find((value) => value === 'desktop') || options.deviceClass || 'desktop';
  const brandsValue = values.find((value) => Array.isArray(value) && value.join(',') === 'Chromium,Google Chrome');
  const brands = stringifyBrands(brandsValue || options.brands || PREID_TT_BRANDS_DEFAULT);
  const fontsNum = preCollectData.fontsNum ?? options.fontsNum ?? 264;
  const ip = deviceConfig.ip || options.ip;
  const sessionTimestamp = String(deviceConfig.timestamp || options.sessionTimestamp || '');

  const initTimeIndex = valueEntries.findIndex(([, value]) => String(value) === String(initTime));
  const token71 = initTimeIndex > 0
    ? valueEntries
      .slice(0, initTimeIndex)
      .reverse()
      .map(([, value]) => value)
      .find((value) => isNonEmptyString(value) && /^[A-Za-z0-9]{32,64}$/.test(value) && !/^[a-f0-9]{32,64}$/i.test(value))
    : null;

  if (!appName || !initTime || !fullUserAgent || !shortUserAgent || !pageUrl || !certifyId || !browserVersion || !ip || !token71) {
    throw new Error('unable to derive PREID.tT context from snapshot');
  }

  return {
    appName,
    initTime: String(initTime),
    fontsNum,
    browserName,
    browserVersion,
    osName,
    osArch,
    osFull,
    ip: String(ip),
    pageUrl,
    fullUserAgent,
    shortUserAgent,
    token71,
    sessionTimestamp,
    deviceClass,
    certifyId,
    brands,
    finalTimestamp: options.finalTimestamp,
  };
}

function buildPreidTTFromSnapshot(snapshotPreview, options = {}) {
  const context = derivePreidTTContextFromSnapshot(snapshotPreview, options);
  return buildPreidTTFromContext(context, options);
}

if (require.main === module) {
  const sample = process.argv[2];
  if (!sample) {
    console.error('usage: aliyun_preid_tt_local.js <snapshot-preview-json>');
    process.exit(1);
  }
  try {
    const preview = JSON.parse(sample);
    const tT = buildPreidTTFromSnapshot(preview);
    console.log(JSON.stringify({ tT, length: tT.length }, null, 2));
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exit(1);
  }
} else {
  module.exports = {
    PREID_TT_PREFIX,
    PREID_TT_LENGTH,
    PREID_TT_APP_STAGE,
    PREID_TT_DEFAULT_BOOL,
    PREID_TT_BRANDS_DEFAULT,
    PREID_TT_FINAL_TIMESTAMP_RULE,
    stringifyBrands,
    computePreidTTFinalTimestamp,
    buildPreidTTFromContext,
    derivePreidTTContextFromTT,
    derivePreidTTContextFromSnapshot,
    buildPreidTTFromSnapshot,
  };
}
