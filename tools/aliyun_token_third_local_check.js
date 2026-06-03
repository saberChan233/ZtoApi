#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');
const { buildTokenLPreviewFromVector, pickBestTokenVector } = require('./aliyun_token_vector');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

async function main() {
  const out = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });
  const vector = pickBestTokenVector(out) || out.tokenVector;
  if (!vector?.xPrefix || !vector?.second) {
    throw new Error('missing token vector xPrefix / second');
  }
  const originalLPreview = buildTokenLPreviewFromVector(vector);
  const rebuiltLPreview = buildTokenLPreviewFromVector(vector);
  const originalReplayRa20 = originalLPreview
    ? runtime.computeThirdSegment(vector.trPreview || vector.xPrefix, originalLPreview)
    : null;
  const originalReplayRs = originalLPreview
    ? runtime.computeThirdSegmentViaRs(vector.trPreview || vector.xPrefix, originalLPreview)
    : null;
  const rebuiltReplay = runtime.computeThirdSegmentFromVector(vector);
  const rebuiltReplayRs = runtime.computeThirdSegmentFromVector(vector, {
    arg0: vector.trPreview || vector.xPrefix,
    mode: 'rs',
  });
  const rebuiltToken = runtime.computeTokenFromVector(vector);
  const rebuiltTokenRs = runtime.computeTokenFromVector(vector, {
    arg0: vector.trPreview || vector.xPrefix,
    mode: 'rs',
  });
  const runtimeTokenPlain = out.postAutoInitUmTokenPreview || null;
  const runtimeTokenParts = typeof runtimeTokenPlain === 'string' ? runtimeTokenPlain.split('#') : [];

  console.log(JSON.stringify({
    vector: {
      candidateIndex: vector.candidateIndex ?? null,
      second: vector.second,
      trPreview: vector.trPreview || null,
      xPrefix: vector.xPrefix,
      lLength: vector.lLength || null,
    },
    runtimeToken: {
      plainPreview: typeof runtimeTokenPlain === 'string' ? runtimeTokenPlain.slice(0, 240) : null,
      second: runtimeTokenParts[1] || null,
      third: runtimeTokenParts[2] || null,
      fifth: runtimeTokenParts[4] || null,
    },
    originalLPreview: {
      present: !!originalLPreview,
      exactVsRebuilt: originalLPreview === rebuiltLPreview,
      replayRa20: originalReplayRa20,
      replayRs: originalReplayRs,
    },
    rebuiltLPreview: {
      length: rebuiltLPreview.length,
      replay: rebuiltReplay.replay,
      replayRs: rebuiltReplayRs.replay,
    },
    rebuiltToken: {
      third: rebuiltToken.third,
      fullPreview: rebuiltToken.full.slice(0, 240),
      verify: rebuiltToken.verify,
      matchesRuntimeSecond: rebuiltToken.second === (runtimeTokenParts[1] || null),
      matchesRuntimeThird: rebuiltToken.third === (runtimeTokenParts[2] || null),
      matchesRuntimeFifth: rebuiltToken.fifth === (runtimeTokenParts[4] || null),
    },
    rebuiltTokenRs: {
      third: rebuiltTokenRs.third,
      fullPreview: rebuiltTokenRs.full.slice(0, 240),
      verify: rebuiltTokenRs.verify,
      matchesRuntimeSecond: rebuiltTokenRs.second === (runtimeTokenParts[1] || null),
      matchesRuntimeThird: rebuiltTokenRs.third === (runtimeTokenParts[2] || null),
      matchesRuntimeFifth: rebuiltTokenRs.fifth === (runtimeTokenParts[4] || null),
    },
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
