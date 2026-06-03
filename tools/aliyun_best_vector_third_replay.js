#!/usr/bin/env node
const fs = require('fs');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { decodeBase64Utf8 } = require('./feilin_vm_runtime');
const { parseTokenPlain } = require('./feilin_local_token');
const { pickBestTokenVector, buildTokenLPreviewFromVector } = require('./aliyun_token_vector');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

async function main() {
  const capturePath = getArg('--capture', '/tmp/browser_verify_capture_live.json');
  const capture = readJson(capturePath);
  const browserPlain = decodeBase64Utf8(capture?.init_form?.DeviceToken || '');
  const browserParsed = parseTokenPlain(browserPlain);

  const base = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const vector = pickBestTokenVector(base) || base.tokenVector;
  if (!vector?.trPreview) {
    throw new Error('best token vector missing trPreview');
  }
  const lPreview = buildTokenLPreviewFromVector(vector);
  const replay = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
    raTraceTargets: [vector.trPreview, vector.xPrefix, lPreview],
    cryptoTraceTargets: [vector.trPreview, vector.xPrefix, lPreview],
    rsExperimentInputs: [
      { label: 'best-vector-tr', arg0: vector.trPreview, arg1: lPreview, thisKind: 'undefined' },
      { label: 'best-vector-x', arg0: vector.xPrefix, arg1: lPreview, thisKind: 'undefined' },
    ],
  });

  const rows = Array.isArray(replay.rsExperiment) ? replay.rsExperiment : [];
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  const tr = byLabel['best-vector-tr'] || null;
  const x = byLabel['best-vector-x'] || null;

  console.log(JSON.stringify({
    browserCapture: {
      second: browserParsed?.second || null,
      thirdLength: browserParsed?.third ? browserParsed.third.length : 0,
      thirdPreview: browserParsed?.third ? browserParsed.third.slice(0, 220) : null,
    },
    vector: {
      candidateIndex: vector.candidateIndex ?? null,
      second: vector.second || null,
      trPreview: vector.trPreview || null,
      xPrefix: vector.xPrefix || null,
      lLength: vector.lLength || lPreview.length,
    },
    replay: {
      tr: tr ? {
        outputStringLength: tr.outputStringLength || null,
        outputPreview: tr.outputString ? tr.outputString.slice(0, 220) : null,
        matchesBrowserThird: tr.outputString === (browserParsed?.third || null),
        innerStages: tr.innerStages || [],
      } : null,
      x: x ? {
        outputStringLength: x.outputStringLength || null,
        outputPreview: x.outputString ? x.outputString.slice(0, 220) : null,
        matchesBrowserThird: x.outputString === (browserParsed?.third || null),
        innerStages: x.innerStages || [],
      } : null,
    },
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
