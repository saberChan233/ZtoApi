#!/usr/bin/env node

const { computePreidNg, buildPreidPlain } = require('./aliyun_preid_local');
const {
  getDefaultPreidHPrefixBuffer,
  rebuildPreidHFromTT,
  createRandomPreidHTailIv,
} = require('./aliyun_preid_h_local');
const {
  buildPreidTTFromSnapshot,
  derivePreidTTContextFromTT,
} = require('./aliyun_preid_tt_local');

function computePreidHFromSnapshot(snapshotPreview, options = {}) {
  const nO = String(options.nO || snapshotPreview?.deviceConfig?.value?.sessionId || snapshotPreview?.deviceConfig?.sessionId || '');
  if (!nO) {
    throw new Error('missing nO/sessionId');
  }
  const tT = buildPreidTTFromSnapshot(snapshotPreview, options);
  const prefix = options.prefix || getDefaultPreidHPrefixBuffer();
  const iv = options.iv || createRandomPreidHTailIv();
  const rebuilt = rebuildPreidHFromTT(prefix, tT, nO, iv);
  return {
    nO,
    tT,
    H: rebuilt.H,
    prefix: rebuilt.prefix,
    iv: rebuilt.iv,
    ciphertext: rebuilt.ciphertext,
  };
}

function computePreidFromSnapshot(snapshotPreview, options = {}) {
  const hResult = computePreidHFromSnapshot(snapshotPreview, options);
  const ng = computePreidNg({ nO: hResult.nO, H: hResult.H }, options);
  return {
    ...hResult,
    ng,
    preidPlain: buildPreidPlain({ nO: hResult.nO, H: hResult.H }, { ...options, ng }),
  };
}

function computePreidFromTT(tT, options = {}) {
  const nO = String(options.nO || '');
  if (!nO) {
    throw new Error('missing nO/sessionId');
  }
  if (typeof tT !== 'string' || !tT) {
    throw new Error('missing PREID.tT string');
  }
  const prefix = options.prefix || getDefaultPreidHPrefixBuffer();
  const iv = options.iv || createRandomPreidHTailIv();
  const rebuilt = rebuildPreidHFromTT(prefix, tT, nO, iv);
  const ng = computePreidNg({ nO, H: rebuilt.H }, options);
  return {
    nO,
    tT,
    H: rebuilt.H,
    prefix: rebuilt.prefix,
    iv: rebuilt.iv,
    ciphertext: rebuilt.ciphertext,
    ng,
    preidPlain: buildPreidPlain({ nO, H: rebuilt.H }, { ...options, ng }),
    context: derivePreidTTContextFromTT(tT),
  };
}

if (require.main === module) {
  try {
    const preview = JSON.parse(process.argv[2] || '');
    const ivHex = process.argv[3] || '';
    const nO = process.argv[4] || '';
    const finalTimestamp = process.argv[5] || '';
    const out = computePreidFromSnapshot(preview, {
      ...(ivHex ? { iv: Buffer.from(ivHex, 'hex') } : {}),
      nO,
      finalTimestamp,
    });
    console.log(JSON.stringify({
      nO: out.nO,
      tT: out.tT,
      H: out.H,
      ng: out.ng,
      ivHex: out.iv.toString('hex'),
      preidPlain: out.preidPlain,
    }, null, 2));
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exit(1);
  }
} else {
  module.exports = {
    computePreidHFromSnapshot,
    computePreidFromSnapshot,
    computePreidFromTT,
  };
}
