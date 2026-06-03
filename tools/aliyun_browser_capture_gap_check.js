#!/usr/bin/env node
const fs = require('fs');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime, decodeBase64Utf8 } = require('./feilin_vm_runtime');
const { parseTokenPlain } = require('./feilin_local_token');
const { pickBestTokenVector, buildTokenLPreviewFromVector } = require('./aliyun_token_vector');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
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

async function main() {
  const capturePath = getArg('--capture', '/tmp/browser_verify_capture_live.json');
  const capture = readJson(capturePath);
  const browserInitPlain = getBrowserVerifyTokenPlain(capture);
  const browserInitParsed = parseTokenPlain(browserInitPlain);

  const out = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });

  const vector = pickBestTokenVector(out) || out.tokenVector || null;
  const lPreview = vector ? buildTokenLPreviewFromVector(vector) : '';
  const candidate = runtime.computeThirdSegment(
    vector?.trPreview || 'FqJB6iRNVYdEGpwb',
    lPreview,
  );
  const candidateViaRs = runtime.computeThirdSegmentViaRs(
    vector?.trPreview || 'FqJB6iRNVYdEGpwb',
    lPreview,
  );

  console.log(JSON.stringify({
    browserCapture: {
      initDeviceTokenPreview: browserInitPlain ? browserInitPlain.slice(0, 220) : null,
      second: browserInitParsed?.second || null,
      thirdLength: browserInitParsed?.third ? browserInitParsed.third.length : 0,
      thirdPreview: browserInitParsed?.third ? browserInitParsed.third.slice(0, 220) : null,
      fifth: browserInitParsed?.fifth || null,
    },
    localBaseline: {
      candidateIndex: vector?.candidateIndex ?? null,
      trPreview: vector?.trPreview || null,
      xPreview: vector?.xPrefix || null,
      lLength: vector?.lLength || null,
      runtimeTokenPreview: out.postAutoInitUmTokenPreview || null,
    },
    localCandidateWithTrKey: {
      arg0: vector?.trPreview || null,
      arg1Length: lPreview.length || null,
      thirdLength: candidate?.outputString ? candidate.outputString.length : 0,
      thirdPreview: candidate?.outputString ? candidate.outputString.slice(0, 220) : null,
      matchesBrowserThird: candidate?.outputString === (browserInitParsed?.third || null),
    },
    localCandidateWithTrKeyViaRs: {
      arg0: vector?.trPreview || null,
      arg1Length: lPreview.length || null,
      thirdLength: candidateViaRs?.outputString ? candidateViaRs.outputString.length : 0,
      thirdPreview: candidateViaRs?.outputString ? candidateViaRs.outputString.slice(0, 220) : null,
      matchesBrowserThird: candidateViaRs?.outputString === (browserInitParsed?.third || null),
    },
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
