#!/usr/bin/env node

const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const {
  CURRENT_BUNDLE_VERIFY_KEY_HEX,
  CURRENT_BUNDLE_BASE_PERM_TABLE,
  CURRENT_BUNDLE_SWAP_TARGETS,
  CURRENT_BUNDLE_INITIAL_PERM_TABLE,
  applyPermutationSwapTrace,
} = require('./aliyun_verify_data_vm_replay');

function extractSwapTargets(assignLogs, keyHex) {
  const rows = [];
  for (const entry of Array.isArray(assignLogs) ? assignLogs : []) {
    if (
      entry?.k === 't' &&
      entry?.sPreview?.n === keyHex &&
      typeof entry?.sPreview?.o === 'number' &&
      typeof entry?.vPreview === 'number'
    ) {
      rows.push({
        index: entry.sPreview.o,
        target: entry.vPreview,
      });
    }
  }
  rows.sort((left, right) => left.index - right.index);
  return rows
    .filter((row) => row.index >= 0)
    .map((row) => row.target)
    .slice(1);
}

function extractBasePerm(assignLogs, keyHex) {
  const row = (Array.isArray(assignLogs) ? assignLogs : []).find((entry) =>
    entry?.k === 'r' &&
    entry?.sPreview?.n === keyHex &&
    Array.isArray(entry?.vPreview)
  );
  return Array.isArray(row?.vPreview) ? row.vPreview.slice() : null;
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const keyHex = out?.verifyDataRuntimeFrame?.keyHex || CURRENT_BUNDLE_VERIFY_KEY_HEX;
  const basePerm = extractBasePerm(out.tVmAssignLogs, keyHex);
  const swapTargets = extractSwapTargets(out.tVmAssignLogs, keyHex);
  const derivedFinal = basePerm && swapTargets.length ? applyPermutationSwapTrace(basePerm, swapTargets) : null;
  console.log(JSON.stringify({
    keyHex,
    basePerm,
    swapTargets,
    derivedFinal,
    matchesRuntimeFrame: JSON.stringify(derivedFinal) === JSON.stringify(out?.verifyDataRuntimeFrame?.initialPermTable || null),
    matchesBundledBase: JSON.stringify(basePerm) === JSON.stringify(CURRENT_BUNDLE_BASE_PERM_TABLE),
    matchesBundledSwapTargets: JSON.stringify(swapTargets) === JSON.stringify(CURRENT_BUNDLE_SWAP_TARGETS),
    matchesBundledFinal: JSON.stringify(derivedFinal) === JSON.stringify(CURRENT_BUNDLE_INITIAL_PERM_TABLE),
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
} else {
  module.exports = {
    extractBasePerm,
    extractSwapTargets,
  };
}
