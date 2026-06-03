#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const {
  transformRuntimeSeedToRaw,
  encodeRuntimeSeedToFinalData,
} = require('./aliyun_verify_data_vm_replay');

async function main() {
  const want = Number(process.argv[2] || 1);
  const rows = [];
  let tries = 0;
  while (rows.length < want && tries < want * 6) {
    tries += 1;
    const out = await solveCaptcha({
      files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
      loaderPath: '/tmp/AliyunCaptcha.js',
    });
    const frame = out.verifyDataRuntimeFrame || {};
    if (!frame.runtimeSeedBase64Like || !frame.initialPermTable || !frame.rawBinaryFull || !frame.finalDataBase64) continue;
    const raw = transformRuntimeSeedToRaw(frame.runtimeSeedBase64Like, frame.initialPermTable, frame.initialVmState || {});
    const finalData = Buffer.from(raw, 'latin1').toString('base64');
    rows.push({
      keyHex: frame.keyHex || null,
      initialVmState: frame.initialVmState || null,
      rawMatch: raw === frame.rawBinaryFull,
      finalMatch: finalData === frame.finalDataBase64,
      rawLength: raw.length,
      runtimeRawLength: frame.rawBinaryLength || null,
      finalLength: finalData.length,
      runtimeFinalLength: frame.finalDataLength || null,
      rawHeadHex: Buffer.from(raw.slice(0, 32), 'latin1').toString('hex'),
      runtimeRawHeadHex: Buffer.from(frame.rawBinaryFull.slice(0, 32), 'latin1').toString('hex'),
    });
  }
  console.log(JSON.stringify({ tries, count: rows.length, rows }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
} else {
  module.exports = {
    transformRuntimeSeedToRaw,
    encodeRuntimeSeedToFinalData,
  };
}
