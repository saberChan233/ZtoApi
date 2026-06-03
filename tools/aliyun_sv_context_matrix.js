#!/usr/bin/env node
const { FeilinVmRuntime } = require('./feilin_vm_runtime');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function trimLogs(rows, limit = 12) {
  return Array.isArray(rows) ? rows.slice(-limit) : rows || [];
}

function summarizeTrace(snapshot) {
  return {
    assignCount: snapshot?.assignCount ?? null,
    shapeKeys: snapshot?.shape?.keys || null,
    events: Array.isArray(snapshot?.events)
      ? snapshot.events.slice(-8).map((entry) => ({
        type: entry?.type || null,
        detail: entry?.detail || null,
      }))
      : [],
  };
}

async function runCase(label, thisArg, args) {
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });
  const before = {
    umTrace: summarizeTrace(runtime.getWindowObjectTraceSnapshot('um')),
    zUmTrace: summarizeTrace(runtime.getWindowObjectTraceSnapshot('z_um')),
  };
  try {
    const value = await Promise.resolve(runtime.callSv(args, thisArg));
    return {
      label,
      ok: true,
      returnType: typeof value,
      returnPreview: typeof value === 'string' ? value.slice(0, 400) : value == null ? value : String(value).slice(0, 400),
      before,
      after: {
        umTrace: summarizeTrace(runtime.getWindowObjectTraceSnapshot('um')),
        zUmTrace: summarizeTrace(runtime.getWindowObjectTraceSnapshot('z_um')),
        svLogs: trimLogs(runtime.window.__FEILIN_SV_LOGS__),
        pLogs: trimLogs(runtime.window.__FEILIN_P_LOGS__, 24),
        umRealSetLogs: trimLogs(runtime.window.__FEILIN_UM_REAL_SET_LOGS__, 24),
      },
    };
  } catch (error) {
    return {
      label,
      ok: false,
      error: String(error && error.stack || error),
      before,
      after: {
        umTrace: summarizeTrace(runtime.getWindowObjectTraceSnapshot('um')),
        zUmTrace: summarizeTrace(runtime.getWindowObjectTraceSnapshot('z_um')),
        svLogs: trimLogs(runtime.window.__FEILIN_SV_LOGS__),
        pLogs: trimLogs(runtime.window.__FEILIN_P_LOGS__, 24),
        umRealSetLogs: trimLogs(runtime.window.__FEILIN_UM_REAL_SET_LOGS__, 24),
      },
    };
  }
}

async function main() {
  const base = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });
  const cases = [
    ['window/no-args', base.window, []],
    ['window/logs-arg', base.window, [{ logs: [] }]],
    ['logs-this/no-args', { logs: [] }, []],
    ['logs-this/logs-arg', { logs: [] }, [{ logs: [] }]],
    ['captcha-like-arg', base.window, [{
      logs: [],
      captchaVerifyCallback() {},
      onBizResultCallback() {},
      success() {},
      fail() {},
    }]],
  ];
  const rows = [];
  for (const [label, thisArg, args] of cases) {
    rows.push(await runCase(label, thisArg, args));
  }
  console.log(JSON.stringify(rows, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error && error.stack || error));
    process.exit(1);
  });
}
