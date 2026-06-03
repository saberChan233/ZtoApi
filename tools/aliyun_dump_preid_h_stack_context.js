#!/usr/bin/env node

const fs = require('fs');
const { patchAliyunCaptchaSource } = require('./probe_feilin_runtime');

function buildContext(source, offset, radius = 220) {
  const start = Math.max(0, offset - radius);
  const end = Math.min(source.length, offset + radius);
  return {
    offset,
    start,
    end,
    snippet: source.slice(start, end),
  };
}

function main() {
  const file = process.argv[2] || '/tmp/aliyun-pe.js';
  const offsets = process.argv.slice(3).map((x) => Number(x)).filter((x) => Number.isFinite(x));
  const targetOffsets = offsets.length ? offsets : [286612, 290635, 331982, 341952];
  const raw = fs.readFileSync(file, 'utf8');
  const patched = patchAliyunCaptchaSource(raw, {});
  const dateNowHits = [];
  let scanIndex = 0;
  while (dateNowHits.length < 12) {
    const next = patched.indexOf('Date.now()', scanIndex);
    if (next < 0) break;
    dateNowHits.push(buildContext(patched, next, 160));
    scanIndex = next + 'Date.now()'.length;
  }
  console.log(JSON.stringify({
    file,
    rawLength: raw.length,
    patchedLength: patched.length,
    stackContexts: targetOffsets.map((offset) => buildContext(patched, offset)),
    firstDateNowHits: dateNowHits,
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
