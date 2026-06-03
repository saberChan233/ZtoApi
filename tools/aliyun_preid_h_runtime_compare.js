#!/usr/bin/env node
const fs = require('fs');
const { splitPreidH } = require('./aliyun_preid_h_local');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function commonPrefixLen(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffixLen(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

function parseHarThird(harPath, verifyIndex) {
  const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
  const entry = har?.log?.entries?.[verifyIndex];
  if (!entry) throw new Error(`missing HAR entry ${verifyIndex}`);
  const form = Object.fromEntries(new URLSearchParams(entry.request?.postData?.text || '').entries());
  const payload = JSON.parse(form.CaptchaVerifyParam || '{}');
  const plain = Buffer.from(payload.deviceToken || '', 'base64').toString('utf8');
  return (plain.split('#')[2] || null);
}

function parseSolverThird(jsonPath, sourceHint = null) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (sourceHint) {
    const hit = (data?.thirdSegmentCandidates?.candidates || []).find((item) => item?.source === sourceHint);
    if (typeof hit?.fullValue === 'string' && hit.fullValue) return hit.fullValue;
    if (hit?.preview) {
      const full = (data?.thirdSegmentCandidatesFull || {})[sourceHint];
      if (typeof full === 'string' && full) return full;
    }
  }
  const verifyPreview = data?.verifyParamInspection?.deviceTokenPreview;
  if (typeof verifyPreview === 'string' && verifyPreview) {
    return verifyPreview.split('#')[2] || null;
  }
  const first = data?.thirdSegmentCandidates?.candidates?.[0];
  if (first?.fullValue && typeof first.fullValue === 'string') return first.fullValue;
  throw new Error('missing solver third segment; provide solver JSON with full third value');
}

function summarize(label, value) {
  const split = splitPreidH(value);
  return {
    label,
    length: value.length,
    totalBytes: split.buffer.length,
    prefixBytes: split.prefix.length,
    tailBytes: split.tail.length,
    prefixPreview: split.prefix.toString('base64').slice(0, 160),
    tailPreview: split.tail.toString('base64').slice(0, 160),
  };
}

function compare(left, right) {
  const a = splitPreidH(left);
  const b = splitPreidH(right);
  const prefixCommon = commonPrefixLen(a.prefix, b.prefix);
  const tailPrefixCommon = commonPrefixLen(a.tail, b.tail);
  const wholeSuffixCommon = commonSuffixLen(a.buffer, b.buffer);
  const firstMismatchAt = (() => {
    const limit = Math.min(a.buffer.length, b.buffer.length);
    for (let i = 0; i < limit; i += 1) {
      if (a.buffer[i] !== b.buffer[i]) return i;
    }
    return limit;
  })();
  return {
    prefixCommonBytes: prefixCommon,
    tailPrefixCommonBytes: tailPrefixCommon,
    wholeSuffixCommonBytes: wholeSuffixCommon,
    firstMismatchByteIndex: firstMismatchAt,
    sameLength: a.buffer.length === b.buffer.length,
  };
}

function main() {
  const harPath = getArg('--har', 'glitchhunter_session_1779496468306.har');
  const verifyIndex = Number(getArg('--verify-index', '94'));
  const solverPath = getArg('--solver');
  if (!solverPath) {
    throw new Error('missing --solver <solver-output.json>');
  }
  const browserThird = parseHarThird(harPath, verifyIndex);
  const solverThird = parseSolverThird(solverPath, getArg('--source'));
  console.log(JSON.stringify({
    browser: summarize(`browser:${harPath}#${verifyIndex}`, browserThird),
    solver: summarize(`solver:${solverPath}`, solverThird),
    compare: compare(browserThird, solverThird),
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exit(1);
  }
}
