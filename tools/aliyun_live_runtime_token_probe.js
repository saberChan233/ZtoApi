#!/usr/bin/env node
const { buildLatestBrowserProfile } = require('./browserless_aliyun_captcha_solver');
const { runProbe } = require('./probe_feilin_runtime');
const {
  buildRuntimeSeed,
  executeFormRequest,
  loadBrowserCapture,
  refreshSignedCaptchaParams,
  DEFAULT_BROWSER_CAPTURE_PATH,
} = require('./aliyun_light_rolling_chain');

const DEFAULT_FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];

function summarizeToken(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const plain = Buffer.from(value, 'base64').toString('utf8');
    const parts = plain.split('#');
    return {
      prefix: parts[0] || null,
      secondLen: (parts[1] || '').length,
      thirdLen: (parts[2] || '').length,
      fourth: parts[3] || null,
      preview: plain.slice(0, 180),
    };
  } catch {
    return { raw: value.slice(0, 180) };
  }
}

async function main() {
  const mode = process.argv[2] || 'runtime-init';
  const browserPath = process.argv[3] || DEFAULT_BROWSER_CAPTURE_PATH;
  const profile = buildLatestBrowserProfile();
  const runtimeSeed = await buildRuntimeSeed(profile);
  const browserCapture = loadBrowserCapture(browserPath);
  const initTemplate = mode === 'browser-init' ? browserCapture.initRequest : runtimeSeed.initRequest;

  const sessionContext = { cookie: '', requestHeaders: profile.requestHeaders };
  const initParams = { ...(initTemplate?.params || {}) };
  delete initParams.DeviceToken;
  const liveInit = await executeFormRequest(initTemplate.url, refreshSignedCaptchaParams(initParams), sessionContext);
  const certifyId = liveInit?.bodyJson?.CertifyId || null;
  const deviceConfig = liveInit?.bodyJson?.DeviceConfig || null;

  const probe = await runProbe(DEFAULT_FILES, {
    executeLive: false,
    initialAliyunCaptchaConfig: {
      region: 'sgp',
      prefix: 'no8xfe',
      UserCertifyId: certifyId,
      CertifyId: certifyId,
      certifyId,
      DeviceConfig: deviceConfig,
      deviceConfig,
    },
    tokenProbeCertifyId: certifyId,
    setGlobalConfig: true,
    autoInitLanguage: 'en',
    autoInitConfig: { language: 'en', upLang: true },
    requestHeaders: profile.requestHeaders,
    locationHref: profile.locationHref,
    referrer: profile.referrer,
    navigatorOverrides: profile.navigatorOverrides,
    navigatorLanguages: profile.navigatorLanguages,
    screenOverrides: profile.screenOverrides,
  });

  console.log(JSON.stringify({
    mode,
    liveInit: {
      certifyId,
      hasDeviceConfig: !!deviceConfig,
      deviceConfigLength: typeof deviceConfig === 'string' ? deviceConfig.length : null,
      success: liveInit?.bodyJson?.Success ?? null,
      code: liveInit?.bodyJson?.Code || null,
      captchaType: liveInit?.bodyJson?.CaptchaType || null,
    },
    tokens: {
      getToken: summarizeToken(probe.getTokenValue),
      zGetToken: summarizeToken(probe.zGetTokenValue),
      postAutoInitGetToken: summarizeToken(probe.postAutoInitGetTokenValue),
      postAutoInitZGetToken: summarizeToken(probe.postAutoInitZGetTokenValue),
      postAutoInitGetTokenWithCertifyId: summarizeToken(probe.postAutoInitGetTokenWithCertifyIdValue),
      postAutoInitZGetTokenWithCertifyId: summarizeToken(probe.postAutoInitZGetTokenWithCertifyIdValue),
    },
    autoInitTail: Array.isArray(probe.autoInit) ? probe.autoInit.slice(-8) : probe.autoInit,
    asyncErrors: probe.asyncErrors || [],
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
