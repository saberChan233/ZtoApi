#!/usr/bin/env node
const verifyVmArtifactsSnapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const verifyReplayProfileSnapshot = require('./aliyun_verify_replay_profile_snapshot');
const {
  buildStaticQIndexCandidates,
  buildStaticReverseReport,
} = require('./aliyun_verify_q_index_static_reverse');

const CURRENT_BUNDLE_VERIFY_KEY_HEX = verifyReplayProfileSnapshot?.keyHex || '';
const CURRENT_BUNDLE_EXPECTED_VM_ARTIFACT_HASHES = verifyReplayProfileSnapshot?.hashes || {};
const CURRENT_BUNDLE_INITIAL_VM_STATE = { e: 0, a: 0, t: '' };
const CURRENT_BUNDLE_Q_SOURCE_INDEX_STATIC_CANDIDATES = buildStaticQIndexCandidates(verifyVmArtifactsSnapshot);
const CURRENT_BUNDLE_Q_SOURCE_INDEX_STATIC_CANDIDATE_SET = new Set(
  CURRENT_BUNDLE_Q_SOURCE_INDEX_STATIC_CANDIDATES.map((item) => item.qSourceIndex),
);
const CURRENT_BUNDLE_Q_SOURCE_INDEX_STATIC_REPORT = buildStaticReverseReport(verifyVmArtifactsSnapshot);

function materializeHolePatchesFromL(holeRefs, lValues) {
  if (!Array.isArray(holeRefs) || !Array.isArray(lValues)) {
    throw new Error('holeRefs and lValues must be arrays');
  }
  return holeRefs.map((item) => {
    const value = lValues[item.lIndex];
    if (!Number.isInteger(value)) {
      throw new Error(`invalid L reference for basePerm hole: index=${item.index} lIndex=${item.lIndex}`);
    }
    return {
      index: item.index,
      value,
      lIndex: item.lIndex,
    };
  });
}

function buildBasePermTableFromPartial(partialBasePerm, holePatches) {
  if (!Array.isArray(partialBasePerm) || !Array.isArray(holePatches)) {
    throw new Error('partialBasePerm and holePatches must be arrays');
  }
  const totalLength = partialBasePerm.length + holePatches.length;
  const patchMap = new Map(holePatches.map((item) => [item.index, item.value]));
  const out = [];
  let cursor = 0;
  for (let index = 0; index < totalLength; index += 1) {
    if (patchMap.has(index)) {
      out.push(patchMap.get(index));
    } else {
      if (cursor >= partialBasePerm.length) {
        throw new Error(`partialBasePerm exhausted at index ${index}`);
      }
      out.push(partialBasePerm[cursor]);
      cursor += 1;
    }
  }
  if (cursor !== partialBasePerm.length) {
    throw new Error(`unused partialBasePerm values: cursor=${cursor} len=${partialBasePerm.length}`);
  }
  return out;
}

function materializeValueRefsFromL(lRefs, lValues) {
  if (!Array.isArray(lRefs) || !Array.isArray(lValues)) {
    throw new Error('lRefs and lValues must be arrays');
  }
  return lRefs.map((lIndex, position) => {
    const value = lValues[lIndex];
    if (!Number.isInteger(value)) {
      throw new Error(`invalid L reference at position ${position}: lIndex=${lIndex}`);
    }
    return value;
  });
}

function materializeValuesFromSourceIndexes(sourceIndexes, sourceValues, label) {
  if (!Array.isArray(sourceIndexes) || !Array.isArray(sourceValues)) {
    throw new Error(`${label} sourceIndexes and sourceValues must be arrays`);
  }
  return sourceIndexes.map((sourceIndex, position) => {
    const value = sourceValues[sourceIndex];
    if (value === undefined) {
      throw new Error(`invalid ${label} source index at position ${position}: ${sourceIndex}`);
    }
    return value;
  });
}

function buildUniqueIndexMap(values, label) {
  if (!Array.isArray(values)) {
    throw new Error(`${label} values must be an array`);
  }
  const out = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (out.has(value)) {
      throw new Error(`expected unique ${label} value for index map, got duplicate: ${String(value)}`);
    }
    out.set(value, index);
  }
  return out;
}

function deriveSwapTargetValueQSourceIndexesFromRefQIndexes(refQSourceIndexes, qValues, lValues) {
  const qIndexMap = buildUniqueIndexMap(qValues, 'q');
  return materializeValuesFromSourceIndexes(
    refQSourceIndexes,
    qValues,
    'swapTargetQSourceIndexes',
  ).map((lIndex, position) => {
    const value = lValues[lIndex];
    if (!qIndexMap.has(value)) {
      throw new Error(`missing q source index for swap target value at position ${position}: ${String(value)}`);
    }
    return qIndexMap.get(value);
  });
}

function deriveHoleRefsFromPartialBasePerm(basePermTable, partialBasePerm, basePermLRefs) {
  if (!Array.isArray(basePermTable) || !Array.isArray(partialBasePerm) || !Array.isArray(basePermLRefs)) {
    throw new Error('basePermTable, partialBasePerm, and basePermLRefs must be arrays');
  }
  if (basePermTable.length !== basePermLRefs.length) {
    throw new Error(`basePerm/basePermLRefs length mismatch: ${basePermTable.length}/${basePermLRefs.length}`);
  }
  const holeRefs = [];
  let cursor = 0;
  for (let index = 0; index < basePermTable.length; index += 1) {
    if (cursor < partialBasePerm.length && basePermTable[index] === partialBasePerm[cursor]) {
      cursor += 1;
      continue;
    }
    holeRefs.push({
      index,
      lIndex: basePermLRefs[index],
    });
  }
  if (cursor !== partialBasePerm.length) {
    throw new Error(`partialBasePerm not fully consumed while deriving hole refs: ${cursor}/${partialBasePerm.length}`);
  }
  return holeRefs;
}

function buildCurrentBundleBasePermTable() {
  const basePerm = verifyVmArtifactsSnapshot?.basePerm;
  const basePermLRefs = verifyVmArtifactsSnapshot?.basePermLRefs;
  const lValues = verifyVmArtifactsSnapshot?.L;
  const jHash = verifyVmArtifactsSnapshot?.hashes?.j;
  const lHash = verifyVmArtifactsSnapshot?.hashes?.L;
  const qHash = verifyVmArtifactsSnapshot?.hashes?.q;
  if (
    Array.isArray(basePerm) &&
    Array.isArray(basePermLRefs) &&
    Array.isArray(lValues) &&
    basePerm.length === 64 &&
    basePermLRefs.length === 64 &&
    jHash === CURRENT_BUNDLE_EXPECTED_VM_ARTIFACT_HASHES.j &&
    lHash === CURRENT_BUNDLE_EXPECTED_VM_ARTIFACT_HASHES.L &&
    qHash === CURRENT_BUNDLE_EXPECTED_VM_ARTIFACT_HASHES.q
  ) {
    const materialized = materializeValueRefsFromL(basePermLRefs, lValues);
    if (JSON.stringify(materialized) !== JSON.stringify(basePerm)) {
      throw new Error('verify VM artifact snapshot basePermLRefs do not materialize to basePerm');
    }
    return basePerm.slice();
  }
  throw new Error('verify VM artifact snapshot does not match current bundle base-perm profile');
}

const CURRENT_BUNDLE_BASE_PERM_L_REFS = Array.isArray(verifyVmArtifactsSnapshot?.basePermLRefs)
  ? verifyVmArtifactsSnapshot.basePermLRefs.slice()
  : null;
const CURRENT_BUNDLE_BASE_PERM_TABLE = buildCurrentBundleBasePermTable();
const CURRENT_BUNDLE_BASE_PERM_HOLE_REFS = deriveHoleRefsFromPartialBasePerm(
  CURRENT_BUNDLE_BASE_PERM_TABLE,
  verifyVmArtifactsSnapshot?.partialBasePerm || [],
  CURRENT_BUNDLE_BASE_PERM_L_REFS || [],
);
const CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES = Array.isArray(verifyReplayProfileSnapshot?.swapTargetQSourceIndexes)
  ? verifyReplayProfileSnapshot.swapTargetQSourceIndexes.slice()
  : [];
if (
  CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES.some((value) => !CURRENT_BUNDLE_Q_SOURCE_INDEX_STATIC_CANDIDATE_SET.has(value))
) {
  throw new Error('replay profile snapshot q_source_indexes are not covered by static q-index candidates');
}
const CURRENT_BUNDLE_SWAP_TARGET_L_REFS = CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES.length
  ? materializeValuesFromSourceIndexes(
    CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES,
    verifyVmArtifactsSnapshot?.q || [],
    'swapTargetQSourceIndexes',
  )
  : Array.isArray(verifyReplayProfileSnapshot?.swapTargetLRefs)
    ? verifyReplayProfileSnapshot.swapTargetLRefs.slice()
    : [];
const CURRENT_BUNDLE_SWAP_TARGETS = materializeValueRefsFromL(
  CURRENT_BUNDLE_SWAP_TARGET_L_REFS,
  verifyVmArtifactsSnapshot?.L || [],
);
const CURRENT_BUNDLE_SWAP_TARGET_VALUE_Q_SOURCE_INDEXES = CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES.length
  ? deriveSwapTargetValueQSourceIndexesFromRefQIndexes(
    CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES,
    verifyVmArtifactsSnapshot?.q || [],
    verifyVmArtifactsSnapshot?.L || [],
  )
  : Array.isArray(verifyReplayProfileSnapshot?.swapTargetValueQSourceIndexes)
    ? verifyReplayProfileSnapshot.swapTargetValueQSourceIndexes.slice()
    : [];
if (CURRENT_BUNDLE_SWAP_TARGET_VALUE_Q_SOURCE_INDEXES.length) {
  const qMaterializedSwapTargets = materializeValuesFromSourceIndexes(
    CURRENT_BUNDLE_SWAP_TARGET_VALUE_Q_SOURCE_INDEXES,
    verifyVmArtifactsSnapshot?.q || [],
    'swapTargetValueQSourceIndexes',
  );
  if (JSON.stringify(qMaterializedSwapTargets) !== JSON.stringify(CURRENT_BUNDLE_SWAP_TARGETS)) {
    throw new Error('replay profile snapshot swapTargetValueQSourceIndexes do not match materialized swapTargets');
  }
}
if (
  Array.isArray(verifyReplayProfileSnapshot?.swapTargets) &&
  JSON.stringify(verifyReplayProfileSnapshot.swapTargets) !== JSON.stringify(CURRENT_BUNDLE_SWAP_TARGETS)
) {
  throw new Error('replay profile snapshot swapTargets do not match materialized L refs');
}

function applyPermutationSwapTrace(basePermTable, swapTargets) {
  if (!Array.isArray(basePermTable) || !Array.isArray(swapTargets)) {
    throw new Error('basePermTable and swapTargets must be arrays');
  }
  const perm = basePermTable.slice();
  if (perm.length !== swapTargets.length) {
    throw new Error(`perm/swap length mismatch: perm=${perm.length} swaps=${swapTargets.length}`);
  }
  for (let index = 0; index < swapTargets.length; index += 1) {
    const target = Number(swapTargets[index]);
    if (!Number.isInteger(target) || target < 0 || target >= perm.length) {
      throw new Error(`invalid swap target at index ${index}: ${swapTargets[index]}`);
    }
    if (target !== index) {
      const tmp = perm[index];
      perm[index] = perm[target];
      perm[target] = tmp;
    }
  }
  return perm;
}

const CURRENT_BUNDLE_INITIAL_PERM_TABLE = applyPermutationSwapTrace(
  CURRENT_BUNDLE_BASE_PERM_TABLE,
  CURRENT_BUNDLE_SWAP_TARGETS,
);

function getCurrentBundleReplayProfile() {
  return {
    keyHex: CURRENT_BUNDLE_VERIFY_KEY_HEX,
    basePermTable: CURRENT_BUNDLE_BASE_PERM_TABLE.slice(),
    swapTargets: CURRENT_BUNDLE_SWAP_TARGETS.slice(),
    initialPermTable: CURRENT_BUNDLE_INITIAL_PERM_TABLE.slice(),
    initialVmState: { ...CURRENT_BUNDLE_INITIAL_VM_STATE },
  };
}

function transformRuntimeSeedToRaw(runtimeSeedBase64Like, permTable, initialState = {}) {
  const o = String(runtimeSeedBase64Like || '');
  const r = Array.isArray(permTable) ? permTable.slice() : null;
  if (!o || !r || r.length === 0) {
    throw new Error('missing runtimeSeedBase64Like or permTable');
  }
  const mask = r.length - 1;
  let n = 0;
  let e = Number.isFinite(initialState.e) ? initialState.e & mask : 0;
  let a = Number.isFinite(initialState.a) ? initialState.a & mask : 0;
  let t = typeof initialState.t === 'string' ? initialState.t : '';
  while (n < o.length) {
    a = ((e ^ a) + (r[e] ^ r[a])) & mask;
    if (e !== a) {
      const tmp = r[e];
      r[e] = r[a];
      r[a] = tmp;
    }
    let m = o.charCodeAt(n);
    m = m + e + r[e];
    m = m - (a + r[a]);
    m = m ^ (r[e] + r[a]);
    m = m ^ r[(r[e] + r[a]) & mask];
    m = m & 255;
    t += String.fromCharCode(m);
    e = (e + 1) & mask;
    n += 1;
  }
  return t;
}

function encodeRuntimeSeedToFinalData(runtimeSeedBase64Like, permTable, initialState = {}) {
  return Buffer.from(
    transformRuntimeSeedToRaw(runtimeSeedBase64Like, permTable, initialState),
    'latin1',
  ).toString('base64');
}

function encodeRuntimeSeedToFinalDataForCurrentBundle(runtimeSeedBase64Like) {
  return encodeRuntimeSeedToFinalData(
    runtimeSeedBase64Like,
    CURRENT_BUNDLE_INITIAL_PERM_TABLE,
    CURRENT_BUNDLE_INITIAL_VM_STATE,
  );
}

module.exports = {
  CURRENT_BUNDLE_VERIFY_KEY_HEX,
  CURRENT_BUNDLE_EXPECTED_VM_ARTIFACT_HASHES,
  CURRENT_BUNDLE_BASE_PERM_L_REFS,
  CURRENT_BUNDLE_BASE_PERM_HOLE_REFS,
  CURRENT_BUNDLE_BASE_PERM_TABLE,
  CURRENT_BUNDLE_SWAP_TARGET_Q_SOURCE_INDEXES,
  CURRENT_BUNDLE_Q_SOURCE_INDEX_STATIC_CANDIDATES,
  CURRENT_BUNDLE_Q_SOURCE_INDEX_STATIC_REPORT,
  CURRENT_BUNDLE_SWAP_TARGET_L_REFS,
  CURRENT_BUNDLE_SWAP_TARGET_VALUE_Q_SOURCE_INDEXES,
  CURRENT_BUNDLE_SWAP_TARGETS,
  CURRENT_BUNDLE_INITIAL_PERM_TABLE,
  CURRENT_BUNDLE_INITIAL_VM_STATE,
  materializeHolePatchesFromL,
  materializeValueRefsFromL,
  materializeValuesFromSourceIndexes,
  buildUniqueIndexMap,
  deriveSwapTargetValueQSourceIndexesFromRefQIndexes,
  deriveHoleRefsFromPartialBasePerm,
  buildBasePermTableFromPartial,
  buildCurrentBundleBasePermTable,
  applyPermutationSwapTrace,
  getCurrentBundleReplayProfile,
  transformRuntimeSeedToRaw,
  encodeRuntimeSeedToFinalData,
  encodeRuntimeSeedToFinalDataForCurrentBundle,
};
