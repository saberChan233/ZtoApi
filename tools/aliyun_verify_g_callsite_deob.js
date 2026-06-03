#!/usr/bin/env node
const vm = require('vm');
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');
const { buildCurrentBundleHelperChain } = require('./aliyun_verify_bundle_helper_local');

function buildExprRuntime(helperChain) {
  const tm = function tmPlaceholder() {};
  const nr = function nrPlaceholder() {};
  const x = {
    w: (t, n, e, r, i, a, o) => t(n, e, r, i, a, o),
    V: (t, n) => t(n),
    G: (t, n) => t + n,
    s: (t, n, e) => t(n, e),
    C: (t, n) => t & n,
    D: (t, n) => t / n,
    y: (t, n) => t - n,
    u: (t, n) => t | n,
    e: (t, n) => t || n,
    h: (t, n) => t !== n,
    Z: (t, n) => t === n,
    W: (t, n) => t >>> n,
    N: (t, n, e, r) => t(n, e, r),
    k: (t, n) => t != n,
    B: (t, n) => t <= n,
    X: (t, n) => t < n,
    x: (t, n) => t > n,
    E: (t, n) => t << n,
    O: (t, n) => t * n,
    M: (t, n, e, r, i) => t(n, e, r, i),
    U: (t, n) => t && n,
  };

  tm.toString = () => '[tm]';
  nr.toString = () => '[nr]';

  return {
    tm,
    nr,
    x,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    parseInt,
    parseFloat,
    helperChain,
  };
}

function evaluateExpression(expression, runtime) {
  const script = new vm.Script(`(${expression})`);
  const context = vm.createContext(runtime);
  return script.runInContext(context, { timeout: 1000 });
}

function decodeTmCall(helperChain, aExpression, bExpression) {
  const runtime = buildExprRuntime(helperChain);
  const aValue = evaluateExpression(aExpression, runtime);
  const bValue = evaluateExpression(bExpression, runtime);
  const decoded = helperChain.safeDecodeTm(aValue, bValue);
  return {
    aExpression,
    bExpression,
    aValue,
    bValue,
    decoded,
  };
}

function extractTmPairs(source, helperChain) {
  const matches = [];
  const patterns = [
    /x\.s\(tm,([^,]+),([^)]+)\)/g,
    /\(\{0:tm\}\)\[0\]\(([^,]+),([^)]+)\)/g,
    /tm\.apply\([^[]*\[\s*([^,\]]+)\s*,\s*([^\]]+)\]\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const full = match[0];
      if (matches.some((item) => item.full === full)) continue;
      try {
        matches.push({
          full,
          ...decodeTmCall(helperChain, match[1].trim(), match[2].trim()),
        });
      } catch (error) {
        matches.push({
          full,
          aExpression: match[1].trim(),
          bExpression: match[2].trim(),
          error: String(error && error.stack || error),
        });
      }
    }
  }

  const tmPrefix = 'tm(';
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(tmPrefix, cursor);
    if (start === -1) break;
    let depth = 1;
    let splitAt = -1;
    let end = -1;
    for (let index = start + tmPrefix.length; index < source.length; index += 1) {
      const ch = source[index];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      } else if (ch === ',' && depth === 1 && splitAt === -1) {
        splitAt = index;
      }
    }
    cursor = start + tmPrefix.length;
    if (splitAt === -1 || end === -1) continue;
    const full = source.slice(start, end + 1);
    if (matches.some((item) => item.full === full)) continue;
    const aExpression = source.slice(start + tmPrefix.length, splitAt).trim();
    const bExpression = source.slice(splitAt + 1, end).trim();
    try {
      matches.push({
        full,
        ...decodeTmCall(helperChain, aExpression, bExpression),
      });
    } catch (error) {
      matches.push({
        full,
        aExpression,
        bExpression,
        error: String(error && error.stack || error),
      });
    }
  }

  return matches;
}

function replaceTmCalls(source, matches) {
  let out = String(source || '');
  const ordered = matches
    .filter((item) => item.decoded?.ok)
    .sort((a, b) => b.full.length - a.full.length);
  for (const item of ordered) {
    out = out.split(item.full).join(JSON.stringify(item.decoded.value));
  }
  return out;
}

function deobfuscateSource(source, helperChain) {
  const tmPairs = extractTmPairs(source, helperChain);
  const deob = replaceTmCalls(source, tmPairs);
  return {
    original: String(source || ''),
    deob,
    tmPairs,
  };
}

function main() {
  const helperChain = buildCurrentBundleHelperChain('/tmp/aliyun-pe.js');
  const result = deobfuscateSource(snapshot.gCallsiteSource || '', helperChain);
  console.log(JSON.stringify({
    ...result,
    knownSymbols: helperChain.getKnownBundleSymbols(),
  }, null, 2));
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    buildExprRuntime,
    decodeTmCall,
    deobfuscateSource,
    extractTmPairs,
  };
}
