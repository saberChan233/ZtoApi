#!/usr/bin/env node
const vm = require('vm');
const snapshot = require('./aliyun_verify_vm_artifacts_snapshot');

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildWindowShim() {
  return {
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Date,
    RegExp,
    Object,
    Array,
    Buffer,
    console,
    encodeURIComponent,
    decodeURIComponent,
    escape,
    unescape,
    parseInt,
    parseFloat,
    isNaN,
  };
}

function createVmContext() {
  const window = buildWindowShim();
  const context = vm.createContext({
    window,
    console,
    Object,
    Array,
    Math,
    String,
    Number,
    Boolean,
    JSON,
    Date,
    RegExp,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    escape,
    unescape,
    Buffer,
    setTimeout,
    clearTimeout,
  });
  return { context, window };
}

function compileCurrentBundleTFunction() {
  const { context, window } = createVmContext();
  const t = vm.runInContext(`(${snapshot.tFunctionSource})`, context, { timeout: 15000 });
  return { t, context, window };
}

function executeCurrentBundleTvm(options = {}) {
  const { t } = compileCurrentBundleTFunction();
  const e = Array.isArray(options.e) ? cloneJson(options.e) : [];
  const r = Array.isArray(options.r) ? cloneJson(options.r) : cloneJson(snapshot.R);
  const i = Array.isArray(options.i) ? cloneJson(options.i) : cloneJson(snapshot.q);
  const a = options.a && typeof options.a === 'object' ? cloneJson(options.a) : {};
  const o = Array.isArray(options.o) ? cloneJson(options.o) : [];
  const n = Number.isInteger(options.n) ? options.n : 0;
  let result = null;
  let error = null;
  try {
    result = t(n, e, r, i, a, o);
  } catch (err) {
    error = err;
  }
  return {
    ok: !error,
    result,
    error: error ? String(error && error.stack || error) : null,
    finalStack: e,
    finalState: a,
  };
}

if (require.main === module) {
  console.log(JSON.stringify(executeCurrentBundleTvm(), null, 2));
} else {
  module.exports = {
    buildWindowShim,
    createVmContext,
    compileCurrentBundleTFunction,
    executeCurrentBundleTvm,
  };
}
