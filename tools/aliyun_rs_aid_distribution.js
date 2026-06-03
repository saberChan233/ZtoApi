#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function classify(row) {
  if (!row || typeof row.arg0 !== 'string' || typeof row.arg1 !== 'string') return null;
  if (typeof row.outputString === 'string' && row.outputString !== 'null') return 'success';
  if (row.outputString === 'null') return 'null';
  return 'other';
}

function pushGrouped(map, key, row) {
  if (!map[key]) {
    map[key] = {
      count: 0,
      samples: [],
    };
  }
  map[key].count += 1;
  if (map[key].samples.length < 5) {
    map[key].samples.push({
      arg0: row.arg0,
      arg1Length: row.arg1Length || (typeof row.arg1 === 'string' ? row.arg1.length : null),
      arg1Head: typeof row.arg1 === 'string' ? row.arg1.slice(0, 180) : null,
      outputStringHead: typeof row.outputString === 'string' ? row.outputString.slice(0, 120) : null,
      innerStages: row.innerStages || null,
      lastAId: row.lastAId ?? null,
    });
  }
}

async function main() {
  const out = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const rows = Array.isArray(out.feilinRsLogs) ? out.feilinRsLogs : [];
  const selectorLogs = Array.isArray(out.feilinRsSelectorLogs) ? out.feilinRsSelectorLogs : [];

  const byKindAid = {};
  const byAid = {};
  for (const row of rows) {
    const kind = classify(row);
    if (!kind) continue;
    const aid = row.lastAId == null ? 'null-aid' : String(row.lastAId);
    const compound = `${kind}:${aid}`;
    pushGrouped(byKindAid, compound, row);
    pushGrouped(byAid, aid, row);
  }

  const selectorByOutSource = {};
  for (const row of selectorLogs) {
    const key = `${row?.stage || 'unknown'}:${row?.outType || typeof row?.outSource}:${typeof row?.outSource === 'string' ? row.outSource.slice(0, 80) : String(row?.outSource)}`;
    if (!selectorByOutSource[key]) {
      selectorByOutSource[key] = { count: 0, samples: [] };
    }
    selectorByOutSource[key].count += 1;
    if (selectorByOutSource[key].samples.length < 5) {
      selectorByOutSource[key].samples.push({
        raKey: row?.raKey || null,
        arg0: row?.arg0 || null,
        arg1Length: row?.arg1Length ?? null,
        outType: row?.outType || null,
      });
    }
  }

  console.log(JSON.stringify({
    totalRsLogs: rows.length,
    totalSelectorLogs: selectorLogs.length,
    byKindAid,
    byAid,
    selectorByOutSource,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
