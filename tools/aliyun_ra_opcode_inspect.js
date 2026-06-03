#!/usr/bin/env node
const { FeilinVmRuntime } = require('./feilin_vm_runtime');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

const FILES = {
  feilinPath: '/tmp/feilin.js',
  dynamicPath: '/tmp/aliyun-pe.js',
  loaderPath: '/tmp/AliyunCaptcha.js',
};

function pickSample(report, kind) {
  const rows = Array.isArray(report?.feilinRsLogs) ? report.feilinRsLogs : [];
  if (kind === 'success') {
    return rows.find((row) =>
      typeof row?.outputString === 'string' &&
      row.outputString !== 'null' &&
      typeof row?.arg0 === 'string' &&
      typeof row?.arg1 === 'string') || null;
  }
  return rows.find((row) =>
    row?.outputString === 'null' &&
    typeof row?.arg0 === 'string' &&
    typeof row?.arg1 === 'string') || null;
}

async function main() {
  const out = await solveCaptcha({
    files: [FILES.feilinPath, FILES.dynamicPath, FILES.loaderPath],
    loaderPath: FILES.loaderPath,
  });
  const success = pickSample(out, 'success');
  const nullRow = pickSample(out, 'null');
  if (!success || !nullRow) throw new Error('missing rs samples');

  const runtime = await FeilinVmRuntime.create(FILES);
  const info20 = runtime.inspectRaBinding(20);
  const info19 = runtime.inspectRaBinding(19);
  const successReplay = runtime.replayRs(success.arg0, success.arg1);
  const nullReplay = runtime.replayRs(nullRow.arg0, nullRow.arg1);

  console.log(JSON.stringify({
    opcode20: info20,
    opcode19: info19,
    successSeed: {
      arg0: success.arg0,
      arg1Length: success.arg1Length || success.arg1.length,
      outputHead: typeof success.outputString === 'string' ? success.outputString.slice(0, 120) : null,
    },
    nullSeed: {
      arg0: nullRow.arg0,
      arg1Length: nullRow.arg1Length || nullRow.arg1.length,
      outputString: nullRow.outputString,
    },
    successReplay: typeof successReplay === 'string' ? successReplay.slice(0, 300) : successReplay,
    nullReplay: typeof nullReplay === 'string' ? nullReplay.slice(0, 300) : nullReplay,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
