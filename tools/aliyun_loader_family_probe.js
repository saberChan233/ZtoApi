#!/usr/bin/env node

const fs = require('fs');
const { runProbe } = require('./probe_feilin_runtime');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function decodeBase64Utf8(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function parseToken(deviceToken) {
  const plain = decodeBase64Utf8(deviceToken);
  const parts = typeof plain === 'string' ? plain.split('#') : [];
  return {
    plainPreview: plain ? plain.slice(0, 240) : null,
    prefix: parts[0] || null,
    second: parts[1] || null,
    thirdLength: parts[2] ? parts[2].length : 0,
    thirdPreview: parts[2] ? parts[2].slice(0, 240) : null,
    fourth: parts[3] || null,
    fifth: parts[4] || null,
  };
}

function summarizeAction(entry) {
  return {
    action: entry?.params?.Action || null,
    status: entry?.responseStatus || null,
    code: entry?.responseJson?.Code || null,
    verifyCode: entry?.responseJson?.Result?.VerifyCode || null,
    hasResponse: !!entry?.responseJson,
    staticPath: entry?.responseJson?.StaticPath || null,
    captchaJsPath: entry?.responseJson?.CaptchaJsPath || null,
    captchaCssPath: entry?.responseJson?.CaptchaCssPath || null,
    deviceVersion: entry?.responseJson?.DeviceConfig?.version || null,
  };
}

function findVerifyPayload(report) {
  const raw = report?.liveCheckChainState?.verifyParamDecoded;
  if (raw && typeof raw === 'object') return raw;
  const xhrVerify = (report?.xhrLog || []).find((entry) => entry?.params?.Action === 'VerifyCaptchaV3');
  if (xhrVerify?.params?.CaptchaVerifyParam) {
    try {
      return JSON.parse(xhrVerify.params.CaptchaVerifyParam);
    } catch {
      return null;
    }
  }
  return null;
}

async function main() {
  const dynamicPattern = getArg('--dynamic-pattern', null);
  const dynamicFile = getArg('--dynamic-file', null);
  const feilinPattern = getArg('--feilin-pattern', null);
  const feilinFile = getArg('--feilin-file', null);
  const initStaticPath = getArg('--init-static-path', null);
  const scriptMappings = [];
  if (dynamicPattern && dynamicFile) {
    scriptMappings.push({ pattern: dynamicPattern, file: dynamicFile });
  }
  if (feilinPattern && feilinFile) {
    scriptMappings.push({ pattern: feilinPattern, file: feilinFile });
  }
  const files = ['/tmp/AliyunCaptcha.js'];
  const report = await runProbe(files, {
    executeLive: true,
    liveXhrWaitTimeoutMs: 6000,
    failSyntheticInit: false,
    scriptFetchMode: 'auto',
    initialAliyunCaptchaConfig: {
      region: 'sgp',
      prefix: 'no8xfe',
    },
    autoInitLanguage: 'en',
    autoInitConfig: {
      language: 'en',
      upLang: true,
    },
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
    ...(initStaticPath ? { initStaticPath } : {}),
    scriptMappings,
  });

  const verifyPayload = findVerifyPayload(report);
  const liveVerifyResult = report.liveCheckChainState?.liveVerifyResponse?.bodyJson?.Result
    || report.liveCheckChainState?.verifyRequest?.responseJson?.Result
    || null;
  const output = {
    evalOk: report.evalOk,
    evalError: report.evalError,
    files: report.files,
    family: {
      initStaticPath,
      dynamicPattern,
      dynamicFile,
      feilinPattern,
      feilinFile,
    },
    scriptLoadLogs: report.scriptLoadLogs,
    autoInitTail: Array.isArray(report.autoInit) ? report.autoInit.slice(-6) : report.autoInit,
    actions: (report.xhrLog || []).map(summarizeAction),
    verifyCode: report.liveCheckChainState?.liveVerifyResponse?.bodyJson?.Result?.VerifyCode
      || report.liveCheckChainState?.verifyRequest?.responseJson?.Result?.VerifyCode
      || null,
    verifyResult: report.liveCheckChainState?.liveVerifyResponse?.bodyJson?.Result?.VerifyResult
      ?? report.liveCheckChainState?.verifyRequest?.responseJson?.Result?.VerifyResult
      ?? null,
    securityToken: liveVerifyResult?.securityToken || null,
    certifyId: liveVerifyResult?.certifyId || verifyPayload?.certifyId || null,
    sceneId: verifyPayload?.sceneId || null,
    verifyPayload: verifyPayload ? {
      certifyId: verifyPayload.certifyId || null,
      sceneId: verifyPayload.sceneId || null,
      dataLength: typeof verifyPayload.data === 'string' ? verifyPayload.data.length : null,
      dataPreview: typeof verifyPayload.data === 'string' ? verifyPayload.data.slice(0, 240) : null,
      token: parseToken(verifyPayload.deviceToken),
    } : null,
    asyncErrors: report.asyncErrors,
    consoleLogsTail: Array.isArray(report.consoleLogs) ? report.consoleLogs.slice(-12) : [],
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`, () => {
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error && error.stack || error));
    process.exit(1);
  });
}
