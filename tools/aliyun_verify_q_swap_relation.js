#!/usr/bin/env node
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const replay = require('./aliyun_verify_data_vm_replay');

function collectHitRows(source, target) {
  const out = [];
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const value = source[sourceIndex];
    const targetPositions = [];
    for (let position = 0; position < target.length; position += 1) {
      if (target[position] === value) targetPositions.push(position);
    }
    if (targetPositions.length) {
      out.push({
        sourceIndex,
        value,
        targetPositions,
      });
    }
  }
  return out;
}

function collectContiguousRuns(source, targetSet) {
  const runs = [];
  let start = -1;
  for (let index = 0; index < source.length; index += 1) {
    const hit = targetSet.has(source[index]);
    if (hit && start < 0) start = index;
    if ((!hit || index === source.length - 1) && start >= 0) {
      const end = hit && index === source.length - 1 ? index : index - 1;
      runs.push({
        start,
        end,
        length: end - start + 1,
        values: source.slice(start, end + 1),
      });
      start = -1;
    }
  }
  return runs;
}

function collectExactWindows(source, target, minLength = 2, maxLength = 12) {
  const out = [];
  for (let length = Math.min(maxLength, target.length); length >= minLength; length -= 1) {
    for (let sourceIndex = 0; sourceIndex <= source.length - length; sourceIndex += 1) {
      const segment = source.slice(sourceIndex, sourceIndex + length);
      for (let targetIndex = 0; targetIndex <= target.length - length; targetIndex += 1) {
        if (segment.every((value, offset) => value === target[targetIndex + offset])) {
          out.push({
            sourceIndex,
            targetIndex,
            length,
            values: segment,
          });
        }
      }
    }
  }
  return out;
}

function summarize(label, source, target) {
  const hits = collectHitRows(source, target);
  return {
    label,
    hitCount: hits.length,
    hits,
    runs: collectContiguousRuns(source, new Set(target)).filter((row) => row.length >= 2),
    exactWindows: collectExactWindows(source, target, 2, 12),
  };
}

function main() {
  const qValues = Array.isArray(snapshot.q) ? snapshot.q : [];
  const refsSummary = summarize('swapTargetLRefs', qValues, replay.CURRENT_BUNDLE_SWAP_TARGET_L_REFS || []);
  const valuesSummary = summarize('swapTargets', qValues, replay.CURRENT_BUNDLE_SWAP_TARGETS || []);
  console.log(JSON.stringify({
    hashes: snapshot.hashes || null,
    qLength: qValues.length,
    refsSummary,
    valuesSummary,
  }, null, 2));
}

main();
