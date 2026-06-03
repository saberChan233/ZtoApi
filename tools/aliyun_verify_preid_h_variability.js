#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sharedPrefixBytes(left, right) {
  const size = Math.min(left.length, right.length);
  let i = 0;
  while (i < size && left[i] === right[i]) i += 1;
  return i;
}

function sharedSuffixBytes(left, right) {
  const size = Math.min(left.length, right.length);
  let i = 0;
  while (i < size && left[left.length - 1 - i] === right[right.length - 1 - i]) i += 1;
  return i;
}

function diffBlocks(base, next, blockSize = 16) {
  const blockCount = Math.ceil(Math.min(base.length, next.length) / blockSize);
  const rows = [];
  for (let i = 0; i < blockCount; i += 1) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, Math.min(base.length, next.length));
    let diff = 0;
    for (let p = start; p < end; p += 1) {
      if (base[p] !== next[p]) diff += 1;
    }
    rows.push({
      blockIndex: i,
      offset: start,
      size: end - start,
      diffBytes: diff,
      identical: diff === 0,
      baseHex: base.subarray(start, end).toString('hex'),
      nextHex: next.subarray(start, end).toString('hex'),
    });
  }
  return rows;
}

async function captureOnce() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const join = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
  const H = join?.namedParts?.H || '';
  const nO = join?.namedParts?.nO || '';
  const ng = join?.namedParts?.ng || '';
  const hBuffer = H ? Buffer.from(H, 'base64') : Buffer.alloc(0);
  return {
    H,
    HLength: H.length,
    HBytes: hBuffer.length,
    HHead: H.slice(0, 120),
    HTail: H.slice(-120),
    HBuffer: hBuffer,
    nO,
    ng,
  };
}

async function main() {
  const runs = toInt(getArg('--runs', '3'), 3);
  const blockSize = toInt(getArg('--block-size', '16'), 16);
  const captured = [];
  for (let i = 0; i < runs; i += 1) {
    captured.push(await captureOnce());
  }

  const baseline = captured[0];
  const comparisons = captured.slice(1).map((row, index) => {
    const sharedPrefix = sharedPrefixBytes(baseline.HBuffer, row.HBuffer);
    const sharedSuffix = sharedSuffixBytes(baseline.HBuffer, row.HBuffer);
    const blocks = diffBlocks(baseline.HBuffer, row.HBuffer, blockSize);
    return {
      run: index + 1,
      nO: row.nO,
      ng: row.ng,
      HLength: row.HLength,
      HBytes: row.HBytes,
      sharedPrefixBytes: sharedPrefix,
      sharedSuffixBytes: sharedSuffix,
      sharedPrefixBlocks: sharedPrefix / blockSize,
      sharedSuffixBlocks: sharedSuffix / blockSize,
      identicalBlocks: blocks.filter((item) => item.identical).map((item) => item.blockIndex),
      changedBlocks: blocks.filter((item) => !item.identical).map((item) => ({
        blockIndex: item.blockIndex,
        offset: item.offset,
        diffBytes: item.diffBytes,
      })),
      firstChangedBlock: blocks.find((item) => !item.identical) || null,
      lastChangedBlock: [...blocks].reverse().find((item) => !item.identical) || null,
    };
  });

  console.log(JSON.stringify({
    baseline: {
      nO: baseline.nO,
      ng: baseline.ng,
      HLength: baseline.HLength,
      HBytes: baseline.HBytes,
      blockSize,
      totalBlocks: Math.ceil(baseline.HBytes / blockSize),
      HHead: baseline.HHead,
      HTail: baseline.HTail,
    },
    comparisons,
    summary: {
      observation: comparisons.length
        ? 'compare baseline against later runs to locate stable vs variable encrypted blocks'
        : 'only one run captured',
      allSharedPrefixBytes: comparisons.map((item) => item.sharedPrefixBytes),
      allSharedPrefixBlocks: comparisons.map((item) => item.sharedPrefixBlocks),
      allSharedSuffixBytes: comparisons.map((item) => item.sharedSuffixBytes),
      allChangedBlockStarts: comparisons.map((item) =>
        item.changedBlocks.length ? item.changedBlocks[0].blockIndex : null
      ),
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
