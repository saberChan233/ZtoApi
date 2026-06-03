#!/usr/bin/env node

const fs = require('fs');
const { solveCaptcha, buildLatestBrowserProfile } = require('./browserless_aliyun_captcha_solver');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function parseCapture(path) {
  if (!path || !fs.existsSync(path)) return null;
  const capture = JSON.parse(fs.readFileSync(path, 'utf8'));
  const headers = capture.verify_headers || {};
  const page = capture.page_state_after_send || capture.page_state_before_send || {};
  return {
    locationHref: typeof page.href === 'string' && page.href ? page.href : undefined,
    referrer: typeof headers.Referer === 'string' ? headers.Referer : undefined,
    navigatorOverrides: {
      userAgent: headers['User-Agent'] || undefined,
      appVersion: headers['User-Agent']
        ? headers['User-Agent'].replace(/^Mozilla\//, '')
        : undefined,
      platform: String(headers['sec-ch-ua-platform'] || '').replace(/^"|"$/g, '') === 'Linux'
        ? 'Linux x86_64'
        : undefined,
    },
    autoInitConfig: {
      language: capture.init_form?.Language || 'cn',
    },
    requestHeaders: {
      'User-Agent': headers['User-Agent'] || undefined,
      'Referer': typeof headers.Referer === 'string' ? headers.Referer : '',
      'Sec-Ch-Ua': headers['sec-ch-ua'] || undefined,
      'Sec-Ch-Ua-Mobile': headers['sec-ch-ua-mobile'] || undefined,
      'Sec-Ch-Ua-Platform': headers['sec-ch-ua-platform'] || undefined,
    },
  };
}

function parseToken(deviceToken) {
  if (typeof deviceToken !== 'string') return null;
  const plain = Buffer.from(deviceToken, 'base64').toString('utf8');
  const parts = plain.split('#');
  return {
    prefix: parts[0] || null,
    second: parts[1] || null,
    thirdLength: (parts[2] || '').length,
    fourth: parts[3] || null,
    fifth: parts[4] || null,
    preview: plain.slice(0, 220),
  };
}

async function main() {
  const capturePath = getArg('--capture', '/tmp/browser_verify_capture_live.json');
  const profile = buildLatestBrowserProfile(parseCapture(capturePath) || {});
  const out = await solveCaptcha({
    files: ['/tmp/feilin052.js', '/tmp/aliyun-pe-088.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    executeLive: true,
    executeLiveInVm: true,
    forceCallbackMode: false,
    ...profile,
  });
  const payload = out.verifyRequest?.params?.CaptchaVerifyParam
    ? JSON.parse(out.verifyRequest.params.CaptchaVerifyParam)
    : null;
  console.log(JSON.stringify({
    profile,
    xhrActions: out.xhrActions,
    initRequest: out.initRequest,
    verifyCode: out.liveVerify?.bodyJson?.Result?.VerifyCode || null,
    verifyResult: out.liveVerify?.bodyJson?.Result?.VerifyResult ?? null,
    token: parseToken(payload?.deviceToken),
    dataLen: payload?.data?.length || null,
    tokenVector: out.tokenVector ? {
      xPrefix: out.tokenVector.xPrefix,
      stateFingerprint: out.tokenVector.stateFingerprint,
      currentUrl: out.tokenVector.currentUrl,
      osName: out.tokenVector.osName,
      browser: out.tokenVector.browser,
      browserVersion: out.tokenVector.browserVersion,
      parts40to48: out.tokenVector.parts?.slice(35, 48) || null,
    } : null,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
