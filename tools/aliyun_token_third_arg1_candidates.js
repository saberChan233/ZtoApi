#!/usr/bin/env node
const fs = require('fs');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime, decodeBase64Utf8 } = require('./feilin_vm_runtime');
const { parseTokenPlain } = require('./feilin_local_token');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function pickPart(report, name) {
  return (report?.n0PartLogs || []).find((entry) => entry?.name === name) || null;
}

function addCandidate(map, source, value) {
  if (typeof value !== 'string' || !value || map.has(value)) return;
  map.set(value, { source, value });
}

function commonPrefixLen(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const limit = Math.min(left.length, right.length);
  let i = 0;
  while (i < limit && left[i] === right[i]) i += 1;
  return i;
}

function getBrowserVerifyTokenPlain(capture) {
  const initDeviceToken = capture?.init_form?.DeviceToken || '';
  if (initDeviceToken) {
    return decodeBase64Utf8(initDeviceToken || '');
  }
  const verifyRaw = capture?.verify_form?.CaptchaVerifyParam || '';
  if (!verifyRaw) return null;
  try {
    const parsed = JSON.parse(verifyRaw);
    return decodeBase64Utf8(parsed?.deviceToken || '');
  } catch {
    return null;
  }
}

function collectCandidates(out) {
  const unique = new Map();
  const tA = pickPart(out, 'tA');
  const v = pickPart(out, 'v');
  addCandidate(unique, 'n0.v.lPreview', v?.lPreview || null);
  addCandidate(unique, 'n0.v.value', v?.value || null);
  addCandidate(unique, 'n0.tA.value', tA?.value || null);
  addCandidate(unique, 'n0.tA.CPreview.base64', tA?.CPreview || null);
  addCandidate(unique, 'n0.tA.CPreview.decoded', decodeBase64Utf8(tA?.CPreview || ''));

  for (const row of (out?.feilinRsLogs || [])) {
    addCandidate(unique, `feilinRs.arg1:${row?.label || 'unknown'}`, row?.arg1 || null);
    addCandidate(unique, `feilinRs.output:${row?.label || 'unknown'}`, row?.outputDecodedPreview || null);
  }
  for (const row of (out?.n0PartLogs || [])) {
    addCandidate(unique, `n0.${row?.name}.value`, row?.value || null);
    addCandidate(unique, `n0.${row?.name}.lPreview`, row?.lPreview || null);
    addCandidate(unique, `n0.${row?.name}.CDecoded`, row?.CDecoded || null);
  }

  const preview = out?.feilinReSnapshot?.preview || {};
  const maybeJson = [
    ['re.deviceData', preview?.deviceData?.value],
    ['re.deviceConfig', preview?.deviceConfig?.value],
  ];
  for (const [name, value] of maybeJson) {
    if (value && typeof value === 'object') {
      addCandidate(unique, `${name}.json`, JSON.stringify(value));
    }
  }
  addCandidate(unique, 're.DeviceConfig.raw', preview?.DeviceConfig?.value || null);
  addCandidate(unique, 're.sessionId.raw', preview?.sessionId?.value || null);
  addCandidate(unique, 're.secretKey.raw', preview?.secretKey?.value || null);
  return Array.from(unique.values());
}

async function main() {
  const capturePath = getArg('--capture', '/tmp/browser_verify_capture_live.json');
  const capture = fs.existsSync(capturePath) ? readJson(capturePath) : null;
  const browserThird = capture
    ? parseTokenPlain(getBrowserVerifyTokenPlain(capture))?.third || ''
    : '';

  const out = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });
  const tA = pickPart(out, 'tA');
  const key = tA?.trPreview || 'FqJB6iRNVYdEGpwb';

  const rows = collectCandidates(out).map((item) => {
    const result = runtime.computeThirdSegment(key, item.value);
    const output = result?.outputString || null;
    return {
      source: item.source,
      arg1Length: item.value.length,
      arg1Preview: item.value.slice(0, 220),
      outputType: result?.outputType || null,
      thirdLength: output ? output.length : 0,
      thirdPreview: output ? output.slice(0, 220) : null,
      equalsBrowserThird: output === browserThird,
      commonPrefixLen: output && browserThird ? commonPrefixLen(output, browserThird) : 0,
    };
  });

  rows.sort((a, b) => {
    if (a.equalsBrowserThird !== b.equalsBrowserThird) return a.equalsBrowserThird ? -1 : 1;
    if (a.commonPrefixLen !== b.commonPrefixLen) return b.commonPrefixLen - a.commonPrefixLen;
    if (a.thirdLength !== b.thirdLength) return b.thirdLength - a.thirdLength;
    return b.arg1Length - a.arg1Length;
  });

  console.log(JSON.stringify({
    trPreview: key,
    browserThirdLength: browserThird.length || null,
    totalCandidates: rows.length,
    topCandidates: rows.slice(0, 24),
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
