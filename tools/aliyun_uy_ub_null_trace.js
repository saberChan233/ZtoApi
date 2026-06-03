#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function summarizeUbLog(entry) {
  if (!entry) return null;
  return {
    stage: entry.stage || null,
    arg0: entry.arg0 ?? null,
    arg1Type: entry.arg1Type || null,
    arg1Preview: typeof entry.arg1Preview === 'string' ? entry.arg1Preview.slice(0, 220) : entry.arg1Preview ?? null,
    thisType: entry.thisType || null,
    thisKeys: Array.isArray(entry.thisKeys) ? entry.thisKeys.slice(0, 12) : entry.thisKeys ?? null,
    reKeys: Array.isArray(entry.reKeys) ? entry.reKeys.slice(0, 16) : entry.reKeys ?? null,
    reSessionId: entry.reSessionId || null,
    reSecretKey: entry.reSecretKey || null,
    reDeviceDataKeys: Array.isArray(entry.reDeviceDataKeys) ? entry.reDeviceDataKeys.slice(0, 16) : entry.reDeviceDataKeys ?? null,
    reDeviceConfigKeys: Array.isArray(entry.reDeviceConfigKeys) ? entry.reDeviceConfigKeys.slice(0, 16) : entry.reDeviceConfigKeys ?? null,
    reDeviceDataUrl: entry.reDeviceDataUrl || null,
    reDeviceConfigSession: entry.reDeviceConfigSession || null,
    locationHref: entry.locationHref || null,
    documentCookie: entry.documentCookie || null,
    returnType: entry.returnType || null,
    returnValue: typeof entry.returnValue === 'string' ? entry.returnValue.slice(0, 220) : entry.returnValue ?? null,
    error: entry.error || null,
  };
}

function summarizeUyLog(entry) {
  if (!entry) return null;
  return {
    stage: entry.stage || null,
    ubKey: entry.ubKey || null,
    callKey: entry.callKey || null,
    nType: entry.nType || null,
    callableType: entry.callableType || null,
    value: typeof entry.value === 'string' ? entry.value.slice(0, 220) : entry.value ?? null,
  };
}

async function buildDirectTrace() {
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });
  runtime.window.__FEILIN_UB_LOGS__ = [];
  runtime.window.__FEILIN_UB_ARG100_LOGS__ = [];
  runtime.window.__FEILIN_UB_ERROR_LOGS__ = [];
  runtime.window.__FEILIN_UY_LOGS__ = [];
  let error = null;
  try {
    runtime.callUy(runtime.window);
  } catch (err) {
    error = String(err && err.stack || err);
  }
  return {
    error,
    runtimeFunctions: runtime.getWarmupFunctionSnapshot(),
    uyLogs: (runtime.window.__FEILIN_UY_LOGS__ || []).map(summarizeUyLog),
    ubArg100Logs: (runtime.window.__FEILIN_UB_ARG100_LOGS__ || []).map(summarizeUbLog),
    ubErrorLogs: (runtime.window.__FEILIN_UB_ERROR_LOGS__ || []).map(summarizeUbLog),
    ubTail: (runtime.window.__FEILIN_UB_LOGS__ || []).slice(-6).map(summarizeUbLog),
  };
}

async function buildProbeTrace() {
  const out = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  return {
    uyLogs: (out.feilinUyLogs || []).map(summarizeUyLog),
    ubArg100Logs: (out.feilinUbArg100Logs || []).map(summarizeUbLog),
    ubErrorLogs: (out.feilinUbErrorLogs || []).map(summarizeUbLog),
    ubTail: (out.feilinUbLogs || []).slice(-12).map(summarizeUbLog),
  };
}

async function main() {
  const [direct, probe] = await Promise.all([
    buildDirectTrace(),
    buildProbeTrace(),
  ]);
  console.log(JSON.stringify({
    direct,
    probe,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
