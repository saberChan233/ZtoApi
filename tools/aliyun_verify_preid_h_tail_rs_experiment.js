#!/usr/bin/env node
const { runProbe } = require('./probe_feilin_runtime');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { ACCESS_SEC } = require('./aliyun_local_reverse');

function uniq(items) {
  return [...new Set(items.filter((x) => x != null && x !== ''))];
}
function pickJoin(report) {
  return (report.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
}
function pickN0(report, name) {
  return (report.n0PartLogs || []).filter((item) => item?.name === name).slice(-1)[0] || null;
}
function buildRowsFromReport(report) {
  const join = pickJoin(report);
  const H = join?.namedParts?.H || '';
  const hBytes = H ? Buffer.from(H, 'base64') : Buffer.alloc(0);
  const tailBase64 = hBytes.length >= 272 ? hBytes.subarray(272).toString('base64') : '';
  const reverse = report.verifyDataReverse || null;
  const seed = reverse?.seedPrefix && reverse?.seedJsonParsed
    ? `${reverse.seedPrefix}${JSON.stringify(reverse.seedJsonParsed)}`
    : null;
  const lastB = pickN0(report, 'B')?.value || null;
  const lastTA = pickN0(report, 'tA')?.value || null;
  const lastMHex = pickN0(report, 'm')?.mHexPreview || null;
  const sessionDerive = (report.feilinSessionDeriveLogs || []).slice(-1)[0] || null;
  const rsKeys = uniq([
    ACCESS_SEC,
    ...(report.feilinRsLogs || []).map((item) => item?.arg0),
    report.verifyDataReverse?.seedPrefix || null,
    lastB,
    lastMHex,
    lastTA,
    sessionDerive?.wSecretPreview || null,
    sessionDerive?.wSessionPreview || null,
  ]);
  const plains = uniq([
    seed,
    join?.namedParts?.nO || null,
    reverse?.seedPrefix || null,
    JSON.stringify(reverse?.seedJsonParsed || null),
    lastTA,
    sessionDerive?.wSessionPreview || null,
    sessionDerive?.wSecretPreview || null,
  ]);
  const rsExperimentInputs = [];
  for (const key of rsKeys) {
    for (const plain of plains) {
      rsExperimentInputs.push({
        label: `${String(key).slice(0, 16)}::${String(plain || '').slice(0, 48)}`,
        arg0: key,
        arg1: plain,
      });
    }
  }
  return { seed, H, hBytes, tailBase64, rsKeys, plains, rsExperimentInputs, lastB, lastTA, lastMHex, sessionDerive };
}
function sharedPrefixBytesBase64(left64, right64) {
  const left = Buffer.from(left64 || '', 'base64');
  const right = Buffer.from(right64 || '', 'base64');
  const size = Math.min(left.length, right.length);
  let idx = 0;
  while (idx < size && left[idx] === right[idx]) idx += 1;
  return idx;
}
function summarizeMatch(row, tailBase64) {
  const output = typeof row?.outputString === 'string' ? row.outputString : '';
  return {
    label: row?.label || null,
    arg0: row?.arg0 || null,
    arg1Length: row?.arg1Length || null,
    outputStringLength: row?.outputStringLength || null,
    outputWordArrayBytes: row?.outputWordArrayBytes || null,
    outputWordArrayBase64Length: row?.outputWordArrayBase64?.length || null,
    equalsTail: output === tailBase64,
    tailPrefixMatchBytes: sharedPrefixBytesBase64(output, tailBase64),
    outputPreview: output.slice(0, 160),
  };
}
async function main() {
  const baseline = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const setup = buildRowsFromReport(baseline);
  const probe = await runProbe(['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'], {
    rsExperimentInputs: setup.rsExperimentInputs,
  });
  const rows = Array.isArray(probe.rsExperiment)
    ? probe.rsExperiment.map((row) => summarizeMatch(row, setup.tailBase64))
    : probe.rsExperiment;
  const likely = Array.isArray(rows)
    ? rows
      .filter((row) => row.outputStringLength || row.outputWordArrayBytes)
      .sort((a, b) => {
        if (b.equalsTail !== a.equalsTail) return Number(b.equalsTail) - Number(a.equalsTail);
        if ((b.tailPrefixMatchBytes || 0) !== (a.tailPrefixMatchBytes || 0)) return (b.tailPrefixMatchBytes || 0) - (a.tailPrefixMatchBytes || 0);
        return (b.outputWordArrayBytes || 0) - (a.outputWordArrayBytes || 0);
      })
      .slice(0, 30)
    : rows;

  console.log(JSON.stringify({
    seedLength: setup.seed?.length || null,
    tailBase64Length: setup.tailBase64.length || null,
    tailBytes: setup.tailBase64 ? Buffer.from(setup.tailBase64, 'base64').length : null,
    rsKeys: setup.rsKeys,
    plainsPreview: setup.plains.map((x) => String(x).slice(0, 80)),
    n0: { B: setup.lastB, tA: setup.lastTA, mHex: setup.lastMHex, sessionDerive: setup.sessionDerive },
    likely,
  }, null, 2));
}
main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
