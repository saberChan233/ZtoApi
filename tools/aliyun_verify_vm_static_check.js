#!/usr/bin/env node
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const {
  CURRENT_BUNDLE_BASE_PERM_L_REFS,
  CURRENT_BUNDLE_BASE_PERM_TABLE,
  CURRENT_BUNDLE_BASE_PERM_HOLE_REFS,
  CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES,
  CURRENT_BUNDLE_SWAP_TARGET_L_REFS,
  CURRENT_BUNDLE_SWAP_TARGET_VALUE_Q_SOURCE_INDEXES,
  CURRENT_BUNDLE_SWAP_TARGETS,
  CURRENT_BUNDLE_INITIAL_PERM_TABLE,
  materializeHolePatchesFromL,
  materializeValueRefsFromL,
  materializeValuesFromSourceIndexes,
  applyPermutationSwapTrace,
} = require('./aliyun_verify_data_vm_replay');

function isSubsequence(partial, full) {
  let cursor = 0;
  for (const value of full) {
    if (cursor < partial.length && value === partial[cursor]) {
      cursor += 1;
    }
  }
  return cursor === partial.length;
}

function main() {
  const partialBasePerm = Array.isArray(snapshot.partialBasePerm) ? snapshot.partialBasePerm : [];
  const basePermLRefs = Array.isArray(snapshot.basePermLRefs) ? snapshot.basePermLRefs : [];
  const basePermFromSnapshot = Array.isArray(snapshot.basePerm) ? snapshot.basePerm : [];
  const holePatches = materializeHolePatchesFromL(CURRENT_BUNDLE_BASE_PERM_HOLE_REFS, snapshot.L || []);
  const swapTargets = materializeValueRefsFromL(CURRENT_BUNDLE_SWAP_TARGET_L_REFS, snapshot.L || []);
  const swapTargetRefsFromQ = materializeValuesFromSourceIndexes(
    CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES || [],
    snapshot.q || [],
    'swapTargetQSourceIndexes',
  );
  const swapTargetsFromQ = materializeValuesFromSourceIndexes(
    CURRENT_BUNDLE_SWAP_TARGET_VALUE_Q_SOURCE_INDEXES || [],
    snapshot.q || [],
    'swapTargetValueQSourceIndexes',
  );
  const derivedFinal = applyPermutationSwapTrace(
    CURRENT_BUNDLE_BASE_PERM_TABLE,
    swapTargets,
  );
  console.log(JSON.stringify({
    bundlePath: snapshot.bundlePath || null,
    hashes: snapshot.hashes || null,
    partialBasePermLength: partialBasePerm.length,
    partialBasePermHead: partialBasePerm.slice(0, 16),
    partialBasePermTail: partialBasePerm.slice(-8),
    basePermLRefsLength: basePermLRefs.length,
    basePermLRefsHead: basePermLRefs.slice(0, 16),
    basePermHead: basePermFromSnapshot.slice(0, 16),
    basePermTail: basePermFromSnapshot.slice(-8),
    holePatches,
    swapTargetQSourceIndexesHead: (CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES || []).slice(0, 16),
    swapTargetRefsHead: CURRENT_BUNDLE_SWAP_TARGET_L_REFS.slice(0, 16),
    swapTargetRefsFromQHead: swapTargetRefsFromQ.slice(0, 16),
    swapTargetValueQSourceIndexesHead: (CURRENT_BUNDLE_SWAP_TARGET_VALUE_Q_SOURCE_INDEXES || []).slice(0, 16),
    swapTargetsHead: swapTargets.slice(0, 16),
    swapTargetsFromQHead: swapTargetsFromQ.slice(0, 16),
    partialBasePermIsSubsequenceOfRuntimeBase: isSubsequence(partialBasePerm, CURRENT_BUNDLE_BASE_PERM_TABLE),
    runtimeBaseMatchesSnapshotRefs: JSON.stringify(materializeValueRefsFromL(CURRENT_BUNDLE_BASE_PERM_L_REFS || [], snapshot.L || [])) ===
      JSON.stringify(CURRENT_BUNDLE_BASE_PERM_TABLE),
    runtimeBaseMatchesSnapshotBasePerm: JSON.stringify(basePermFromSnapshot) === JSON.stringify(CURRENT_BUNDLE_BASE_PERM_TABLE),
    runtimeBaseLength: CURRENT_BUNDLE_BASE_PERM_TABLE.length,
    runtimeSwapTargetsLength: CURRENT_BUNDLE_SWAP_TARGETS.length,
    runtimeSwapTargetRefsMatchQSourceIndexes: JSON.stringify(swapTargetRefsFromQ) === JSON.stringify(CURRENT_BUNDLE_SWAP_TARGET_L_REFS),
    runtimeSwapTargetsMatchQSourceIndexes: JSON.stringify(swapTargetsFromQ) === JSON.stringify(CURRENT_BUNDLE_SWAP_TARGETS),
    runtimeSwapTargetsMatchSnapshotRefs: JSON.stringify(swapTargets) === JSON.stringify(CURRENT_BUNDLE_SWAP_TARGETS),
    runtimeFinalMatchesDerived: JSON.stringify(derivedFinal) === JSON.stringify(CURRENT_BUNDLE_INITIAL_PERM_TABLE),
    rLength: Array.isArray(snapshot.R) ? snapshot.R.length : null,
    jLength: Array.isArray(snapshot.j) ? snapshot.j.length : null,
    lLength: Array.isArray(snapshot.L) ? snapshot.L.length : null,
  }, null, 2));
}

main();
