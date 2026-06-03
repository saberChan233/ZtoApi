#!/usr/bin/env node
const fs = require('fs');
const vm = require('vm');

function extractFunctionSource(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let inString = null;
  let escapeNext = false;
  for (let idx = braceStart; idx < source.length; idx += 1) {
    const ch = source[idx];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, idx + 1);
    }
  }
  throw new Error(`unterminated function for marker: ${marker}`);
}

function loadNrDecoder(bundlePath = '/tmp/aliyun-pe.js') {
  const source = fs.readFileSync(bundlePath, 'utf8');
  const nrSource = extractFunctionSource(source, 'function nr(t,n){');
  const context = vm.createContext({
    decodeURIComponent,
    parseInt,
    String,
    Array,
    Object,
    JSON,
  });
  const nr = vm.runInContext(`(${nrSource})`, context, { timeout: 15000 });
  return {
    bundlePath,
    nrSource,
    decode(index, key) {
      return nr(index, key);
    },
    safeDecode(index, key) {
      try {
        return { ok: true, value: nr(index, key) };
      } catch (error) {
        return { ok: false, error: String(error && error.stack || error) };
      }
    },
    to(arg0, arg1) {
      return nr(arg1 - 1, arg0);
    },
    safeTo(arg0, arg1) {
      try {
        return { ok: true, value: nr(arg1 - 1, arg0) };
      } catch (error) {
        return { ok: false, error: String(error && error.stack || error) };
      }
    },
    tm(arg0, arg1) {
      return nr(arg0 - 9, arg1);
    },
    safeTm(arg0, arg1) {
      try {
        return { ok: true, value: nr(arg0 - 9, arg1) };
      } catch (error) {
        return { ok: false, error: String(error && error.stack || error) };
      }
    },
  };
}

function main() {
  const [, , a0, a1] = process.argv;
  const decoder = loadNrDecoder();
  if (a0 !== undefined && a1 !== undefined) {
    const arg0 = Number(a0);
    const arg1 = Number(a1);
    console.log(JSON.stringify({
      arg0,
      arg1,
      to: decoder.safeTo(arg0, arg1),
    }, null, 2));
    return;
  }
  const samples = [
    [58, 217],
    [49, 52],
    [84, 30],
    [33, 89],
    [65, 7],
    [227, 78],
  ];
  console.log(JSON.stringify({
    bundlePath: decoder.bundlePath,
    samples: samples.map(([x, y]) => ({ x, y, to: decoder.safeTo(x, y), tm: decoder.safeTm(x, y) })),
  }, null, 2));
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    extractFunctionSource,
    loadNrDecoder,
  };
}
