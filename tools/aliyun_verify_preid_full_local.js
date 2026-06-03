#!/usr/bin/env node

const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { splitPreidH, PREID_H_STATIC_PREFIX_BASE64 } = require('./aliyun_preid_h_local');
const { computePreidFromSnapshot } = require('./aliyun_preid_full_local');
const { PREID_TT_FINAL_TIMESTAMP_RULE } = require('./aliyun_preid_tt_local');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const join = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
  const hReal = (out.preidHRealLogs || [])[0] || null;
  if (!join?.namedParts?.H || !join?.namedParts?.nO || !hReal?.tTFull) {
    throw new Error('missing runtime PREID/H context');
  }
  const split = splitPreidH(join.namedParts.H);
  const finalTimestamp = hReal.tTFull.split('#')[74];
  const matchingDateNow = (out.dateNowLogs || []).find((row) =>
    row?.value != null &&
    String(row.value) === String(finalTimestamp) &&
    typeof row.stack === 'string' &&
    row.stack.includes('/tmp/aliyun-pe.js')
  ) || null;
  const rebuilt = computePreidFromSnapshot(out.feilinReSnapshot?.preview, {
    iv: split.tail.subarray(0, 16),
    nO: join.namedParts.nO,
    finalTimestamp,
  });
  console.log(JSON.stringify({
    runtime: {
      nO: join.namedParts.nO,
      H: join.namedParts.H,
      ng: join.namedParts.ng,
      tT: hReal.tTFull,
    },
    rebuilt: {
      H: rebuilt.H,
      ng: rebuilt.ng,
      tT: rebuilt.tT,
      preidPlain: rebuilt.preidPlain,
    },
    checks: {
      tTMatch: rebuilt.tT === hReal.tTFull,
      hMatch: rebuilt.H === join.namedParts.H,
      ngMatch: rebuilt.ng === join.namedParts.ng,
      prefixMatchesDefaultStatic: split.prefix.toString('base64') === PREID_H_STATIC_PREFIX_BASE64,
      finalTimestampMatchesAliyunPeDateNow: Boolean(matchingDateNow),
      finalTimestampRule: PREID_TT_FINAL_TIMESTAMP_RULE,
    },
    finalTimestampEvidence: matchingDateNow ? {
      value: matchingDateNow.value,
      stackTop: matchingDateNow.stack.split('\n').slice(0, 8),
    } : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(String(error && error.stack || error));
  process.exit(1);
});
