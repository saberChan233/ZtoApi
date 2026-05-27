#!/usr/bin/env node

const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    loaderOnly: true,
    scriptFetchMode: 'auto',
    scriptFetchCacheDir: '/tmp/aliyun-script-cache',
    executeLive: true,
    executeLiveInVm: true,
    initialAliyunCaptchaConfig: { region: 'sgp', prefix: 'no8xfe' },
    locationHref: 'https://chat.z.ai/c/live-probe',
    referrer: '',
    navigatorOverrides: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      appVersion: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      language: 'en-US',
      webdriver: false,
      maxTouchPoints: 0,
    },
    navigatorLanguages: ['en-US', 'en'],
    screenOverrides: {
      width: 2560,
      height: 1440,
      availWidth: 2560,
      availHeight: 1440,
      colorDepth: 30,
      pixelDepth: 30,
    },
    windowOverrides: {
      innerWidth: 2560,
      innerHeight: 1440,
      outerWidth: 2560,
      outerHeight: 1440,
      devicePixelRatio: 1,
    },
    requestHeaders: {
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      Priority: 'u=1, i',
      Referer: '',
      'Sec-Ch-Ua': '"Chromium";v="147", "Not.A/Brand";v="8"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Linux"',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    },
    autoInitLanguage: 'en',
    autoInitConfig: { language: 'en', upLang: true },
    slimOutput: false,
    setGlobalConfig: true,
  });

  const summary = {
    outType: typeof out,
    outKeys: out && typeof out === 'object' ? Object.keys(out).slice(0, 80) : null,
    evalOk: out?.evalOk ?? null,
    evalError: out?.evalError ?? null,
    initAliyunCaptchaType: out?.initAliyunCaptchaType ?? null,
    liveVerify: out?.liveVerify?.bodyJson?.Result || null,
    liveVerifyTop: out?.liveVerify?.bodyJson || null,
    synthesized: out?.synthesizedFromLiveVerify || null,
    liveCheckSource: out?.liveCheckChainState?.canonicalSource || null,
    liveCheckVerify: out?.liveCheckChainState?.liveVerifyResponse?.bodyJson?.Result || null,
    liveCheckFailPayload: out?.liveCheckChainState?.vmFailPayload || null,
    xhrActions: out?.xhrActions || null,
    scriptLoadLogs: out?.scriptLoadLogs || null,
    autoInitTail: Array.isArray(out?.autoInit) ? out.autoInit.slice(-8) : out?.autoInit,
    directLiveSolveResult: out?.directLiveSolveResult
      ? {
          liveVerify: out.directLiveSolveResult.liveVerify?.bodyJson?.Result || null,
          synthesized: out.directLiveSolveResult.synthesizedFromLiveVerify || null,
        }
      : null,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error && error.stack || error));
    process.exit(1);
  });
}
