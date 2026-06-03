#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { computePreidNg, buildPreidNgSeed } = require('./aliyun_preid_local');
const {
  splitPreidH,
  decryptPreidHTail,
  derivePreidHTailKeyHexFromNO,
  locatePreidHTailPlaintextInTT,
  buildPreidHFromParts,
} = require('./aliyun_preid_h_local');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const join = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
  const expr = out.preidExprLogs || [];
  const summarizeExpr = expr.map((item, index) => ({
    index,
    stage: item?.stage || null,
    valueType: item?.valueType || null,
    valueLength: item?.valueLength ?? item?.valuePreview?.sigBytes ?? null,
    valuePreview: typeof item?.valuePreview === 'string'
      ? item.valuePreview.slice(0, 240)
      : item?.valuePreview || null,
    stackTop: typeof item?.stack === 'string'
      ? item.stack.split('\n').slice(0, 6)
      : null,
  }));
  const md5Check = join?.namedParts?.nO && join?.namedParts?.H
    ? (() => {
      const expected = computePreidNg({ nO: join.namedParts.nO, H: join.namedParts.H });
      const seed = buildPreidNgSeed({ nO: join.namedParts.nO, H: join.namedParts.H });
      return {
        expected,
        actual: join?.namedParts?.ng || null,
        match: expected === join?.namedParts?.ng,
        seedPreview: seed.slice(0, 240),
        seedLength: seed.length,
      };
    })()
    : null;
  const hTailCheck = join?.namedParts?.nO && join?.namedParts?.H
    ? (() => {
      const split = splitPreidH(join.namedParts.H);
      const decrypted = decryptPreidHTail(join.namedParts.H, join.namedParts.nO);
      const hReal = out.preidHRealLogs?.[0] || null;
      const tTFull = typeof hReal?.tTFull === 'string'
        ? hReal.tTFull
        : [hReal?.tTPreview, hReal?.tTTail].filter((x) => typeof x === 'string' && x).join('<<<TRUNCATED>>>');
      const location = typeof hReal?.tTFull === 'string'
        ? locatePreidHTailPlaintextInTT(hReal.tTFull, decrypted.plaintextUtf8)
        : {
          found: false,
          start: typeof hReal?.tTPreview === 'string' ? hReal.tTPreview.indexOf(decrypted.plaintextUtf8.slice(0, 60)) : -1,
          end: -1,
          length: decrypted.plaintextUtf8.length,
        };
      const rebuilt = buildPreidHFromParts(split.prefix, decrypted.plaintextUtf8, join.namedParts.nO, decrypted.iv);
      return {
        keyHexUtf8: derivePreidHTailKeyHexFromNO(join.namedParts.nO),
        prefixBytes: split.prefix.length,
        tailBytes: split.tail.length,
        ivHex: decrypted.iv.toString('hex'),
        ciphertextBytes: decrypted.ciphertext.length,
        plaintextBytes: decrypted.plaintext.length,
        plaintextPreview: decrypted.plaintextUtf8.slice(0, 240),
        plaintextTail: decrypted.plaintextUtf8.slice(-120),
        tTLength: hReal?.tTLength ?? null,
        tTPreviewHead: hReal?.tTPreview || null,
        tTPreviewTail: hReal?.tTTail || null,
        tTFullLength: typeof hReal?.tTFull === 'string' ? hReal.tTFull.length : null,
        tTFullPreview: typeof tTFull === 'string' ? tTFull.slice(0, 240) : null,
        tTPlaintextLocation: location,
        rebuiltMatchesOriginal: rebuilt.H === join.namedParts.H,
      };
    })()
    : null;
  console.log(JSON.stringify({
    joinContext: join?.joinContext || null,
    namedParts: join?.namedParts || null,
    md5Check,
    hTailCheck,
    exprSummary: summarizeExpr,
    peTyLogs: out.peTyLogs || [],
    peTyReturns: out.peTyReturns || [],
    preidVLogs: out.preidVLogs || [],
    preidNgLogs: out.preidNgLogs || [],
    preidHRealLogs: out.preidHRealLogs || [],
    peTdCalls: out.peTdCalls || [],
    peTy2Calls: out.peTy2Calls || [],
    peNcCalls: out.peNcCalls || [],
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
