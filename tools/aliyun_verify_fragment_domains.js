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

function exactFragmentMatches(sequence, target, minLength = 2, maxLength = 8) {
  const out = [];
  const max = Math.min(maxLength, sequence.length, target.length);
  for (let length = max; length >= minLength; length -= 1) {
    for (let seqStart = 0; seqStart <= sequence.length - length; seqStart += 1) {
      const fragment = sequence.slice(seqStart, seqStart + length);
      for (let targetStart = 0; targetStart <= target.length - length; targetStart += 1) {
        let ok = true;
        for (let offset = 0; offset < length; offset += 1) {
          if (fragment[offset] !== target[targetStart + offset]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          out.push({
            seqStart,
            targetStart,
            length,
            values: fragment,
          });
        }
      }
    }
  }
  return out;
}

function safeMap(values, mapper) {
  const out = [];
  for (const value of values) {
    const next = mapper(value);
    if (next === undefined) break;
    out.push(next);
  }
  return out;
}

function main() {
  const rows = extractOpcode55Rows(snapshot.R || []);
  const targets = {
    q_source_indexes: profile.swapTargetQSourceIndexes || [],
    l_refs: replay.CURRENT_BUNDLE_SWAP_TARGET_L_REFS || [],
    l_values: replay.CURRENT_BUNDLE_SWAP_TARGETS || [],
  };
  const transforms = {
    raw_refs: (row) => row.refs,
    q_values_from_refs: (row) => safeMap(row.refs, (value) => snapshot.q?.[value]),
    l_values_from_q_values: (row) => safeMap(
      safeMap(row.refs, (value) => snapshot.q?.[value]),
      (value) => snapshot.L?.[value],
    ),
  };

  const report = {};
  for (const [transformName, transform] of Object.entries(transforms)) {
    report[transformName] = {};
    for (const [targetName, target] of Object.entries(targets)) {
      const matches = [];
      for (const row of rows) {
        const sequence = transform(row);
        const exact = exactFragmentMatches(sequence, target, 2, 8);
        if (exact.length) {
          matches.push({
            rowIndex: row.index,
            rowLength: row.len,
            topMatch: exact[0],
            matchCount: exact.length,
          });
        }
      }
      matches.sort((left, right) =>
        right.topMatch.length - left.topMatch.length ||
        left.rowIndex - right.rowIndex
      );
      report[transformName][targetName] = matches;
    }
  }

  console.log(JSON.stringify({
    hashes: snapshot.hashes || null,
    report,
  }, null, 2));
}

main();
