#!/usr/bin/env node
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const replay = require('./aliyun_verify_data_vm_replay');
const {
  buildStaticReverseReport,
  buildStaticQIndexCandidates,
} = require('./aliyun_verify_q_index_static_reverse');

function buildCandidateMap(candidates) {
  return new Map(candidates.map((item) => [item.qSourceIndex, item]));
}

function buildDirectedWeights(rows) {
  const weights = new Map();
  const add = (from, to, weight) => {
    const key = `${from}->${to}`;
    weights.set(key, (weights.get(key) || 0) + weight);
  };
  for (const row of rows) {
    const seq = row.candidateRefs || [];
    if (seq.length < 2) continue;
    const base = Math.max(1, row.score || row.candidateRefCount || 1);
    for (let index = 0; index < seq.length - 1; index += 1) {
      const from = seq[index];
      const to = seq[index + 1];
      if (from === to) {
        add(from, to, base * 0.25);
        continue;
      }
      add(from, to, base * 1.0);
      if (index + 2 < seq.length && seq[index + 2] !== from) {
        add(from, seq[index + 2], base * 0.2);
      }
    }
  }
  return weights;
}

function buildNodeStats(rows, weights) {
  const stats = new Map();
  const touch = (node) => {
    if (!stats.has(node)) {
      stats.set(node, {
        node,
        appearances: 0,
        rowCount: 0,
        incoming: 0,
        outgoing: 0,
        selfLoop: 0,
      });
    }
    return stats.get(node);
  };
  for (const row of rows) {
    const unique = new Set();
    for (const node of row.candidateRefs || []) {
      const item = touch(node);
      item.appearances += 1;
      unique.add(node);
    }
    for (const node of unique) {
      touch(node).rowCount += 1;
    }
  }
  for (const [pair, value] of weights.entries()) {
    const [fromText, toText] = pair.split('->');
    const from = Number(fromText);
    const to = Number(toText);
    touch(from).outgoing += value;
    touch(to).incoming += value;
    if (from === to) touch(from).selfLoop += value;
  }
  return stats;
}

function rankStartNodes(stats, candidates) {
  return [...candidates]
    .map((item) => {
      const stat = stats.get(item.qSourceIndex) || {
        appearances: 0,
        rowCount: 0,
        incoming: 0,
        outgoing: 0,
        selfLoop: 0,
      };
      return {
        qSourceIndex: item.qSourceIndex,
        value: item.value,
        score: (stat.outgoing - stat.incoming) + stat.rowCount * 2 + stat.appearances * 0.1 - stat.selfLoop * 0.5,
        stat,
      };
    })
    .sort((left, right) => right.score - left.score || left.qSourceIndex - right.qSourceIndex);
}

function transitionScore(from, to, weights, stats, visitCounts) {
  const direct = weights.get(`${from}->${to}`) || 0;
  const reversePenalty = (weights.get(`${to}->${from}`) || 0) * 0.15;
  const stat = stats.get(to) || { rowCount: 0, appearances: 0, selfLoop: 0, incoming: 0, outgoing: 0 };
  const visits = visitCounts.get(to) || 0;
  return direct +
    stat.rowCount * 0.35 +
    stat.appearances * 0.05 +
    (stat.outgoing - stat.incoming) * 0.03 -
    stat.selfLoop * 0.1 -
    reversePenalty -
    visits * 4;
}

function chooseNextNode(current, allNodes, weights, stats, visitCounts) {
  let best = null;
  for (const candidate of allNodes) {
    const next = candidate.qSourceIndex;
    const score = transitionScore(current, next, weights, stats, visitCounts);
    if (!best || score > best.score || (score === best.score && next < best.qSourceIndex)) {
      best = {
        qSourceIndex: next,
        value: candidate.value,
        score,
      };
    }
  }
  return best;
}

function buildHeuristicSequence(candidates, rows, wantedLength) {
  const weights = buildDirectedWeights(rows);
  const stats = buildNodeStats(rows, weights);
  const rankedStarts = rankStartNodes(stats, candidates);
  const allNodes = candidates.slice().sort((left, right) => left.qSourceIndex - right.qSourceIndex);
  const start = rankedStarts[0];
  if (!start) {
    return {
      sequence: [],
      valueSequence: [],
      rankedStarts,
      weights,
      stats,
    };
  }
  const visitCounts = new Map();
  const sequence = [start.qSourceIndex];
  visitCounts.set(start.qSourceIndex, 1);
  while (sequence.length < wantedLength) {
    const current = sequence[sequence.length - 1];
    const next = chooseNextNode(current, allNodes, weights, stats, visitCounts);
    if (!next) break;
    sequence.push(next.qSourceIndex);
    visitCounts.set(next.qSourceIndex, (visitCounts.get(next.qSourceIndex) || 0) + 1);
  }
  const candidateMap = buildCandidateMap(candidates);
  const valueSequence = sequence.map((qSourceIndex) => candidateMap.get(qSourceIndex)?.value ?? null);
  return {
    sequence,
    valueSequence,
    rankedStarts,
    weights,
    stats,
  };
}

function longestCommonSubsequenceLength(left, right) {
  const dp = Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const nextPrev = dp[j];
      dp[j] = left[i - 1] === right[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = nextPrev;
    }
  }
  return dp[right.length];
}

function compareWithSnapshot(sequence, target) {
  let exactMatches = 0;
  for (let index = 0; index < Math.min(sequence.length, target.length); index += 1) {
    if (sequence[index] === target[index]) exactMatches += 1;
  }
  return {
    exactMatches,
    prefixMatches: (() => {
      let count = 0;
      while (count < sequence.length && count < target.length && sequence[count] === target[count]) count += 1;
      return count;
    })(),
    lcsLength: longestCommonSubsequenceLength(sequence, target),
  };
}

function main() {
  const candidates = buildStaticQIndexCandidates(snapshot);
  const report = buildStaticReverseReport(snapshot);
  const wantedLength = replay.CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES.length;
  const heuristic = buildHeuristicSequence(candidates, report.topRows, wantedLength);
  const snapshotCompare = compareWithSnapshot(
    heuristic.sequence,
    replay.CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES,
  );
  console.log(JSON.stringify({
    hashes: snapshot.hashes || null,
    wantedLength,
    startCandidates: heuristic.rankedStarts.slice(0, 16),
    heuristicSequence: heuristic.sequence,
    heuristicValueSequence: heuristic.valueSequence,
    snapshotCompare,
  }, null, 2));
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    buildDirectedWeights,
    buildNodeStats,
    rankStartNodes,
    buildHeuristicSequence,
    compareWithSnapshot,
  };
}
