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
        if (ok) out.push({ seqStart, targetStart, length, values: fragment });
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

function collectHits() {
  const target = profile.swapTargetQSourceIndexes || [];
  const rows = extractOpcode55Rows(snapshot.R || []);
  const hits = [];
  for (const row of rows) {
    for (const match of exactFragmentMatches(row.refs, target, 2, 8)) {
      hits.push({
        domain: 'raw',
        rowIndex: row.rowIndex,
        rowLength: row.rowLength,
        seqStart: match.seqStart,
        targetStart: match.targetStart,
        length: match.length,
        values: match.values,
        context: sliceWithContext(row.refs, match.seqStart, match.length, 3).values,
      });
    }
    const qValues = safeMap(row.refs, (value) => snapshot.q?.[value]);
    for (const match of exactFragmentMatches(qValues, target, 2, 8)) {
      hits.push({
        domain: 'q',
        rowIndex: row.rowIndex,
        rowLength: row.rowLength,
        seqStart: match.seqStart,
        targetStart: match.targetStart,
        length: match.length,
        values: match.values,
        context: sliceWithContext(qValues, match.seqStart, match.length, 3).values,
      });
    }
  }
  return hits.sort((a, b) =>
    a.targetStart - b.targetStart ||
    b.length - a.length ||
    a.rowIndex - b.rowIndex
  );
}

function clusterHits(hits) {
  const clusters = new Map();
  for (const hit of hits) {
    const key = JSON.stringify({
      domain: hit.domain,
      values: hit.values,
      left: hit.context.slice(0, 3),
      right: hit.context.slice(-3),
    });
    if (!clusters.has(key)) {
      clusters.set(key, {
        domain: hit.domain,
        values: hit.values,
        leftContext: hit.context.slice(0, 3),
        rightContext: hit.context.slice(-3),
        hits: [],
      });
    }
    clusters.get(key).hits.push({
      rowIndex: hit.rowIndex,
      rowLength: hit.rowLength,
      seqStart: hit.seqStart,
      targetStart: hit.targetStart,
      length: hit.length,
      context: hit.context,
    });
  }
  return [...clusters.values()].sort((a, b) =>
    b.hits.length - a.hits.length ||
    a.hits[0].targetStart - b.hits[0].targetStart
  );
}

function buildAdjacency(hits) {
  const byStart = new Map();
  for (const hit of hits) {
    if (!byStart.has(hit.targetStart)) byStart.set(hit.targetStart, []);
    byStart.get(hit.targetStart).push(hit);
  }
  const edges = [];
  for (const hit of hits) {
    const nextStart = hit.targetStart + hit.length;
    const nextHits = byStart.get(nextStart) || [];
    for (const next of nextHits) {
      edges.push({
        from: {
          domain: hit.domain,
          rowIndex: hit.rowIndex,
          targetStart: hit.targetStart,
          length: hit.length,
          values: hit.values,
        },
        to: {
          domain: next.domain,
          rowIndex: next.rowIndex,
          targetStart: next.targetStart,
          length: next.length,
          values: next.values,
        },
      });
    }
  }
  return edges;
}

function main() {
  const hits = collectHits();
  const clusters = clusterHits(hits);
  const edges = buildAdjacency(hits);
  console.log(JSON.stringify({
    targetLength: (profile.swapTargetQSourceIndexes || []).length,
    hitCount: hits.length,
    hits,
    clusters,
    adjacency: edges,
  }, null, 2));
}

main();
