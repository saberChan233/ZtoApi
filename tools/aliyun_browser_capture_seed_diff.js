#!/usr/bin/env node
const fs = require('fs');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { decodeVerifyDataToSeed } = require('./aliyun_verify_data_local');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseHarFormEntry(entry) {
  const text = entry?.request?.postData?.text || '';
  return Object.fromEntries(new URLSearchParams(text).entries());
}

function summarizeSeed(decoded) {
  if (!decoded) return null;
  return {
    seedPrefix: decoded.seedPrefix || null,
    seedJsonParsed: decoded.seedJsonParsed || null,
    runtimeSeedPreview: typeof decoded.runtimeSeedBase64Like === 'string'
      ? decoded.runtimeSeedBase64Like.slice(0, 200)
      : null,
    dataLength: typeof decoded.finalDataBase64 === 'string' ? decoded.finalDataBase64.length : null,
  };
}

async function main() {
  const harPath = getArg('--har', 'glitchhunter_session_1779496468306.har');
  const verifyIndex = Number(getArg('--verify-index', '94'));
  const localLive = getArg('--local-live', 'false') === 'true';
  const har = readJson(harPath);
  const entry = har?.log?.entries?.[verifyIndex];
  if (!entry) {
    throw new Error(`missing HAR entry at index ${verifyIndex}`);
  }
  const verifyForm = parseHarFormEntry(entry);
  const browserPayload = verifyForm.CaptchaVerifyParam ? JSON.parse(verifyForm.CaptchaVerifyParam) : null;
  const browserSeed = browserPayload?.data ? decodeVerifyDataToSeed(browserPayload.data) : null;

  const local = await solveCaptcha({
    executeLive: localLive,
    executeLiveInVm: localLive,
    initialAliyunCaptchaConfig: { region: 'sgp', prefix: 'no8xfe' },
  });
  const localPayload = local.verifyRequest?.params?.CaptchaVerifyParam
    ? JSON.parse(local.verifyRequest.params.CaptchaVerifyParam)
    : null;
  const localSeed = localPayload?.data ? decodeVerifyDataToSeed(localPayload.data) : null;

  console.log(JSON.stringify({
    harPath,
    verifyIndex,
    browser: summarizeSeed(browserSeed),
    local: summarizeSeed(localSeed),
    diff: {
      seedPrefixSame: String(browserSeed?.seedPrefix || '') === String(localSeed?.seedPrefix || ''),
      argSame: String(browserSeed?.seedJsonParsed?.arg || '') === String(localSeed?.seedJsonParsed?.arg || ''),
      startTimeSame:
        String(browserSeed?.seedJsonParsed?.TrackStartTime || '') ===
        String(localSeed?.seedJsonParsed?.TrackStartTime || ''),
      verifyTimeSame:
        String(browserSeed?.seedJsonParsed?.VerifyTime || '') ===
        String(localSeed?.seedJsonParsed?.VerifyTime || ''),
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
