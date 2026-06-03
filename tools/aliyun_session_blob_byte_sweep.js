#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function pickPart(row, name) {
  return (row?.n0PartLogs || []).find((item) => item?.name === name) || null;
}

function summarizeRow(label, row, offset = null, mode = null) {
  const tA = pickPart(row, 'tA');
  return {
    label,
    offset,
    mode,
    sharedPrefixWithSecret: row?.sharedPrefixWithSecret ?? null,
    uyReturn: row?.intermediates?.uyReturn || null,
    second: row?.parsed?.second || null,
    secondLen: row?.parsed?.second ? String(row.parsed.second).length : 0,
    thirdLen: row?.parsed?.third ? String(row.parsed.third).length : 0,
    fifth: row?.parsed?.fifth || null,
    tACPreview: tA?.CPreview || row?.sessionIdBase64Preview || null,
    directRxOutput: row?.directRxAfterToken?.output || null,
    error: row?.error || null,
  };
}

function classifyEffect(row, baseline) {
  if (row.error) return 'error';
  if (row.uyReturn !== baseline.uyReturn && row.second === baseline.second) return 'uy-only';
  if (row.uyReturn === baseline.uyReturn && row.second !== baseline.second) return 'second-only';
  if (row.uyReturn !== baseline.uyReturn && row.second !== baseline.second) return 'uy+second';
  return 'no-change';
}

async function captureCustomRow(baseOptions, sessionBuf) {
  const out = await solveCaptcha({
    ...baseOptions,
    customSessionIdBlobBase64: sessionBuf.toString('base64'),
  });
  return out.customSessionIdBlobResult || null;
}

async function main() {
  const baseOptions = {
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  };
  const start = Number(getArg('--start', '32'));
  const end = Number(getArg('--end', '48'));
  const mode = String(getArg('--mode', 'flip')); // flip | zero
  const limit = Number(getArg('--limit', '0'));

  const base = await solveCaptcha({
    ...baseOptions,
    sessionIdBlobExperiment: true,
  });
  const exp = base.sessionIdBlobExperiment || {};
  const baseline = exp.baseline;
  const sessionIdBase64 = pickPart(baseline, 'tA')?.CPreview || null;
  if (!sessionIdBase64) {
    throw new Error('missing baseline sessionIdBase64');
  }
  const sessionBuf = Buffer.from(sessionIdBase64, 'base64');
  const rows = [];
  let count = 0;
  for (let offset = start; offset < Math.min(end, sessionBuf.length); offset += 1) {
    if (limit > 0 && count >= limit) break;
    const next = Buffer.from(sessionBuf);
    if (mode === 'zero') {
      next[offset] = 0;
    } else {
      next[offset] = next[offset] ^ 0xff;
    }
    const row = await captureCustomRow(baseOptions, next);
    rows.push({
      ...summarizeRow(`offset-${offset}`, row, offset, mode),
      effect: classifyEffect(summarizeRow(`offset-${offset}`, row, offset, mode), summarizeRow('baseline', baseline)),
    });
    count += 1;
  }

  const baselineSummary = summarizeRow('baseline', baseline);
  const grouped = {};
  for (const row of rows) {
    const key = `${row.effect}|uy=${row.uyReturn || 'null'}|secondLen=${row.secondLen}|err=${row.error ? 'yes' : 'no'}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row.offset);
  }
  console.log(JSON.stringify({
    start,
    end,
    mode,
    sessionBytes: sessionBuf.length,
    baseline: baselineSummary,
    grouped,
    rows,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
