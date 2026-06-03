#!/usr/bin/env node
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const {
  extractArrayRefsBuiltByOpcode55,
} = require('./aliyun_verify_vm_artifacts');
const {
  CURRENT_BUNDLE_SWAP_TARGET_L_REFS,
  CURRENT_BUNDLE_BASE_PERM_L_REFS,
} = require('./aliyun_verify_data_vm_replay');

function longestCommonPrefix(a, b) {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) {
    count += 1;
  }
  return count;
}

function longestCommonSuffix(a, b) {
  let count = 0;
  while (
    count < a.length &&
    count < b.length &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

function countSubsequenceHits(needle, haystack) {
  let cursor = 0;
  for (const value of haystack) {
    if (cursor < needle.length && value === needle[cursor]) {
      cursor += 1;
    }
  }
  return cursor;
}

function scanProgram(name, program, targetRefs) {
  return extractArrayRefsBuiltByOpcode55(program)
    .map((row) => {
      const refs = row.refs;
      return {
        program: name,
        index: row.index,
        len: row.len,
        refsLength: refs.length,
        prefixMatch: longestCommonPrefix(refs, targetRefs),
        suffixMatch: longestCommonSuffix(refs, targetRefs),
        subsequenceHits: countSubsequenceHits(refs, targetRefs),
        reverseSubsequenceHits: countSubsequenceHits(targetRefs, refs),
        refsHead: refs.slice(0, 12),
        refsTail: refs.slice(-12),
      };
    })
    .sort((left, right) =>
      right.prefixMatch - left.prefixMatch ||
      right.suffixMatch - left.suffixMatch ||
      right.subsequenceHits - left.subsequenceHits ||
      right.refsLength - left.refsLength
    );
}

function main() {
  const target = process.argv[2] === 'base-perm'
    ? (CURRENT_BUNDLE_BASE_PERM_L_REFS || [])
    : CURRENT_BUNDLE_SWAP_TARGET_L_REFS;
  const label = process.argv[2] === 'base-perm' ? 'base-perm' : 'swap-target';
  const rows = [
    ...scanProgram('j', snapshot.j || [], target),
    ...scanProgram('R', snapshot.R || [], target),
  ];
  console.log(JSON.stringify({
    target: label,
    targetLength: target.length,
    top: rows.slice(0, 20),
  }, null, 2));
}

main();
