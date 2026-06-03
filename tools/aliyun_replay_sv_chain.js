#!/usr/bin/env node
const { FeilinVmRuntime } = require('./feilin_vm_runtime');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function summarizeTrace(snapshot) {
  return {
    assignCount: snapshot?.assignCount ?? null,
    shapeKeys: snapshot?.shape?.keys || null,
    eventTail: Array.isArray(snapshot?.events)
      ? snapshot.events.slice(-10).map((entry) => ({
        type: entry.type || null,
        detail: entry.detail || null,
      }))
      : [],
  };
}

async function safe(label, fn) {
  try {
    const value = await fn();
    return { label, ok: true, value: typeof value === 'string' ? value.slice(0, 300) : value };
  } catch (error) {
    return { label, ok: false, error: String(error && error.stack || error) };
  }
}

async function main() {
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });
  const before = {
    functions: runtime.getWarmupFunctionSnapshot(),
    umTrace: summarizeTrace(runtime.getWindowObjectTraceSnapshot('um')),
    zUmTrace: summarizeTrace(runtime.getWindowObjectTraceSnapshot('z_um')),
  };
  const steps = [];
  steps.push(await safe('callSv', () => runtime.callSv([], runtime.window)));
  steps.push({
    label: 'after-callSv',
    umTrace: summarizeTrace(runtime.getWindowObjectTraceSnapshot('um')),
    zUmTrace: summarizeTrace(runtime.getWindowObjectTraceSnapshot('z_um')),
  });
  steps.push(await safe('promoteSb', () => runtime.promoteRealGetTokenFromSb()));
  steps.push(await safe('computeToken', () => runtime.computeToken()));
  steps.push(await safe('callUy', () => runtime.callUy(runtime.window)));
  console.log(JSON.stringify({ before, steps }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
