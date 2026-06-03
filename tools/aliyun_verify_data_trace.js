#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function summarizeApplyLogs(out) {
  const frame = out.verifyDataRuntimeFrame || {};
  const seed = frame.runtimeSeedBase64Like || '';
  const raw = frame.rawBinaryFull || '';
  const logs = Array.isArray(out.tVmApplyLogs) ? out.tVmApplyLogs : [];
  const stringCharCodeLogs = (out.stringCharCodeLogs || []).filter((x) => x?.inputPreview === seed.slice(0, 240));
  const stringFromCharCodeLogs = out.stringFromCharCodeLogs || [];
  const trace1413 = (out.tVmTrace || []).filter((x) => x?.n >= 1408 && x?.n <= 1416);
  let matchedRawFromCharCode = null;
  for (let i = 0; i < stringFromCharCodeLogs.length; i += 1) {
    if (stringFromCharCodeLogs[i]?.ch !== raw[0]) continue;
    let ok = true;
    for (let j = 1; j < raw.length; j += 1) {
      if (!stringFromCharCodeLogs[i + j] || stringFromCharCodeLogs[i + j].ch !== raw[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matchedRawFromCharCode = {
        start: i,
        end: i + raw.length,
        nSet: [...new Set(stringFromCharCodeLogs.slice(i, i + raw.length).map((x) => x.n))],
        head: stringFromCharCodeLogs.slice(i, i + 16),
        tail: stringFromCharCodeLogs.slice(i + raw.length - 16, i + raw.length),
      };
      break;
    }
  }
  const charCodeAt = [];
  const fromCharCode = [];
  for (const row of logs) {
    if (row?.lPreview === 'charCodeAt' && row?.hPreview === seed) {
      charCodeAt.push({
        index: row?.argPreview?.[0],
        code: row?.resultPreview,
        n: row?.n,
      });
      continue;
    }
    if (row?.lPreview === 'fromCharCode' && typeof row?.resultPreview === 'string') {
      fromCharCode.push({
        arg: row?.argPreview?.[0],
        ch: row?.resultPreview,
        code: row?.resultPreview.charCodeAt(0),
        n: row?.n,
      });
    }
  }
  return {
    keyHex: frame.keyHex || null,
    seedLength: seed.length || null,
    rawLength: raw.length || null,
    rawHexHead: raw ? Buffer.from(raw, 'latin1').toString('hex').slice(0, 160) : null,
    charCodeAtCount: charCodeAt.length,
    fromCharCodeCount: fromCharCode.length,
    stringCharCodeCount: stringCharCodeLogs.length,
    stringFromCharCodeCount: stringFromCharCodeLogs.length,
    charCodeAtHead: charCodeAt.slice(0, 32),
    fromCharCodeHead: fromCharCode.slice(0, 32),
    charCodeAtTail: charCodeAt.slice(-16),
    fromCharCodeTail: fromCharCode.slice(-16),
    stringCharCodeHead: stringCharCodeLogs.slice(0, 40),
    stringCharCodeTail: stringCharCodeLogs.slice(-20),
    stringFromCharCodeTail: stringFromCharCodeLogs.slice(-20),
    matchedRawFromCharCode,
    trace1413,
  };
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  console.log(JSON.stringify(summarizeApplyLogs(out), null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
