#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { encodeRuntimeSeedWithBundledDeflate } = require('./aliyun_bundle_deflate');

const {
  CURRENT_BUNDLE_VERIFY_KEY_HEX,
  CURRENT_BUNDLE_INITIAL_PERM_TABLE,
  CURRENT_BUNDLE_INITIAL_VM_STATE,
  encodeRuntimeSeedToFinalData,
  encodeRuntimeSeedToFinalDataForCurrentBundle,
} = require('./aliyun_verify_data_vm_replay');

function buildVerifyDataSeed(prefixHex, payload) {
  if (typeof prefixHex !== 'string' || !/^[0-9a-f]{32}$/i.test(prefixHex)) {
    throw new Error('prefixHex must be a 32-char hex string');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be a plain object');
  }
  return `${prefixHex}${JSON.stringify(payload)}`;
}

function normalizeExistingFile(filePath) {
  if (!filePath) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return fs.existsSync(abs) ? abs : null;
}

function getDefaultBundleFiles() {
  return [
    normalizeExistingFile('/tmp/feilin.js'),
    normalizeExistingFile('/tmp/aliyun-pe.js'),
    normalizeExistingFile('/tmp/AliyunCaptcha.js'),
  ].filter(Boolean);
}

const helperRuntimeCache = new Map();

function createNoopRecorder() {
  return {
    push() {},
    all() {
      return [];
    },
  };
}

function createVerifyHelperRuntime(options = {}) {
  const files = Array.isArray(options.files) && options.files.length > 0
    ? options.files.map((file) => normalizeExistingFile(file)).filter(Boolean)
    : getDefaultBundleFiles();
  if (!files.length) {
    throw new Error('missing bundle files for verify helper runtime');
  }
  const cacheKey = JSON.stringify(files);
  const cached = helperRuntimeCache.get(cacheKey);
  if (cached) return cached;

  const vm = require('vm');
  const {
    createContext,
    patchAliyunCaptchaSource,
  } = require('./probe_feilin_runtime');
  const { context, window } = createContext(createNoopRecorder(), {
    patchAliyunOptions: {
      exposeReverseHelpers: true,
    },
  });
  for (const file of files) {
    const source = patchAliyunCaptchaSource(fs.readFileSync(file, 'utf8'), {
      exposeReverseHelpers: true,
    });
    vm.runInContext(source, context, { timeout: 15000, filename: file });
  }
  const helpers = window.__ALIYUN_VERIFY_HELPERS__;
  if (!helpers || typeof helpers.K !== 'function') {
    throw new Error('failed to expose __ALIYUN_VERIFY_HELPERS__.K');
  }
  const runtime = { files, window, K: helpers.K, tC: helpers.tC };
  helperRuntimeCache.set(cacheKey, runtime);
  return runtime;
}

function encodeRuntimeSeedFromSeedPureLocal(seed, options = {}) {
  if (typeof seed !== 'string' || !seed) {
    throw new Error('seed must be a non-empty string');
  }
  return encodeRuntimeSeedWithBundledDeflate(seed, options);
}

function encodeRuntimeSeedFromSeed(seed, options = {}) {
  if (typeof seed !== 'string' || !seed) {
    throw new Error('seed must be a non-empty string');
  }
  if (!options.forceRuntimeHelper) {
    try {
      return encodeRuntimeSeedFromSeedPureLocal(seed, options);
    } catch (error) {
      if (!options.allowHelperFallback) {
        throw error;
      }
    }
  }
  const runtime = createVerifyHelperRuntime(options);
  return runtime.K(seed);
}

function inverseTransformRawToRuntimeSeed(rawBinary, permTable, initialState = {}) {
  const input = String(rawBinary || '');
  const r = Array.isArray(permTable) ? permTable.slice() : null;
  if (!input || !r || r.length === 0) {
    throw new Error('missing rawBinary or permTable');
  }
  const mask = r.length - 1;
  let n = 0;
  let e = Number.isFinite(initialState.e) ? initialState.e & mask : 0;
  let a = Number.isFinite(initialState.a) ? initialState.a & mask : 0;
  let out = '';
  while (n < input.length) {
    a = ((e ^ a) + (r[e] ^ r[a])) & mask;
    if (e !== a) {
      const tmp = r[e];
      r[e] = r[a];
      r[a] = tmp;
    }
    const transformed = input.charCodeAt(n) & 255;
    let original = transformed ^ r[(r[e] + r[a]) & mask];
    original = original ^ ((r[e] + r[a]) & 255);
    original = (original + (a + r[a]) - (e + r[e])) & 255;
    out += String.fromCharCode(original);
    e = (e + 1) & mask;
    n += 1;
  }
  return out;
}

function decodeRuntimeSeedToSeedString(runtimeSeedBase64Like) {
  if (typeof runtimeSeedBase64Like !== 'string' || !runtimeSeedBase64Like) {
    throw new Error('runtimeSeedBase64Like must be a non-empty string');
  }
  const compressed = Buffer.from(runtimeSeedBase64Like, 'base64');
  return zlib.inflateSync(compressed).toString('utf8');
}

function decodeVerifyDataToSeed(finalDataBase64, options = {}) {
  if (typeof finalDataBase64 !== 'string' || !finalDataBase64) {
    throw new Error('finalDataBase64 must be a non-empty string');
  }
  const permTable = options.bundleProfile?.initialPermTable || CURRENT_BUNDLE_INITIAL_PERM_TABLE;
  const initialVmState = options.bundleProfile?.initialVmState || CURRENT_BUNDLE_INITIAL_VM_STATE;
  const rawBinary = Buffer.from(finalDataBase64, 'base64').toString('latin1');
  const runtimeSeedBase64Like = inverseTransformRawToRuntimeSeed(rawBinary, permTable, initialVmState);
  const seedString = decodeRuntimeSeedToSeedString(runtimeSeedBase64Like);
  const seedPrefix = /^[0-9a-f]{32}/i.test(seedString) ? seedString.slice(0, 32) : null;
  const seedJson = seedPrefix ? seedString.slice(32) : seedString;
  let seedJsonParsed = null;
  try {
    seedJsonParsed = JSON.parse(seedJson);
  } catch {
    seedJsonParsed = null;
  }
  return {
    finalDataBase64,
    rawBinary,
    runtimeSeedBase64Like,
    seedString,
    seedPrefix,
    seedJson,
    seedJsonParsed,
  };
}

function encodeVerifyDataFromSeed(seed, options = {}) {
  const runtimeSeedBase64Like = encodeRuntimeSeedFromSeed(seed, options);
  if (options.bundleProfile?.initialPermTable) {
    return encodeRuntimeSeedToFinalData(
      runtimeSeedBase64Like,
      options.bundleProfile.initialPermTable,
      options.bundleProfile.initialVmState || CURRENT_BUNDLE_INITIAL_VM_STATE,
    );
  }
  return encodeRuntimeSeedToFinalDataForCurrentBundle(runtimeSeedBase64Like);
}

function encodeVerifyDataFromSeedPureLocal(seed, options = {}) {
  const runtimeSeedBase64Like = encodeRuntimeSeedFromSeedPureLocal(seed, options);
  if (options.bundleProfile?.initialPermTable) {
    return encodeRuntimeSeedToFinalData(
      runtimeSeedBase64Like,
      options.bundleProfile.initialPermTable,
      options.bundleProfile.initialVmState || CURRENT_BUNDLE_INITIAL_VM_STATE,
    );
  }
  return encodeRuntimeSeedToFinalDataForCurrentBundle(runtimeSeedBase64Like);
}

function encodeVerifyData(prefixHex, payload, options = {}) {
  return encodeVerifyDataFromSeed(buildVerifyDataSeed(prefixHex, payload), options);
}

function encodeVerifyDataPureLocal(prefixHex, payload, options = {}) {
  return encodeVerifyDataFromSeedPureLocal(buildVerifyDataSeed(prefixHex, payload), options);
}

if (require.main === module) {
  const [, , prefixHex, payloadJson] = process.argv;
  if (!prefixHex || !payloadJson) {
    console.error('usage: aliyun_verify_data_local.js <prefixHex> <payloadJson>');
    process.exit(1);
  }
  console.log(encodeVerifyData(prefixHex, JSON.parse(payloadJson)));
} else {
  module.exports = {
    CURRENT_BUNDLE_VERIFY_KEY_HEX,
    CURRENT_BUNDLE_INITIAL_PERM_TABLE,
    CURRENT_BUNDLE_INITIAL_VM_STATE,
    buildVerifyDataSeed,
    createVerifyHelperRuntime,
    encodeRuntimeSeedFromSeedPureLocal,
    encodeRuntimeSeedFromSeed,
    inverseTransformRawToRuntimeSeed,
    decodeRuntimeSeedToSeedString,
    decodeVerifyDataToSeed,
    encodeVerifyDataFromSeedPureLocal,
    encodeVerifyDataFromSeed,
    encodeVerifyDataPureLocal,
    encodeVerifyData,
  };
}
