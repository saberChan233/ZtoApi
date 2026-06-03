#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const {
  splitPreidH,
  PREID_H_STATIC_PREFIX_BASE64,
  PREID_H_STATIC_PREFIX_BYTES,
} = require('./aliyun_preid_h_local');
const fs = require('fs');

function preview(value, limit = 200) {
  return typeof value === 'string' ? value.slice(0, limit) : value;
}

function scorePrefixBytes(buf, prefix) {
  if (!Buffer.isBuffer(buf) || !Buffer.isBuffer(prefix)) return 0;
  const size = Math.min(buf.length, prefix.length);
  let i = 0;
  while (i < size && buf[i] === prefix[i]) i += 1;
  return i;
}

function toBufFromBase64(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

function toBufFromHex(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  try {
    return Buffer.from(value, 'hex');
  } catch {
    return null;
  }
}

function summarizeCandidate(bucket, row, prefixBuf) {
  const variants = [
    ['outputBase64Preview', toBufFromBase64(row?.outputBase64Preview)],
    ['outputBase64String', toBufFromBase64(row?.outputBase64String)],
    ['outputWordArrayBase64', toBufFromBase64(row?.outputWordArrayBase64)],
    ['outputDefaultString', toBufFromBase64(row?.outputDefaultString)],
    ['outputPreview', toBufFromBase64(row?.outputPreview)],
    ['outputHexPreview', toBufFromHex(row?.outputHexPreview)],
    ['outputWordArrayHexPreview', toBufFromHex(row?.outputWordArrayHexPreview)],
    ['outputHexString', toBufFromHex(row?.outputHexString)],
    ['outputHexPreview', toBufFromHex(row?.outputHexPreview)],
    ['leftBase64Preview', toBufFromBase64(row?.leftBase64Preview)],
    ['rightBase64Preview', toBufFromBase64(row?.rightBase64Preview)],
    ['outputHexPreview', toBufFromHex(row?.outputHexPreview)],
    ['leftHexPreview', toBufFromHex(row?.leftHexPreview)],
    ['rightHexPreview', toBufFromHex(row?.rightHexPreview)],
    ['inputPreview', toBufFromBase64(row?.inputPreview)],
    ['inputPreviewHex', toBufFromHex(row?.inputPreview)],
  ];
  const matched = variants
    .filter(([, buf]) => Buffer.isBuffer(buf))
    .map(([field, buf]) => ({
      field,
      bytes: buf.length,
      sharedPrefixBytes: scorePrefixBytes(buf, prefixBuf),
      exactPrefix272: buf.length === prefixBuf.length && buf.equals(prefixBuf),
      outputStartsWithPrefix272: buf.length >= prefixBuf.length && buf.subarray(0, prefixBuf.length).equals(prefixBuf),
      prefixStartsWithOutput: buf.length < prefixBuf.length && prefixBuf.subarray(0, buf.length).equals(buf),
    }))
    .sort((a, b) =>
      (b.exactPrefix272 ? 1 : 0) - (a.exactPrefix272 ? 1 : 0) ||
      (b.outputStartsWithPrefix272 ? 1 : 0) - (a.outputStartsWithPrefix272 ? 1 : 0) ||
      (b.sharedPrefixBytes || 0) - (a.sharedPrefixBytes || 0)
    )[0] || null;
  if (!matched) return null;
  return {
    bucket,
    field: matched.field,
    bytes: matched.bytes,
    sharedPrefixBytes: matched.sharedPrefixBytes,
    exactPrefix272: matched.exactPrefix272,
    outputStartsWithPrefix272: matched.outputStartsWithPrefix272,
    prefixStartsWithOutput: matched.prefixStartsWithOutput,
    leftBytes: row?.leftBytes ?? null,
    rightBytes: row?.rightBytes ?? null,
    outputBytes: row?.outputBytes ?? row?.outputWordArrayBytes ?? row?.outputDefaultDecodedBytes ?? null,
    inputLength: row?.inputLength ?? null,
    encoder: row?.encoder ?? null,
    stage: row?.stage ?? null,
    outputPreview: preview(
      row?.outputBase64Preview ??
      row?.outputBase64String ??
      row?.outputWordArrayBase64 ??
      row?.outputDefaultString ??
      row?.outputPreview ??
      row?.inputPreview ??
      null,
      200,
    ),
    stackTop: typeof row?.stack === 'string' ? row.stack.split('\n').slice(0, 6) : null,
  };
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const join = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
  if (!join?.namedParts?.H) {
    throw new Error('missing runtime H');
  }
  const prefixBuf = Buffer.from(PREID_H_STATIC_PREFIX_BASE64, 'base64');
  const split = splitPreidH(join.namedParts.H);

  const pools = [
    ['wordArrayConcatLogs', out.wordArrayConcatLogs || []],
    ['base64ParseLogs', out.base64ParseLogs || []],
    ['hexParseLogs', out.hexParseLogs || []],
    ['base64StringifyLogs', out.base64StringifyLogs || []],
    ['wordArrayToStringLogs', out.wordArrayToStringLogs || []],
    ['aesEncryptToStringLogs', out.aesEncryptToStringLogs || []],
    ['feilinRsLogs', out.feilinRsLogs || []],
    ['peTsReturnLogs', out.peTsReturnLogs || []],
    ['peTs74ChainLogs', out.peTs74ChainLogs || []],
    ['peTs74ReturnInlineLogs', out.peTs74ReturnInlineLogs || []],
    ['peTy2Calls', out.peTy2Calls || []],
    ['preidExprLogs', out.preidExprLogs || []],
  ];

  const topMatches = pools
    .flatMap(([bucket, rows]) => rows.map((row) => summarizeCandidate(bucket, row, prefixBuf)).filter(Boolean))
    .sort((a, b) =>
      (b.exactPrefix272 ? 1 : 0) - (a.exactPrefix272 ? 1 : 0) ||
      (b.outputStartsWithPrefix272 ? 1 : 0) - (a.outputStartsWithPrefix272 ? 1 : 0) ||
      (b.sharedPrefixBytes || 0) - (a.sharedPrefixBytes || 0) ||
      (b.bytes || 0) - (a.bytes || 0)
    );

  const concat272 = (out.wordArrayConcatLogs || []).filter((row) => row?.outputBytes === 272 || row?.leftBytes === 272 || row?.rightBytes === 272);
  const concat544 = (out.wordArrayConcatLogs || []).filter((row) => row?.outputBytes === 544 || (row?.leftBytes === 272 && row?.rightBytes === 272));
  const rawBundle = fs.readFileSync('/tmp/aliyun-pe.js', 'utf8');
  const hBuilderNeedle = 'H=function(t,n){';
  const hBuilderEnd = '}(nU,tT),c^=276';
  const hBuilderStart = rawBundle.indexOf(hBuilderNeedle);
  const hBuilderStop = hBuilderStart >= 0 ? rawBundle.indexOf(hBuilderEnd, hBuilderStart) : -1;
  const hBuilderSnippet = hBuilderStart >= 0 && hBuilderStop >= 0
    ? rawBundle.slice(Math.max(0, hBuilderStart - 200), hBuilderStop + hBuilderEnd.length)
    : null;

  console.log(JSON.stringify({
    runtime: {
      hBytes: split.buffer.length,
      prefixBytes: split.prefix.length,
      tailBytes: split.tail.length,
      prefixMatchesStaticConstant: split.prefix.equals(prefixBuf),
      staticPrefixBytes: PREID_H_STATIC_PREFIX_BYTES,
    },
    topMatches: topMatches.slice(0, 40),
    concat272: concat272.slice(0, 20).map((row) => ({
      leftBytes: row.leftBytes,
      rightBytes: row.rightBytes,
      outputBytes: row.outputBytes,
      leftBase64Preview: preview(row.leftBase64Preview, 120),
      rightBase64Preview: preview(row.rightBase64Preview, 120),
      outputBase64Preview: preview(row.outputBase64Preview, 120),
      sharedPrefixBytes: scorePrefixBytes(toBufFromBase64(row.outputBase64Preview), prefixBuf),
      stackTop: typeof row.stack === 'string' ? row.stack.split('\n').slice(0, 6) : null,
    })),
    concat544: concat544.slice(0, 20).map((row) => ({
      leftBytes: row.leftBytes,
      rightBytes: row.rightBytes,
      outputBytes: row.outputBytes,
      outputStartsWithPrefix272: (() => {
        const buf = toBufFromBase64(row.outputBase64Preview);
        return Buffer.isBuffer(buf) && buf.length >= prefixBuf.length && buf.subarray(0, prefixBuf.length).equals(prefixBuf);
      })(),
      leftSharedPrefixBytes: scorePrefixBytes(toBufFromBase64(row.leftBase64Preview), prefixBuf),
      rightSharedPrefixBytes: scorePrefixBytes(toBufFromBase64(row.rightBase64Preview), prefixBuf),
      stackTop: typeof row.stack === 'string' ? row.stack.split('\n').slice(0, 6) : null,
    })),
    builderEvidence: {
      ts74EntryCount: (out.peTs74Logs || []).length,
      ts75EntryCount: (out.peTs75Logs || []).length,
      tsReturnCount: (out.peTsReturnLogs || []).length,
      ts74ChainCount: (out.peTs74ChainLogs || []).length,
      ts74InlineReturnCount: (out.peTs74ReturnInlineLogs || []).length,
      stringDecoderLogCount: (out.stringDecoderLogs || []).length,
      hBuilderFoundInRawBundle: Boolean(hBuilderSnippet),
      hBuilderSnippet,
    },
    conclusionHints: {
      hasDirect272PrefixProducer: topMatches.some((row) => row.exactPrefix272),
      has544ConcatStartingWithPrefix: concat544.some((row) => {
        const buf = toBufFromBase64(row.outputBase64Preview);
        return Buffer.isBuffer(buf) && buf.length >= prefixBuf.length && buf.subarray(0, prefixBuf.length).equals(prefixBuf);
      }),
      likelyPathsToInspectFirst: [
        'raw bundle H builder wrapper that dispatches into ts(...,74)',
        'peTsReturnLogs for direct ts74/ts75 return payloads or WordArray snapshots',
        'wordArrayConcatLogs for 272+272=>544 assembly',
        'base64ParseLogs / hexParseLogs for a direct static blob parse',
        'preidExprLogs stage H + peTs74Logs around ts(74,nU,tT)',
      ],
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
