#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function slimTrace(snapshot) {
  if (!snapshot) return null;
  return {
    assignCount: snapshot.assignCount ?? null,
    shapeKeys: snapshot.shape?.keys || null,
    events: Array.isArray(snapshot.events)
      ? snapshot.events.slice(-12).map((entry) => ({
        type: entry.type || null,
        detail: entry.detail || null,
      }))
      : [],
  };
}

function slimShape(shape) {
  if (!shape) return null;
  return {
    keys: shape.keys || null,
    preview: shape.preview || null,
  };
}

function slimState(state) {
  if (!state) return null;
  return {
    umTrace: slimTrace(state.umTrace),
    zUmTrace: slimTrace(state.zUmTrace),
    umShape: slimShape(state.umShape),
    zUmShape: slimShape(state.zUmShape),
    aliyunInitState: slimShape(state.aliyunInitState),
    aliyunPrecollect: slimShape(state.aliyunPrecollect),
    feilinRe: slimShape(state.feilinRe),
    localStorageKeys: state.localStorageKeys || [],
  };
}

async function buildDirect() {
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });
  return slimState(runtime.snapshotInterestingState());
}

async function buildAutoInit() {
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });
  const autoInit = await runtime.bootstrapAliyunCaptcha();
  return {
    autoInit,
    state: slimState(runtime.snapshotInterestingState()),
  };
}

async function buildProbe() {
  const out = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  return {
    umObjectSnapshot: {
      assignCount: out.umObjectSnapshot?.assignCount ?? null,
      shapeKeys: out.umObjectSnapshot?.shape?.keys || null,
      events: Array.isArray(out.umObjectSnapshot?.events)
        ? out.umObjectSnapshot.events.slice(-12).map((entry) => ({
          type: entry.type || null,
          detail: entry.detail || null,
        }))
        : [],
    },
    zUmObjectSnapshot: {
      assignCount: out.zUmObjectSnapshot?.assignCount ?? null,
      shapeKeys: out.zUmObjectSnapshot?.shape?.keys || null,
      events: Array.isArray(out.zUmObjectSnapshot?.events)
        ? out.zUmObjectSnapshot.events.slice(-12).map((entry) => ({
          type: entry.type || null,
          detail: entry.detail || null,
        }))
        : [],
    },
    aliyunInitStateSnapshot: slimShape(out.aliyunInitStateSnapshot),
    aliyunPrecollectSnapshot: slimShape(out.aliyunPrecollectSnapshot),
    getTokenType: out.getTokenType || null,
    getTokenSourcePreview: out.getTokenSourcePreview || null,
    getTokenValuePreview: out.getTokenValuePreview || null,
    getTokenDecodedPreview: out.getTokenDecodedPreview || null,
    postAutoInitGetTokenValuePreview: out.postAutoInitGetTokenValuePreview || null,
    postAutoInitGetTokenDecodedPreview: out.postAutoInitGetTokenDecodedPreview || null,
    autoInit: out.autoInit || null,
  };
}

async function main() {
  const [direct, autoInit, probe] = await Promise.all([
    buildDirect(),
    buildAutoInit(),
    buildProbe(),
  ]);
  console.log(JSON.stringify({
    direct,
    autoInit,
    probe,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
