#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

async function main() {
  const want = Number(process.argv[2] || 4);
  const rows = [];
  let tries = 0;
  while (rows.length < want && tries < want * 6) {
    tries += 1;
    const out = await solveCaptcha({
      files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
      loaderPath: '/tmp/AliyunCaptcha.js',
    });
    const frame = out.verifyDataRuntimeFrame || {};
    const finalData = frame.finalDataBase64;
    const rawBinary = frame.rawBinaryFull;
    if (!finalData || !rawBinary) continue;
    rows.push({
      keyHex: frame.keyHex || null,
      initialPermTable: frame.initialPermTable || null,
      permTable: frame.permTable || null,
      seedPrefix: frame.seedCallsite?.nxPreview?.slice(0, 32) || null,
      seedJson: frame.seedCallsite?.nxPreview?.slice(32) || null,
      seedBase64Like: frame.seedBase64Like || null,
      runtimeSeedBase64Like: frame.runtimeSeedBase64Like || null,
      rawBinaryLatin1: rawBinary,
      rawBinaryHex: Buffer.from(rawBinary, 'latin1').toString('hex'),
      finalDataBase64: finalData,
      finalDataDecodedHex: Buffer.from(finalData, 'base64').toString('hex'),
    });
  }
  console.log(JSON.stringify({ tries, count: rows.length, rows }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
