#!/usr/bin/env node
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const profile = require('./aliyun_verify_replay_profile_snapshot');

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
    rows.push({ rowIndex: index, rowLength: len, refs });
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
          out.push({ seqStart, targetStart, length, values: fragment });
        }
      }
    }
  }
  return out;
}

function sliceWithContext(values, start, length, radius = 3) {
  const from = Math.max(0, start - radius);
  const to = Math.min(values.length, start + length + radius);
  return {
    from,
    to,
    values: values.slice(from, to),
  };
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
  const target = profile.swapTargetQSourceIndexes || [];
  const rows = extractOpcode55Rows(snapshot.R || []);
  const report = [];
  for (const row of rows) {
    const rawMatches = exactFragmentMatches(row.refs, target, 2, 8);
    const qValues = safeMap(row.refs, (value) => snapshot.q?.[value]);
    const qMatches = exactFragmentMatches(qValues, target, 2, 8);
    if (!rawMatches.length && !qMatches.length) continue;
    report.push({
      rowIndex: row.rowIndex,
      rowLength: row.rowLength,
      raw: rawMatches.map((match) => ({
        ...match,
        rowContext: sliceWithContext(row.refs, match.seqStart, match.length, 3),
      })),
      q: qMatches.map((match) => ({
        ...match,
        rowContext: sliceWithContext(qValues, match.seqStart, match.length, 3),
      })),
    });
  }
  console.log(JSON.stringify({
    targetLength: target.length,
    rows: report,
  }, null, 2));
}

main();
