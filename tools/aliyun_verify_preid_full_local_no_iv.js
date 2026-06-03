#!/usr/bin/env node

const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const {
  splitPreidH,
  PREID_H_STATIC_PREFIX_BASE64,
  decryptPreidHTail,
  PREID_H_TT_TAIL_OFFSET,
} = require('./aliyun_preid_h_local');
const { computePreidFromSnapshot } = require('./aliyun_preid_full_local');
const { PREID_TT_FINAL_TIMESTAMP_RULE } = require('./aliyun_preid_tt_local');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const join = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
  const hReal = (out.preidHRealLogs || [])[0] || null;
  if (!join?.namedParts?.nO || !hReal?.tTFull || !out.feilinReSnapshot?.preview) {
    throw new Error('missing runtime PREID context');
  }
  const finalTimestamp = hReal.tTFull.split('#')[74];
  const rebuilt = computePreidFromSnapshot(out.feilinReSnapshot.preview, {
    nO: join.namedParts.nO,
    finalTimestamp,
  });
  const split = splitPreidH(rebuilt.H);
  const tailDecoded = decryptPreidHTail(rebuilt.H, rebuilt.nO);
  console.log(JSON.stringify({
    rebuilt: {
      H: rebuilt.H,
      ng: rebuilt.ng,
      tT: rebuilt.tT,
      ivHex: rebuilt.iv.toString('hex'),
      preidPlain: rebuilt.preidPlain,
    },
    checks: {
      generatedWithoutRuntimeIv: true,
      hBytes: split.buffer.length,
      prefixBytes: split.prefix.length,
      tailBytes: split.tail.length,
      prefixMatchesDefaultStatic: split.prefix.toString('base64') === PREID_H_STATIC_PREFIX_BASE64,
      tailPlaintextMatchesTTTail: tailDecoded.plaintextUtf8 === rebuilt.tT.slice(PREID_H_TT_TAIL_OFFSET),
      finalTimestampRule: PREID_TT_FINAL_TIMESTAMP_RULE,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(String(error && error.stack || error));
  process.exit(1);
});
