#!/usr/bin/env node
const fs = require('fs');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function pickPart(row, name) {
  return (row?.n0PartLogs || []).find((item) => item?.name === name) || null;
}

function getBrowserSecondFromHar(path) {
  const har = JSON.parse(fs.readFileSync(path, 'utf8'));
  const req = har.log?.entries?.[94]?.request?.postData?.text || '';
  const params = new URLSearchParams(req);
  const raw = params.get('CaptchaVerifyParam');
  if (!raw) throw new Error('missing CaptchaVerifyParam in HAR entry #94');
  const payload = JSON.parse(raw);
  const plain = Buffer.from(String(payload.deviceToken || ''), 'base64').toString('utf8');
  return plain.split('#')[1] || '';
}

function summarize(label, row) {
  const parsed = row?.parsed || {};
  return {
    label,
    second: parsed.second || null,
    secondLen: parsed.second ? String(parsed.second).length : 0,
    fifth: parsed.fifth || null,
    uyReturn: row?.intermediates?.uyReturn || null,
    directRxOutput: row?.directRxAfterToken?.output || null,
    error: row?.error || null,
  };
}

function toFixedTailBuffer(source, size = 64) {
  const buf = Buffer.isBuffer(source) ? Buffer.from(source) : Buffer.from(String(source || ''), 'utf8');
  if (buf.length === size) return buf;
  if (buf.length > size) return buf.subarray(0, size);
  return Buffer.concat([buf, Buffer.alloc(size - buf.length)]);
}

async function runCustom(baseOptions, prefix32, label, tail) {
  const sessionBuf = Buffer.concat([prefix32, toFixedTailBuffer(tail, 64)]);
  const out = await solveCaptcha({
    ...baseOptions,
    customSessionIdBlobBase64: sessionBuf.toString('base64'),
  });
  return summarize(label, out.customSessionIdBlobResult || null);
}

async function main() {
  const harPath = process.argv[2] || 'glitchhunter_session_1779496468306.har';
  const baseOptions = {
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  };
  const browserSecond = getBrowserSecondFromHar(harPath);
  const baseline = await solveCaptcha({ ...baseOptions, sessionIdBlobExperiment: true });
  const baselineRow = baseline?.sessionIdBlobExperiment?.baseline || null;
  const tA = pickPart(baselineRow, 'tA');
  if (!tA?.CPreview || !tA?.value) {
    throw new Error('missing baseline session blob / second');
  }
  const sessionBuf = Buffer.from(tA.CPreview, 'base64');
  const prefix32 = sessionBuf.subarray(0, 32);
  const baseSecond = tA.value;
  const candidates = [
    ['baseline', baselineRow],
    ['utf8-browser-second', null],
    ['utf8-browser-second-b64', null],
    ['utf8-base-second', null],
  ];
  const results = [];
  results.push(summarize('baseline', baselineRow));
  results.push(await runCustom(baseOptions, prefix32, 'utf8-browser-second', Buffer.from(browserSecond, 'utf8')));
  results.push(await runCustom(
    baseOptions,
    prefix32,
    'utf8-browser-second-b64',
    Buffer.from(Buffer.from(browserSecond, 'utf8').toString('base64'), 'utf8'),
  ));
  results.push(await runCustom(baseOptions, prefix32, 'utf8-base-second', Buffer.from(baseSecond, 'utf8')));
  console.log(JSON.stringify({
    harPath,
    browserSecond,
    browserSecondLen: browserSecond.length,
    baselineSecond: baseSecond,
    baselineSecondLen: baseSecond.length,
    prefix32Hex: prefix32.toString('hex'),
    results,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
