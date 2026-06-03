#!/usr/bin/env node
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const DEFAULT_DEFLATE_MODULE_ID = 4019;
const deflaterCache = new Map();
const SNAPSHOT_MODULE_PATH = path.join(__dirname, 'aliyun_deflate_module_4019_snapshot.js');

function normalizeExistingFile(filePath) {
  if (!filePath) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return fs.existsSync(abs) ? abs : null;
}

function pickDynamicBundleFile(options = {}) {
  if (options.dynamicPath) {
    return normalizeExistingFile(options.dynamicPath);
  }
  const candidates = [
    ...(Array.isArray(options.files) ? options.files : []),
    '/tmp/aliyun-pe.js',
  ];
  for (const file of candidates) {
    const normalized = normalizeExistingFile(file);
    if (normalized && /aliyun-pe\.js$/i.test(normalized)) {
      return normalized;
    }
  }
  for (const file of candidates) {
    const normalized = normalizeExistingFile(file);
    if (normalized) return normalized;
  }
  return null;
}

function extractWebpackModuleFunction(source, moduleId) {
  const marker = `${moduleId}:function(`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`webpack module ${moduleId} not found`);
  }
  const funcStart = source.indexOf('function(', start);
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
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(funcStart, idx + 1);
      }
    }
  }
  throw new Error(`webpack module ${moduleId} parse failed`);
}

function loadSnapshotDeflater(modulePath = SNAPSHOT_MODULE_PATH) {
  const resolved = normalizeExistingFile(modulePath);
  if (!resolved) {
    throw new Error(`missing deflate snapshot: ${modulePath}`);
  }
  delete require.cache[resolved];
  const exportsObject = require(resolved);
  if (typeof exportsObject?.deflate !== 'function') {
    throw new Error(`snapshot ${resolved} does not export deflate`);
  }
  return {
    bundleFile: resolved,
    moduleId: DEFAULT_DEFLATE_MODULE_ID,
    deflate: exportsObject.deflate,
    exports: exportsObject,
    source: 'snapshot',
  };
}

function writeWebpackDeflateSnapshot(options = {}) {
  const bundleFile = pickDynamicBundleFile(options);
  if (!bundleFile) {
    throw new Error('missing aliyun dynamic bundle for snapshot extraction');
  }
  const moduleId = Number.isInteger(options.moduleId) ? options.moduleId : DEFAULT_DEFLATE_MODULE_ID;
  const outputPath = options.outputPath
    ? path.isAbsolute(options.outputPath) ? options.outputPath : path.join(process.cwd(), options.outputPath)
    : SNAPSHOT_MODULE_PATH;
  const bundleSource = fs.readFileSync(bundleFile, 'utf8');
  const moduleFnSource = extractWebpackModuleFunction(bundleSource, moduleId);
  const content = `// Generated from ${path.basename(bundleFile)} webpack module ${moduleId}\n` +
    'module.exports = (() => {\n' +
    '  const module = { exports: {} };\n' +
    `  (${moduleFnSource})(module, module.exports);\n` +
    '  return module.exports;\n' +
    '})();\n';
  fs.writeFileSync(outputPath, content);
  return {
    bundleFile,
    moduleId,
    outputPath,
    bytes: Buffer.byteLength(content),
  };
}

function loadWebpackDeflater(options = {}) {
  if (!options.forceBundleParse) {
    try {
      const snapshot = loadSnapshotDeflater(options.snapshotPath);
      const cacheKey = `snapshot#${snapshot.bundleFile}`;
      const cachedSnapshot = deflaterCache.get(cacheKey);
      if (cachedSnapshot) return cachedSnapshot;
      deflaterCache.set(cacheKey, snapshot);
      return snapshot;
    } catch {
      // fall through to dynamic bundle parsing
    }
  }
  const bundleFile = pickDynamicBundleFile(options);
  if (!bundleFile) {
    throw new Error('missing aliyun dynamic bundle for deflate extraction');
  }
  const moduleId = Number.isInteger(options.moduleId) ? options.moduleId : DEFAULT_DEFLATE_MODULE_ID;
  const cacheKey = `${bundleFile}#${moduleId}`;
  const cached = deflaterCache.get(cacheKey);
  if (cached) return cached;

  const source = fs.readFileSync(bundleFile, 'utf8');
  const moduleFnSource = extractWebpackModuleFunction(source, moduleId);
  const moduleFn = vm.runInNewContext(`(${moduleFnSource})`, {
    Uint8Array,
    Array,
    Object,
    Math,
    Error,
    String,
    Number,
  });
  const module = { exports: {} };
  moduleFn(module, module.exports);
  if (typeof module.exports?.deflate !== 'function') {
    throw new Error(`webpack module ${moduleId} does not export deflate`);
  }
  const out = {
    bundleFile,
    moduleId,
    deflate: module.exports.deflate,
    exports: module.exports,
    source: 'dynamic-bundle-parse',
  };
  deflaterCache.set(cacheKey, out);
  return out;
}

function encodeRuntimeSeedWithBundledDeflate(seed, options = {}) {
  if (typeof seed !== 'string' || !seed) {
    throw new Error('seed must be a non-empty string');
  }
  const { deflate } = loadWebpackDeflater(options);
  const compressed = deflate(Buffer.from(seed, 'utf8'));
  return Buffer.from(compressed).toString('base64');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--write-snapshot') {
    const outputPath = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
    const result = writeWebpackDeflateSnapshot({ outputPath });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  const seed = argv[0];
  if (!seed) {
    console.error('usage: aliyun_bundle_deflate.js <seed>');
    console.error('   or: aliyun_bundle_deflate.js --write-snapshot [outputPath]');
    process.exit(1);
  }
  console.log(encodeRuntimeSeedWithBundledDeflate(seed));
} else {
  module.exports = {
    DEFAULT_DEFLATE_MODULE_ID,
    SNAPSHOT_MODULE_PATH,
    pickDynamicBundleFile,
    extractWebpackModuleFunction,
    loadSnapshotDeflater,
    writeWebpackDeflateSnapshot,
    loadWebpackDeflater,
    encodeRuntimeSeedWithBundledDeflate,
  };
}
