#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');
const { pickBestTokenVector, buildTokenLPreviewFromVector } = require('./aliyun_token_vector');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function summarizeToken(tokenResult) {
  if (!tokenResult) return null;
  return {
    encodedPreview: typeof tokenResult.encoded === 'string' ? tokenResult.encoded.slice(0, 220) : null,
    plainPreview: typeof tokenResult.plain === 'string' ? tokenResult.plain.slice(0, 220) : null,
    secondPreview: tokenResult.parsed?.second ? String(tokenResult.parsed.second).slice(0, 160) : null,
    thirdLength: tokenResult.parsed?.third ? String(tokenResult.parsed.third).length : 0,
    thirdPreview: tokenResult.parsed?.third ? String(tokenResult.parsed.third).slice(0, 220) : null,
  };
}

async function safeToken(runtime) {
  try {
    return { ok: true, result: summarizeToken(await runtime.computeToken()) };
  } catch (error) {
    return { ok: false, error: String(error && error.stack || error) };
  }
}

async function safeUy(runtime) {
  try {
    const value = runtime.callUy(runtime.window);
    return { ok: true, value: typeof value === 'string' ? value.slice(0, 220) : value };
  } catch (error) {
    return { ok: false, error: String(error && error.stack || error) };
  }
}

async function main() {
  const base = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const vector = pickBestTokenVector(base) || base.tokenVector;
  const lPreview = buildTokenLPreviewFromVector(vector);
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });
  const before = {
    functions: runtime.getWarmupFunctionSnapshot(),
    token: await safeToken(runtime),
    uy: await safeUy(runtime),
    replay: runtime.computeThirdSegmentDebug(vector.trPreview, lPreview),
  };
  const promote = (() => {
    try {
      return runtime.promoteRealGetTokenFromSb();
    } catch (error) {
      return { ok: false, error: String(error && error.stack || error) };
    }
  })();
  const after = {
    functions: runtime.getWarmupFunctionSnapshot(),
    token: await safeToken(runtime),
    uy: await safeUy(runtime),
    replay: runtime.computeThirdSegmentDebug(vector.trPreview, lPreview),
  };
  console.log(JSON.stringify({
    vector: {
      trPreview: vector.trPreview || null,
      lLength: vector.lLength || lPreview.length,
    },
    before: {
      functions: before.functions,
      token: before.token,
      uy: before.uy,
      replayLen: before.replay.outputString ? before.replay.outputString.length : null,
      replayPreview: before.replay.outputString ? before.replay.outputString.slice(0, 220) : null,
    },
    promote,
    after: {
      functions: after.functions,
      token: after.token,
      uy: after.uy,
      replayLen: after.replay.outputString ? after.replay.outputString.length : null,
      replayPreview: after.replay.outputString ? after.replay.outputString.slice(0, 220) : null,
    },
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
