#!/usr/bin/env node
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const replay = require('./aliyun_verify_data_vm_replay');

function extractEwKeys(initSource) {
  const out = [];
  const source = String(initSource || '');
  const dotMatches = [...source.matchAll(/eW\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)];
  for (const match of dotMatches) out.push(match[1]);
  const bracketMatches = [...source.matchAll(/eW\[(.*?)\]\s*=/g)];
  for (const match of bracketMatches) out.push(`[${match[1]}]`);
  return out;
}

function countValuesInTable(values, table) {
  const tableSet = new Set(Array.isArray(table) ? table : []);
  return values.filter((value) => tableSet.has(value)).length;
}

function main() {
  const swapRefs = replay.CURRENT_BUNDLE_SWAP_TARGET_L_REFS || [];
  const swapTargets = replay.CURRENT_BUNDLE_SWAP_TARGETS || [];
  const qValues = snapshot.q || [];
  console.log(JSON.stringify({
    hashes: snapshot.hashes || null,
    qLength: qValues.length,
    qHead: qValues.slice(0, 48),
    gCallsiteSource: snapshot.gCallsiteSource || null,
    eWInitSource: snapshot.eWInitSource || null,
    eWKeys: extractEwKeys(snapshot.eWInitSource),
    swapRefsHead: swapRefs.slice(0, 24),
    swapTargetsHead: swapTargets.slice(0, 24),
    swapTargetRefsPresentInQCount: countValuesInTable(swapRefs, qValues),
    swapTargetsPresentInQCount: countValuesInTable(swapTargets, qValues),
  }, null, 2));
}

main();
