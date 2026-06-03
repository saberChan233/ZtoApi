#!/usr/bin/env node
const crypto = require('crypto');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const {
  encodeVerifyData,
  encodeVerifyDataPureLocal,
  buildVerifyDataSeed,
  encodeRuntimeSeedFromSeed,
  encodeRuntimeSeedFromSeedPureLocal,
} = require('./aliyun_verify_data_local');

function md5(value) {
  return crypto.createHash('md5').update(String(value ?? ''), 'utf8').digest('hex');
}

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const reverse = out.verifyDataReverse || {};
  const seedJson = reverse.seedJson || '';
  const parsed = reverse.seedJsonParsed || {};
  const trackList = parsed.TrackList || {};
  const result = {
    dataPreview: reverse.dataPreview || null,
    verifyDataCallsite: out.verifyDataCallsiteLogs?.[0] || null,
    runtimeFrame: out.verifyDataRuntimeFrame || null,
    seedPrefix: reverse.seedPrefix || null,
    seedLength: reverse.seedLength || null,
    transformedLen: reverse.transformedLen || null,
    transformedHexPreview: reverse.transformedHexPreview || null,
    seedJson,
    seedJsonParsed: parsed,
    digestCandidates: {
      md5_seed_json: seedJson ? md5(seedJson) : null,
      md5_track_list_json: Object.keys(trackList).length ? md5(JSON.stringify(trackList)) : null,
      md5_arg: parsed.arg ? md5(parsed.arg) : null,
      md5_start_verify_arg: parsed.TrackStartTime && parsed.VerifyTime && parsed.arg
        ? md5(`${parsed.TrackStartTime}${parsed.VerifyTime}${parsed.arg}`)
        : null,
      md5_verify_arg: parsed.VerifyTime && parsed.arg
        ? md5(`${parsed.VerifyTime}${parsed.arg}`)
        : null,
    },
    localRebuild: reverse.seedPrefix && Object.keys(parsed).length
      ? (() => {
        const rebuilt = encodeVerifyData(reverse.seedPrefix, parsed);
        const rebuiltPureLocal = encodeVerifyDataPureLocal(reverse.seedPrefix, parsed);
        const seed = buildVerifyDataSeed(reverse.seedPrefix, parsed);
        const runtimeSeed = encodeRuntimeSeedFromSeed(seed);
        const runtimeSeedPureLocal = encodeRuntimeSeedFromSeedPureLocal(seed);
        return {
          match: rebuilt === reverse.dataValue,
          runtimeSeedMatch: runtimeSeed === out.verifyDataRuntimeFrame?.runtimeSeedBase64Like,
          pureLocalMatch: rebuiltPureLocal === reverse.dataValue,
          runtimeSeedPureLocalMatch: runtimeSeedPureLocal === out.verifyDataRuntimeFrame?.runtimeSeedBase64Like,
          runtimeSeedPreview: runtimeSeed.slice(0, 160),
          runtimeSeedPureLocalPreview: runtimeSeedPureLocal.slice(0, 160),
          rebuiltPreview: rebuilt.slice(0, 300),
          rebuiltPureLocalPreview: rebuiltPureLocal.slice(0, 300),
          rebuiltLength: rebuilt.length,
          runtimeLength: typeof reverse.dataValue === 'string' ? reverse.dataValue.length : null,
        };
      })()
      : null,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
