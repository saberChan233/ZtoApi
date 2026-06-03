#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function summarizeInnerLogs(rows) {
  const byAid = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const aid = row?.aId ?? 'null';
    if (!byAid.has(aid)) {
      byAid.set(aid, {
        aId: aid,
        stages: {},
        throws: [],
        arg0: row?.arg0 ?? null,
        arg1Length: row?.arg1Length ?? null,
        arg1Head: row?.arg1Head ?? null,
      });
    }
    const item = byAid.get(aid);
    item.stages[row?.stage || 'unknown'] = (item.stages[row?.stage || 'unknown'] || 0) + 1;
    if (row?.stage === 'method-throw') {
      item.throws.push({
        methodKey: row?.methodKey || null,
        error: row?.error || null,
      });
    }
  }
  return [...byAid.values()];
}

function summarizeRsCalls(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    index,
    arg0: row?.arg0 ?? null,
    arg1Length: row?.arg1Length ?? null,
    outputString: row?.outputString ?? null,
    outputDecoded: row?.outputDecoded ?? null,
    lastAId: row?.lastAId ?? null,
    innerLogCount: row?.innerLogCount ?? null,
    innerStages: row?.innerStages ?? null,
    innerThrow: row?.innerThrow
      ? {
        methodKey: row.innerThrow.methodKey || null,
        error: row.innerThrow.error || null,
      }
      : null,
  }));
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  console.log(JSON.stringify({
    rsCalls: summarizeRsCalls(out.feilinRsLogs),
    rsAidMatrix: summarizeInnerLogs(out.feilinRsInnerLogs),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
