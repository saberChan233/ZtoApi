#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SNAPSHOT_PATH = path.join(__dirname, 'aliyun_verify_vm_artifacts_snapshot.js');

function normalizeExistingFile(filePath) {
  if (!filePath) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return fs.existsSync(abs) ? abs : null;
}

function readBundleSource(options = {}) {
  const candidates = [
    options.bundlePath,
    ...(Array.isArray(options.files) ? options.files : []),
    '/tmp/aliyun-pe.js',
  ];
  for (const file of candidates) {
    const normalized = normalizeExistingFile(file);
    if (normalized) {
      return {
        bundlePath: normalized,
        source: fs.readFileSync(normalized, 'utf8'),
      };
    }
  }
  throw new Error('missing aliyun bundle source');
}

function extractBracketLiteral(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const openIndex = source.indexOf('[', start);
  let depth = 0;
  let inString = null;
  let escapeNext = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let idx = openIndex; idx < source.length; idx += 1) {
    const ch = source[idx];
    const next = source[idx + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        idx += 1;
      }
      continue;
    }
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
    if (ch === '/' && next === '/') {
      inLineComment = true;
      idx += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      idx += 1;
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex, idx + 1);
      }
    }
  }
  throw new Error(`unterminated array literal for marker: ${marker}`);
}

function extractFunctionSource(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`function marker not found: ${marker}`);
  const funcStart = source.indexOf('function', start);
  const braceStart = source.indexOf('{', funcStart);
  let depth = 0;
  let inString = null;
  let escapeNext = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let idx = braceStart; idx < source.length; idx += 1) {
    const ch = source[idx];
    const next = source[idx + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        idx += 1;
      }
      continue;
    }
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
    if (ch === '/' && next === '/') {
      inLineComment = true;
      idx += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      idx += 1;
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(funcStart, idx + 1);
      }
    }
  }
  throw new Error(`unterminated function for marker: ${marker}`);
}

function extractStatementWithAnchor(source, anchor, terminator = ';') {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`statement anchor not found: ${anchor}`);
  const end = source.indexOf(terminator, start);
  if (end < 0) throw new Error(`statement terminator not found for anchor: ${anchor}`);
  return source.slice(start, end + terminator.length);
}

function extractBetweenAnchors(source, startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  if (start < 0) throw new Error(`start anchor not found: ${startAnchor}`);
  const end = source.indexOf(endAnchor, start);
  if (end < 0) throw new Error(`end anchor not found for start anchor: ${startAnchor}`);
  return source.slice(start, end);
}

function evalArrayLiteral(literal) {
  return vm.runInNewContext(literal);
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex');
}

function extractArrayRefsBuiltByOpcode55(program) {
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
    rows.push({
      index,
      len,
      refs,
    });
  }
  return rows;
}

function deriveBasePermProfileFromJ(jValues, lValues) {
  const candidates = extractArrayRefsBuiltByOpcode55(jValues)
    .map((row) => ({
      ...row,
      values: row.refs.map((ref) => lValues[ref]),
    }))
    .filter((row) =>
      row.len === 64 &&
      row.refs.length === 64 &&
      row.values.every((value) => Number.isInteger(value)) &&
      new Set(row.values).size === 64 &&
      Math.min(...row.values) === 0 &&
      Math.max(...row.values) === 63
    );
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one basePerm candidate in j, got ${candidates.length}`);
  }
  return {
    basePermLRefs: candidates[0].refs.slice(),
    basePerm: candidates[0].values.slice(),
    basePermSourceIndex: candidates[0].index,
  };
}

function extractArtifactsFromSource(source) {
  const jLiteral = extractBracketLiteral(source, 'j=[');
  const lLiteral = extractBracketLiteral(source, 'L=[');
  const rLiteral = extractBracketLiteral(source, 'R=[');
  const qLiteral = extractBracketLiteral(source, 'q=[');
  const tFunctionSource = extractFunctionSource(source, 'function t(n,e,r,i,a,o){');
  const gCallsiteSource = extractStatementWithAnchor(source, 'nx=x.w(G,0,[],R,q,eW,[');
  const eWInitSource = extractBetweenAnchors(
    source,
    'var ej=0,eL=0,eR="",eq="",eD=0,eV=document,eF=window,eW={};',
    'var eH,eZ,eQ,eY,eJ,eK,eX,e$,e1,e3=Q(eW)',
  );
  const j = evalArrayLiteral(jLiteral);
  const L = evalArrayLiteral(lLiteral);
  const R = evalArrayLiteral(rLiteral);
  const q = evalArrayLiteral(qLiteral);
  const argumentsIndex = L.indexOf('arguments');
  const lengthIndex = L.indexOf('length', argumentsIndex >= 0 ? argumentsIndex : 0);
  const partialBasePerm = argumentsIndex >= 0 && lengthIndex > argumentsIndex
    ? L.slice(argumentsIndex + 2, lengthIndex)
    : [];
  const {
    basePermLRefs,
    basePerm,
    basePermSourceIndex,
  } = deriveBasePermProfileFromJ(j, L);
  return {
    j,
    L,
    R,
    q,
    partialBasePerm,
    basePermLRefs,
    basePerm,
    basePermSourceIndex,
    gCallsiteSource,
    eWInitSource,
    tFunctionSource,
    hashes: {
      j: sha1(jLiteral),
      L: sha1(lLiteral),
      R: sha1(rLiteral),
      q: sha1(qLiteral),
      t: sha1(tFunctionSource),
    },
  };
}

function extractVerifyVmArtifacts(options = {}) {
  const { bundlePath, source } = readBundleSource(options);
  const artifacts = extractArtifactsFromSource(source);
  return {
    bundlePath,
    ...artifacts,
  };
}

function writeArtifactsSnapshot(options = {}) {
  const extracted = extractVerifyVmArtifacts(options);
  const outputPath = options.outputPath
    ? path.isAbsolute(options.outputPath) ? options.outputPath : path.join(process.cwd(), options.outputPath)
    : SNAPSHOT_PATH;
  const content = `// Generated from ${path.basename(extracted.bundlePath)} verify VM artifacts\n` +
    `module.exports = ${JSON.stringify({
      bundlePath: extracted.bundlePath,
      hashes: extracted.hashes,
      partialBasePerm: extracted.partialBasePerm,
      basePermLRefs: extracted.basePermLRefs,
      basePerm: extracted.basePerm,
      basePermSourceIndex: extracted.basePermSourceIndex,
      j: extracted.j,
      L: extracted.L,
      R: extracted.R,
      q: extracted.q,
      gCallsiteSource: extracted.gCallsiteSource,
      eWInitSource: extracted.eWInitSource,
      tFunctionSource: extracted.tFunctionSource,
    }, null, 2)};\n`;
  fs.writeFileSync(outputPath, content);
  return {
    outputPath,
    bundlePath: extracted.bundlePath,
    bytes: Buffer.byteLength(content),
    hashes: extracted.hashes,
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--write-snapshot') {
    const outputPath = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
    console.log(JSON.stringify(writeArtifactsSnapshot({ outputPath }), null, 2));
  } else {
    const extracted = extractVerifyVmArtifacts({
      bundlePath: argv[0] || undefined,
    });
    console.log(JSON.stringify({
      bundlePath: extracted.bundlePath,
      hashes: extracted.hashes,
      jLength: extracted.j.length,
      lLength: extracted.L.length,
      rLength: extracted.R.length,
      qLength: extracted.q.length,
      partialBasePermLength: extracted.partialBasePerm.length,
      partialBasePerm: extracted.partialBasePerm,
      basePermLRefsLength: extracted.basePermLRefs.length,
      basePermLRefsHead: extracted.basePermLRefs.slice(0, 16),
      basePermHead: extracted.basePerm.slice(0, 16),
      basePermTail: extracted.basePerm.slice(-8),
      basePermSourceIndex: extracted.basePermSourceIndex,
      rHead: extracted.R.slice(0, 48),
      qHead: extracted.q.slice(0, 48),
      gCallsitePreview: extracted.gCallsiteSource.slice(0, 400),
      eWInitPreview: extracted.eWInitSource.slice(0, 400),
      tFunctionPreview: extracted.tFunctionSource.slice(0, 600),
    }, null, 2));
  }
} else {
  module.exports = {
    SNAPSHOT_PATH,
    readBundleSource,
    extractBracketLiteral,
    extractFunctionSource,
    extractStatementWithAnchor,
    extractBetweenAnchors,
    extractArrayRefsBuiltByOpcode55,
    deriveBasePermProfileFromJ,
    extractArtifactsFromSource,
    extractVerifyVmArtifacts,
    writeArtifactsSnapshot,
  };
}
