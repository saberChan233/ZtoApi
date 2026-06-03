#!/usr/bin/env node

const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { computePreidFromRuntimeContext } = require('./aliyun_local_context_builder');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
  const local = out.localPreidExactRuntimeIv;
  if (!local?.ok || !local?.context?.snapshotPreview || !local?.rebuilt?.iv) {
    throw new Error('missing localPreidExactRuntimeIv context');
  }
  const preview = local.context.snapshotPreview;
  const deviceCfg = preview.deviceConfig?.value || {};
  const deviceData = preview.deviceData?.value || {};
  const seed = {
    prefix: preview.prefix?.value,
    region: preview.region?.value,
    appName: preview.appName?.value,
    appKey: preview.appKey?.value,
    nO: local.context.nO,
    sessionTimestamp: deviceCfg.timestamp,
    initTime: preview.initTime?.value,
    finalTimestamp: local.context.finalTimestamp,
    token71: deviceData.asf65445,
    certifyId: deviceData.xcvbrt454,
    fontsNum: preview.preCollectData?.value?.fontsNum,
    browserName: deviceData.sdfg433,
    browserVersion: deviceData.sdfgsf4,
    osName: deviceData.dfghfg64,
    osArch: deviceData.lk4n6ll,
    ip: deviceData.fghjfghe,
    pageUrl: deviceData.dfghfgdh6,
    fullUserAgent: deviceData.wertdxfgs,
    shortUserAgent: deviceData.rewtq2354,
    deviceClass: deviceData.fvcb343,
    brands: deviceData.gs8d67g9,
  };
  const rebuilt = computePreidFromRuntimeContext(seed, {
    iv: local.rebuilt.iv,
  });
  console.log(JSON.stringify({
    seed,
    checks: {
      tTMatch: rebuilt.tT === local.rebuilt.tT,
      hMatch: rebuilt.H === local.rebuilt.H,
      ngMatch: rebuilt.ng === local.rebuilt.ng,
      preidPlainMatch: rebuilt.preidPlain === local.rebuilt.preidPlain,
    },
    rebuilt: {
      tT: rebuilt.tT,
      H: rebuilt.H,
      ng: rebuilt.ng,
      preidPlain: rebuilt.preidPlain,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
