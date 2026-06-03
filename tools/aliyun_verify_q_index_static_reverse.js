#!/usr/bin/env node
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');

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

function buildStaticQIndexCandidates(artifacts = snapshot) {
  const qValues = Array.isArray(artifacts?.q) ? artifacts.q : [];
  const lValues = Array.isArray(artifacts?.L) ? artifacts.L : [];
  const out = [];
  for (let qSourceIndex = 0; qSourceIndex < qValues.length; qSourceIndex += 1) {
    const lRef = qValues[qSourceIndex];
    if (!Number.isInteger(lRef) || lRef < 0 || lRef >= lValues.length) continue;
    const value = lValues[lRef];
    if (!Number.isInteger(value) || value < 0 || value >= 64) continue;
    out.push({
      qSourceIndex,
      lRef,
      value,
    });
  }
  return out;
}

function buildCandidateMaps(candidates) {
  const byQSourceIndex = new Map();
  const byLRef = new Map();
  const byValue = new Map();
  for (const candidate of candidates) {
    byQSourceIndex.set(candidate.qSourceIndex, candidate);
    if (!byLRef.has(candidate.lRef)) byLRef.set(candidate.lRef, []);
    if (!byValue.has(candidate.value)) byValue.set(candidate.value, []);
    byLRef.get(candidate.lRef).push(candidate);
    byValue.get(candidate.value).push(candidate);
  }
  return { byQSourceIndex, byLRef, byValue };
}

function countRuns(values, predicate) {
  let runs = 0;
  let inRun = false;
  for (const value of values) {
    const hit = predicate(value);
    if (hit && !inRun) {
      runs += 1;
      inRun = true;
    } else if (!hit) {
      inRun = false;
    }
  }
  return runs;
}

function countAdjacentEqual(values) {
  let count = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === values[index - 1]) count += 1;
  }
  return count;
}

function tallyPairs(sequences) {
  const pairCounts = new Map();
  for (const sequence of sequences) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const key = `${sequence[index]}->${sequence[index + 1]}`;
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
  }
  return [...pairCounts.entries()]
    .map(([pair, count]) => ({ pair, count }))
    .sort((left, right) => right.count - left.count || left.pair.localeCompare(right.pair));
}

function scoreStaticRow(row, candidateIndexSet, candidateMap) {
  const candidateRefs = row.refs.filter((value) => candidateIndexSet.has(value));
  const candidateValues = candidateRefs
    .map((value) => candidateMap.get(value)?.value)
    .filter((value) => value !== undefined);
  const density = row.refs.length ? candidateRefs.length / row.refs.length : 0;
  const refRuns = countRuns(row.refs, (value) => candidateIndexSet.has(value));
  const duplicateRefs = candidateRefs.length - new Set(candidateRefs).size;
  const duplicateValues = candidateValues.length - new Set(candidateValues).size;
  const valueAdjacencyRepeats = countAdjacentEqual(candidateValues);
  const score = Number((
    candidateRefs.length * 4 +
    density * 10 -
    refRuns * 0.8 -
    duplicateRefs * 0.5 -
    duplicateValues * 0.25 -
    valueAdjacencyRepeats * 0.2
  ).toFixed(3));
  return {
    rowIndex: row.rowIndex,
    rowLength: row.rowLength,
    refs: row.refs,
    candidateRefs,
    candidateValues,
    candidateRefCount: candidateRefs.length,
    candidateValueCount: candidateValues.length,
    density,
    refRuns,
    duplicateRefs,
    duplicateValues,
    valueAdjacencyRepeats,
    score,
  };
}

function buildStaticReverseReport(artifacts = snapshot) {
  const candidates = buildStaticQIndexCandidates(artifacts);
  const rows = extractOpcode55Rows(artifacts?.R || []);
  const maps = buildCandidateMaps(candidates);
  const candidateIndexSet = new Set(candidates.map((item) => item.qSourceIndex));
  const scoredRows = rows
    .map((row) => scoreStaticRow(row, candidateIndexSet, maps.byQSourceIndex))
    .filter((row) => row.candidateRefCount > 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.candidateRefCount - left.candidateRefCount ||
      left.rowIndex - right.rowIndex
    );
  const candidateRefSequences = scoredRows
    .map((row) => row.candidateRefs)
    .filter((row) => row.length >= 2);
  const candidateValueSequences = scoredRows
    .map((row) => row.candidateValues)
    .filter((row) => row.length >= 2);
  return {
    hashes: artifacts?.hashes || null,
    bundlePath: artifacts?.bundlePath || null,
    candidateCount: candidates.length,
    candidates,
    topRows: scoredRows.slice(0, 32),
    pairFrequencies: {
      qSourceIndex: tallyPairs(candidateRefSequences).slice(0, 80),
      value: tallyPairs(candidateValueSequences).slice(0, 80),
    },
  };
}

function main() {
  console.log(JSON.stringify(buildStaticReverseReport(snapshot), null, 2));
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    extractOpcode55Rows,
    buildStaticQIndexCandidates,
    buildCandidateMaps,
    scoreStaticRow,
    buildStaticReverseReport,
  };
}
