#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function safeBase64Bytes(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64').length;
  } catch {
    return null;
  }
}

function preview(value, limit = 160) {
  if (typeof value !== 'string') return value;
  return value.slice(0, limit);
}

function decodeBase64Buffer(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

function decodeHexBuffer(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  try {
    return Buffer.from(value, 'hex');
  } catch {
    return null;
  }
}

function sharedPrefixBytes(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right)) return 0;
  const size = Math.min(left.length, right.length);
  let i = 0;
  while (i < size && left[i] === right[i]) i += 1;
  return i;
}

function collectRsOutputCandidates(row) {
  const specs = [
    ['outputBufferBase64', 'base64'],
    ['outputCiphertextBase64', 'base64'],
    ['outputWordArrayBase64', 'base64'],
    ['outputBase64String', 'base64'],
    ['outputDefaultString', 'base64'],
    ['outputHexString', 'hex'],
  ];
  return specs.map(([key, kind]) => {
    const raw = row?.[key];
    const buf = kind === 'hex' ? decodeHexBuffer(raw) : decodeBase64Buffer(raw);
    return {
      key,
      kind,
      raw: typeof raw === 'string' ? preview(raw, 160) : null,
      bytes: Buffer.isBuffer(buf) ? buf.length : null,
      buffer: buf,
    };
  }).filter((item) => item.buffer);
}

function collectProducerCandidates(out, H, hBuffer) {
  const sources = [
    ['btoaLogs', Array.isArray(out.btoaLogs) ? out.btoaLogs : [], (row) => typeof row?.outputPreview === 'string' ? {
      bucket: 'btoaLogs',
      output: row.outputPreview,
      outputLength: row.outputLength ?? row.outputPreview.length,
      decodedBuffer: decodeBase64Buffer(row.outputPreview),
      extra: { inputLen: row.inputLen ?? null, stack: row.stack || null },
    } : null],
    ['peTyReturns', Array.isArray(out.peTyReturns) ? out.peTyReturns : [], (row) => typeof row?.outputPreview === 'string' ? {
      bucket: 'peTyReturns',
      output: row.outputPreview,
      outputLength: row.outputLength ?? row.outputPreview.length,
      decodedBuffer: decodeBase64Buffer(row.outputPreview),
      extra: { outputHexPreview: row.outputHexPreview || null, stack: row.stack || null },
    } : null],
    ['wordArrayToStringLogs', Array.isArray(out.wordArrayToStringLogs) ? out.wordArrayToStringLogs : [], (row) => typeof row?.outputPreview === 'string' ? {
      bucket: 'wordArrayToStringLogs',
      output: row.outputPreview,
      outputLength: row.outputLength ?? row.outputPreview.length,
      decodedBuffer: row.encoder === 'Hex' ? decodeHexBuffer(row.outputPreview) : decodeBase64Buffer(row.outputPreview),
      extra: { inputBytes: row.inputBytes ?? null, encoder: row.encoder || null, stack: row.stack || null },
    } : null],
    ['base64StringifyLogs', Array.isArray(out.base64StringifyLogs) ? out.base64StringifyLogs : [], (row) => typeof row?.outputPreview === 'string' ? {
      bucket: 'base64StringifyLogs',
      output: row.outputPreview,
      outputLength: row.outputLength ?? row.outputPreview.length,
      decodedBuffer: decodeBase64Buffer(row.outputPreview),
      extra: { inputBytes: row.inputBytes ?? null, stack: row.stack || null },
    } : null],
    ['aesEncryptToStringLogs', Array.isArray(out.aesEncryptToStringLogs) ? out.aesEncryptToStringLogs : [], (row) => typeof row?.outputPreview === 'string' ? {
      bucket: 'aesEncryptToStringLogs',
      output: row.outputPreview,
      outputLength: row.outputLength ?? row.outputPreview.length,
      decodedBuffer: row.encoder === 'Hex' ? decodeHexBuffer(row.outputPreview) : decodeBase64Buffer(row.outputPreview),
      extra: {
        inputBytes: row.inputBytes ?? null,
        ciphertextBytes: row.ciphertextBytes ?? null,
        encoder: row.encoder || null,
        stack: row.stack || null,
      },
    } : null],
  ];
  return sources.flatMap(([, rows, mapRow]) => rows.map(mapRow).filter(Boolean))
    .map((row) => ({
      bucket: row.bucket,
      outputLength: row.outputLength,
      decodedBytes: Buffer.isBuffer(row.decodedBuffer) ? row.decodedBuffer.length : null,
      exactBase64Match: H ? row.output === H : false,
      sharedPrefixBytes: hBuffer && Buffer.isBuffer(row.decodedBuffer) ? sharedPrefixBytes(hBuffer, row.decodedBuffer) : 0,
      outputHead: preview(row.output, 160),
      ...row.extra,
    }))
    .sort((a, b) =>
      (b.exactBase64Match ? 1 : 0) - (a.exactBase64Match ? 1 : 0) ||
      (b.sharedPrefixBytes || 0) - (a.sharedPrefixBytes || 0) ||
      Math.abs((a.outputLength || 0) - (H ? H.length : 0)) - Math.abs((b.outputLength || 0) - (H ? H.length : 0))
    );
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });

  const joinLog = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
  const H = joinLog?.namedParts?.H || null;
  const hBytes = safeBase64Bytes(H);
  const hBuffer = decodeBase64Buffer(H);
  const rsLogs = Array.isArray(out.feilinRsLogs) ? out.feilinRsLogs : [];
  const longPlainCandidates = rsLogs
    .filter((row) => typeof row?.arg1 === 'string' && row.arg1.length >= 300)
    .map((row) => ({
      arg0: preview(row.arg0, 64),
      arg1Length: row.arg1Length || row.arg1.length,
      arg1Preview: preview(row.arg1, 240),
      arg1LooksFingerprint: typeof row.arg1 === 'string' && row.arg1.startsWith('W.10051#'),
      outputType: row.outputType || typeof row.output,
      outputLength: row.outputStringLength || row.outputLength || (typeof row.output === 'string' ? row.output.length : null),
      outputPreview: preview(row.outputString || row.output, 240),
      outputBytes: safeBase64Bytes(row.outputString || row.output),
      rsOutputCandidates: collectRsOutputCandidates(row).map((candidate) => ({
        key: candidate.key,
        kind: candidate.kind,
        raw: candidate.raw,
        bytes: candidate.bytes,
        sharedPrefixBytes: hBuffer ? sharedPrefixBytes(hBuffer, candidate.buffer) : 0,
        exactBase64Match: H ? candidate.raw === H : false,
      })),
      stack: row.stack || null,
    }));

  const bestHProducer = longPlainCandidates.find((row) => row.outputPreview === preview(H, 240)) ||
    longPlainCandidates.find((row) => row.outputLength === (H ? H.length : null)) ||
    null;
  const bestRsBufferMatch = longPlainCandidates
    .flatMap((row) => row.rsOutputCandidates.map((candidate) => ({
      arg0: row.arg0,
      arg1Length: row.arg1Length,
      arg1LooksFingerprint: row.arg1LooksFingerprint,
      arg1Preview: row.arg1Preview,
      ...candidate,
    })))
    .sort((a, b) =>
      (b.exactBase64Match ? 1 : 0) - (a.exactBase64Match ? 1 : 0) ||
      (b.sharedPrefixBytes || 0) - (a.sharedPrefixBytes || 0) ||
      (b.bytes || 0) - (a.bytes || 0)
    )[0] || null;
  const producerCandidates = collectProducerCandidates(out, H, hBuffer);

  console.log(JSON.stringify({
    H: H ? {
      length: H.length,
      decodedBytes: hBytes,
      head: H.slice(0, 160),
      tail: H.slice(-160),
      blockAligned16: hBytes != null ? hBytes % 16 === 0 : null,
    } : null,
    rsLogCount: rsLogs.length,
    bestHProducer,
    bestRsBufferMatch,
    producerCandidatesTop: producerCandidates.slice(0, 20),
    preidExprStageSummary: (out.preidExprLogs || []).reduce((acc, item) => {
      const stage = item?.stage || 'unknown';
      acc[stage] = (acc[stage] || 0) + 1;
      return acc;
    }, {}),
    preidExprLogs: (out.preidExprLogs || []).slice(0, 40),
    longPlainCandidates,
    rkAccessPreview: (out.feilinRkAccessLogs || []).slice(0, 20),
    lPreviewHints: (out.n0PartLogs || [])
      .filter((row) => row?.name === 'v' && typeof row?.lPreview === 'string')
      .map((row) => ({
        xPreview: row.xPreview,
        lPreviewLength: row.lPreview.length,
        lPreviewHead: row.lPreview.slice(0, 240),
      })),
    relations: {
      hLooksEncryptedBlockPayload: hBytes != null ? hBytes % 16 === 0 : null,
      hOutputSeenInRsLogs: !!bestHProducer,
      hLikelyFromLongFingerprintPlaintext: !!bestHProducer && !!bestHProducer.arg1LooksFingerprint,
      hBufferSeenInRsCandidates: !!bestRsBufferMatch && ((bestRsBufferMatch.sharedPrefixBytes || 0) > 0 || !!bestRsBufferMatch.exactBase64Match),
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
