#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { extractBasePerm, extractSwapTargets } = require('./aliyun_verify_permutation_reverse');

const REPLAY_PROFILE_SNAPSHOT_PATH = path.join(__dirname, 'aliyun_verify_replay_profile_snapshot.js');

function findUniqueLIndex(value, lValues) {
  const matches = [];
  for (let i = 0; i < lValues.length; i += 1) {
    if (lValues[i] === value) matches.push(i);
  }
  if (matches.length !== 1) {
    throw new Error(`expected unique L index for value ${value}, got ${matches.length}`);
  }
  return matches[0];
}

function deriveHoleRefsFromBasePerm(basePerm, partialBasePerm, lValues) {
  const refs = [];
  let cursor = 0;
  for (let index = 0; index < basePerm.length; index += 1) {
    if (cursor < partialBasePerm.length && basePerm[index] === partialBasePerm[cursor]) {
      cursor += 1;
      continue;
    }
    refs.push({
      index,
      value: basePerm[index],
      lIndex: findUniqueLIndex(basePerm[index], lValues),
    });
  }
  if (cursor !== partialBasePerm.length) {
    throw new Error(`partial base perm not fully consumed: ${cursor}/${partialBasePerm.length}`);
  }
  return refs;
}

function deriveSwapTargetRefs(swapTargets, lValues) {
  return swapTargets.map((value, position) => ({
    position,
    value,
    lIndex: findUniqueLIndex(value, lValues),
  }));
}

function deriveQSourceIndexes(values, qValues) {
  return values.map((value, position) => {
    const indexes = [];
    for (let index = 0; index < qValues.length; index += 1) {
      if (qValues[index] === value) indexes.push(index);
    }
    if (indexes.length !== 1) {
      throw new Error(`expected unique q source index for value ${value} at position ${position}, got ${indexes.length}`);
    }
    return indexes[0];
  });
}

function buildReplayProfileSnapshot({ keyHex, swapTargets, swapTargetRefs }) {
  return {
    bundlePath: snapshot.bundlePath || null,
    keyHex,
    hashes: snapshot.hashes || null,
    swapTargetQSourceIndexes: deriveQSourceIndexes(
      swapTargetRefs.map((row) => row.lIndex),
      snapshot.q || [],
    ),
  };
}

function writeReplayProfileSnapshot(profile, outputPath = REPLAY_PROFILE_SNAPSHOT_PATH) {
  const content = `// Generated replay profile snapshot for current verify-data bundle\n` +
    `module.exports = ${JSON.stringify(profile, null, 2)};\n`;
  fs.writeFileSync(outputPath, content);
  return {
    outputPath,
    bytes: Buffer.byteLength(content),
  };
}

async function main() {
  const shouldWriteSnapshot = process.argv.includes('--write-snapshot');
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const keyHex = out?.verifyDataRuntimeFrame?.keyHex;
  if (!keyHex) throw new Error('missing keyHex');
  const basePerm = extractBasePerm(out.tVmAssignLogs, keyHex);
  const swapTargets = extractSwapTargets(out.tVmAssignLogs, keyHex);
  const partialBasePerm = snapshot.partialBasePerm || [];
  const lValues = snapshot.L || [];
  const snapshotBasePerm = snapshot.basePerm || [];
  const snapshotBasePermLRefs = snapshot.basePermLRefs || [];
  const holeRefs = deriveHoleRefsFromBasePerm(basePerm, partialBasePerm, lValues);
  const swapTargetRefs = deriveSwapTargetRefs(swapTargets, lValues);
  const replayProfileSnapshot = buildReplayProfileSnapshot({
    keyHex,
    swapTargets,
    swapTargetRefs,
  });
  const payload = {
    keyHex,
    runtimeBaseMatchesSnapshotBasePerm: JSON.stringify(basePerm) === JSON.stringify(snapshotBasePerm),
    snapshotBasePermLRefs,
    holeRefs,
    swapTargetRefs,
    replayProfileSnapshot,
  };
  if (shouldWriteSnapshot) {
    payload.snapshotWrite = writeReplayProfileSnapshot(replayProfileSnapshot);
  }
  console.log(JSON.stringify(payload, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
} else {
  module.exports = {
    REPLAY_PROFILE_SNAPSHOT_PATH,
    findUniqueLIndex,
    deriveHoleRefsFromBasePerm,
    deriveSwapTargetRefs,
    buildReplayProfileSnapshot,
    writeReplayProfileSnapshot,
  };
}
