#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');
const { pickBestTokenVector, buildTokenLPreviewFromVector } = require('./aliyun_token_vector');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function summarizeTokenResult(result) {
  if (!result) return null;
  return {
    encodedPreview: typeof result.encoded === 'string' ? result.encoded.slice(0, 220) : null,
    plainPreview: typeof result.plain === 'string' ? result.plain.slice(0, 220) : null,
    secondPreview: result.parsed?.second ? String(result.parsed.second).slice(0, 160) : null,
    thirdLength: result.parsed?.third ? String(result.parsed.third).length : 0,
    thirdPreview: result.parsed?.third ? String(result.parsed.third).slice(0, 220) : null,
  };
}

function summarizeReplay(result) {
  if (!result) return null;
  return {
    ok: !!result.ok,
    outputStringLength: typeof result.outputString === 'string' ? result.outputString.length : null,
    outputPreview: typeof result.outputString === 'string' ? result.outputString.slice(0, 220) : null,
  };
}

async function safeComputeToken(runtime) {
  try {
    return { ok: true, result: summarizeTokenResult(await runtime.computeToken()) };
  } catch (error) {
    return { ok: false, error: String(error && error.stack || error) };
  }
}

async function safeUy(runtime) {
  runtime.window.__FEILIN_UY_LOGS__ = [];
  runtime.window.__FEILIN_UB_LOGS__ = [];
  try {
    const value = runtime.callUy(runtime.window);
    return {
      ok: true,
      value: typeof value === 'string' ? value.slice(0, 220) : value,
      uyLogs: (runtime.window.__FEILIN_UY_LOGS__ || []).slice(-8),
      ubLogs: (runtime.window.__FEILIN_UB_LOGS__ || []).slice(-8),
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.stack || error),
      uyLogs: (runtime.window.__FEILIN_UY_LOGS__ || []).slice(-8),
      ubLogs: (runtime.window.__FEILIN_UB_LOGS__ || []).slice(-8),
    };
  }
}

async function main() {
  const base = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const vector = pickBestTokenVector(base) || base.tokenVector;
  if (!vector?.trPreview) {
    throw new Error('missing best token vector');
  }
  const lPreview = buildTokenLPreviewFromVector(vector);
  const runtime = await FeilinVmRuntime.create({
    feilinPath: FILES[0],
    dynamicPath: FILES[1],
    loaderPath: FILES[2],
  });

  const before = {
    computeToken: await safeComputeToken(runtime),
    uY: await safeUy(runtime),
    replay: summarizeReplay(runtime.computeThirdSegmentDebug(vector.trPreview, lPreview)),
  };

  const autoInit = await runtime.bootstrapAliyunCaptcha();

  const after = {
    computeToken: await safeComputeToken(runtime),
    uY: await safeUy(runtime),
    replay: summarizeReplay(runtime.computeThirdSegmentDebug(vector.trPreview, lPreview)),
  };

  console.log(JSON.stringify({
    vector: {
      candidateIndex: vector.candidateIndex ?? null,
      second: vector.second || null,
      trPreview: vector.trPreview || null,
      xPrefix: vector.xPrefix || null,
      lLength: vector.lLength || lPreview.length,
    },
    before,
    autoInit,
    after,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
