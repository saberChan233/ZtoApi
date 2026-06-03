#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { extractBasePerm, extractSwapTargets } = require('./aliyun_verify_permutation_reverse');

async function main() {
  const want = Number(process.argv[2] || 6);
  const rows = [];
  let tries = 0;
  while (rows.length < want && tries < want * 4) {
    tries += 1;
    const out = await solveCaptcha({
      files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
      loaderPath: '/tmp/AliyunCaptcha.js',
    });
    const frame = out.verifyDataRuntimeFrame || null;
    if (!frame?.keyHex || !Array.isArray(out?.tVmAssignLogs)) continue;
    const keyHex = frame.keyHex;
    const basePerm = extractBasePerm(out.tVmAssignLogs, keyHex);
    const swapTargets = extractSwapTargets(out.tVmAssignLogs, keyHex);
    rows.push({
      keyHex,
      seedPrefix: out.verifyDataReverse?.seedPrefix || null,
      initialPermHead: Array.isArray(frame.initialPermTable) ? frame.initialPermTable.slice(0, 8) : null,
      basePermHead: Array.isArray(basePerm) ? basePerm.slice(0, 8) : null,
      swapTargetsHead: Array.isArray(swapTargets) ? swapTargets.slice(0, 16) : null,
      swapTargetsTail: Array.isArray(swapTargets) ? swapTargets.slice(-8) : null,
      rawBinaryLength: frame.rawBinaryLength || null,
      finalDataLength: frame.finalDataLength || null,
    });
  }

  const keyHexSet = [...new Set(rows.map((row) => row.keyHex))];
  const basePermSet = [...new Set(rows.map((row) => JSON.stringify(row.basePermHead)))];
  const permHeadSet = [...new Set(rows.map((row) => JSON.stringify(row.initialPermHead)))];
  const swapHeadSet = [...new Set(rows.map((row) => JSON.stringify(row.swapTargetsHead)))];
  const swapTailSet = [...new Set(rows.map((row) => JSON.stringify(row.swapTargetsTail)))];

  console.log(JSON.stringify({
    tries,
    count: rows.length,
    keyHexSet,
    basePermSet,
    permHeadSet,
    swapHeadSet,
    swapTailSet,
    rows,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
