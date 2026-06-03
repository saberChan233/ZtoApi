#!/usr/bin/env node
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const profile = require('./aliyun_verify_replay_profile_snapshot');
const replay = require('./aliyun_verify_data_vm_replay');

function extractOpcode55Rows(program) {
  const rows = [];
  const source = Array.isArray(program) ? program : [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== 55) continue;
    const len = source[index + 1];
    const refs = [];
    let cursor = index - 1;
    while (cursor >= 1 && source[cursor - 1] === 43) {
      refs.unshift(source[cursor]);
      cursor -= 2;
    }
    rows.push({ index, len, refs });
  }
  return rows;
}

function enumerateExactSubsequenceMatches(rows, target, minLength = 2) {
  const matches = [];
  for (const row of rows) {
    const refs = row.refs || [];
    for (let start = 0; start < refs.length; start += 1) {
      for (let end = refs.length; end >= start + minLength; end -= 1) {
        const segment = refs.slice(start, end);
        for (let targetStart = 0; targetStart <= target.length - segment.length; targetStart += 1) {
          let ok = true;
          for (let offset = 0; offset < segment.length; offset += 1) {
            if (segment[offset] !== target[targetStart + offset]) {
              ok = false;
              break;
            }
          }
          if (ok) {
            matches.push({
              rowIndex: row.index,
              rowLength: row.len,
              rowSliceStart: start,
              rowSliceEnd: end,
              targetStart,
              targetEnd: targetStart + segment.length,
              length: segment.length,
              values: segment,
            });
          }
        }
      }
    }
  }
  matches.sort((left, right) =>
    right.length - left.length ||
    left.targetStart - right.targetStart ||
    left.rowIndex - right.rowIndex
  );
  return matches;
}

function greedyCover(targetLength, matches) {
  const covered = Array(targetLength).fill(false);
  const chosen = [];
  for (const match of matches) {
    let addsCoverage = false;
    for (let index = match.targetStart; index < match.targetEnd; index += 1) {
      if (!covered[index]) {
        addsCoverage = true;
        break;
      }
    }
    if (!addsCoverage) continue;
    chosen.push(match);
    for (let index = match.targetStart; index < match.targetEnd; index += 1) {
      covered[index] = true;
    }
  }
  const uncoveredPositions = [];
  for (let index = 0; index < covered.length; index += 1) {
    if (!covered[index]) uncoveredPositions.push(index);
  }
  return {
    chosen,
    coveredCount: covered.filter(Boolean).length,
    uncoveredPositions,
  };
}

function main() {
  const mode = process.argv[2] === 'values' ? 'values' : 'refs';
  const target = mode === 'values'
    ? (replay.CURRENT_BUNDLE_SWAP_TARGET_VALUE_Q_SOURCE_INDEXES || [])
    : (profile.swapTargetQSourceIndexes || []);
  const rows = extractOpcode55Rows(snapshot.R || []);
  const matches = enumerateExactSubsequenceMatches(rows, target, 2);
  const cover = greedyCover(target.length, matches);
  console.log(JSON.stringify({
    mode,
    targetLength: target.length,
    matchCount: matches.length,
    topMatches: matches.slice(0, 80),
    greedyCover: cover,
  }, null, 2));
}

main();
