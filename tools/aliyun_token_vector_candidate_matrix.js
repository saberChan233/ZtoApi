#!/usr/bin/env node
const fs = require('fs');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime, decodeBase64Utf8 } = require('./feilin_vm_runtime');
const { parseTokenPlain } = require('./feilin_local_token');
const {
  collectTokenVectorsFromReport,
  buildTokenLPreviewFromVector,
  pickBestTokenVector,
} = require('./aliyun_token_vector');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
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

function commonPrefixLen(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const limit = Math.min(left.length, right.length);
  let i = 0;
  while (i < limit && left[i] === right[i]) i += 1;
  return i;
}

async function main() {
  const capturePath = getArg('--capture', '/tmp/browser_verify_capture_live.json');
  const capture = readJson(capturePath);
  const browserPlain = getBrowserVerifyTokenPlain(capture);
  const browserParsed = parseTokenPlain(browserPlain);
  const browserThird = browserParsed?.third || '';

  const out = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });

  const vectors = collectTokenVectorsFromReport(out);
  const best = pickBestTokenVector(out);
  const rows = vectors.map((vector) => {
    const lPreview = buildTokenLPreviewFromVector(vector);
    const replay = runtime.computeThirdSegment(vector.trPreview || vector.xPrefix, lPreview);
    return {
      candidateIndex: vector.candidateIndex,
      isBestCandidate: best ? vector.candidateIndex === best.candidateIndex : false,
      secondPreview: vector.second ? String(vector.second).slice(0, 120) : null,
      trPreview: vector.trPreview || null,
      xPrefix: vector.xPrefix || null,
      lLength: vector.lLength || lPreview.length,
      currentUrl: vector.currentUrl || null,
      certifyId: vector.certifyId || null,
      thirdLength: replay?.outputString ? replay.outputString.length : 0,
      thirdPreview: replay?.outputString ? replay.outputString.slice(0, 220) : null,
      matchesBrowserThird: replay?.outputString === browserThird,
      commonPrefixLen: replay?.outputString ? commonPrefixLen(replay.outputString, browserThird) : 0,
    };
  });

  rows.sort((a, b) => {
    if (a.matchesBrowserThird !== b.matchesBrowserThird) return a.matchesBrowserThird ? -1 : 1;
    if (a.commonPrefixLen !== b.commonPrefixLen) return b.commonPrefixLen - a.commonPrefixLen;
    return (b.lLength || 0) - (a.lLength || 0);
  });

  console.log(JSON.stringify({
    browserCapture: {
      second: browserParsed?.second || null,
      thirdLength: browserThird.length,
      thirdPreview: browserThird.slice(0, 220),
      fifth: browserParsed?.fifth || null,
    },
    candidateCount: rows.length,
    bestCandidateIndex: best?.candidateIndex ?? null,
    rows,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
