#!/usr/bin/env node

const fs = require('fs');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function parseHarFormEntry(entry) {
  const text = entry?.request?.postData?.text || '';
  const out = {};
  for (const [key, values] of new URLSearchParams(text).entries()) {
    out[key] = values;
  }
  return out;
}

function decodeBase64Utf8(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function summarizeTokenPlain(tokenPlain) {
  const plain = typeof tokenPlain === 'string' ? tokenPlain : '';
  const parts = plain ? plain.split('#') : [];
  return {
    preview: plain.slice(0, 240),
    lengths: parts.map((part) => part.length),
    prefix: parts[0] || null,
    second: parts[1] || null,
    thirdLength: parts[2] ? parts[2].length : 0,
    thirdPreview: parts[2] ? parts[2].slice(0, 240) : null,
    fourth: parts[3] || null,
    fifth: parts[4] || null,
  };
}

function summarizeVerifyPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const tokenPlain = decodeBase64Utf8(payload.deviceToken);
  return {
    certifyId: payload.certifyId || null,
    sceneId: payload.sceneId || null,
    dataLength: typeof payload.data === 'string' ? payload.data.length : null,
    dataPreview: typeof payload.data === 'string' ? payload.data.slice(0, 240) : null,
    token: summarizeTokenPlain(tokenPlain),
  };
}

function commonPrefixLen(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const limit = Math.min(left.length, right.length);
  let i = 0;
  while (i < limit && left[i] === right[i]) i += 1;
  return i;
}

async function main() {
  const harPath = getArg('--har', 'glitchhunter_session_1779496468306.har');
  const initIndex = Number(getArg('--init-index', '84'));
  const verifyIndex = Number(getArg('--verify-index', '94'));
  const har = readJson(harPath);
  const entries = har?.log?.entries || [];
  const initForm = parseHarFormEntry(entries[initIndex]);
  const verifyForm = parseHarFormEntry(entries[verifyIndex]);
  const browserPayload = verifyForm.CaptchaVerifyParam
    ? JSON.parse(verifyForm.CaptchaVerifyParam)
    : null;

  const vm = await solveCaptcha({
    executeLive: true,
    executeLiveInVm: true,
    initialAliyunCaptchaConfig: { region: 'sgp', prefix: 'no8xfe' },
    locationHref: 'https://chat.z.ai/c/e9b72609-ad96-45ca-87ee-8cf581232179',
    referrer: '',
    navigatorOverrides: {
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      appVersion:
        '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
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
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': '',
      'Sec-Ch-Ua': '"Google Chrome";v="147", "Chromium";v="147", "Not?A_Brand";v="8"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Linux"',
    },
    autoInitLanguage: 'en',
    autoInitConfig: {
      language: String(initForm.Language || 'en'),
    },
  });
  const vmPayload = vm.verifyRequest?.params?.CaptchaVerifyParam
    ? JSON.parse(vm.verifyRequest.params.CaptchaVerifyParam)
    : null;

  const browserToken = summarizeVerifyPayload(browserPayload)?.token;
  const vmToken = summarizeVerifyPayload(vmPayload)?.token;

  console.log(JSON.stringify({
    harPath,
    browser: {
      init: {
        hasDeviceData: !!initForm.DeviceData,
        hasDeviceToken: !!initForm.DeviceToken,
        language: initForm.Language || null,
        mode: initForm.Mode || null,
        upLang: initForm.UpLang || null,
        deviceDataLength: initForm.DeviceData ? initForm.DeviceData.length : null,
        deviceToken: summarizeTokenPlain(decodeBase64Utf8(initForm.DeviceToken)),
      },
      verify: summarizeVerifyPayload(browserPayload),
    },
    vm: {
      init: {
        hasDeviceData: !!vm.initRequest?.params?.DeviceData,
        hasDeviceToken: !!vm.initRequest?.params?.DeviceToken,
        language: vm.initRequest?.params?.Language || null,
        mode: vm.initRequest?.params?.Mode || null,
        upLang: vm.initRequest?.params?.UpLang || null,
        deviceDataLength: vm.initRequest?.params?.DeviceData
          ? vm.initRequest.params.DeviceData.length
          : null,
        deviceToken: summarizeTokenPlain(decodeBase64Utf8(vm.initRequest?.params?.DeviceToken)),
      },
      verify: summarizeVerifyPayload(vmPayload),
      liveVerify: {
        code: vm.liveVerify?.bodyJson?.Code || null,
        verifyCode: vm.liveVerify?.bodyJson?.Result?.VerifyCode || null,
        verifyResult: vm.liveVerify?.bodyJson?.Result?.VerifyResult ?? null,
      },
    },
    diff: {
      initDeviceDataSame: String(initForm.DeviceData || '') === String(vm.initRequest?.params?.DeviceData || ''),
      verifyDataSame: String(browserPayload?.data || '') === String(vmPayload?.data || ''),
      verifyDataCommonPrefixLen: commonPrefixLen(browserPayload?.data || '', vmPayload?.data || ''),
      secondSame: String(browserToken?.second || '') === String(vmToken?.second || ''),
      thirdSame: String(browserToken?.thirdPreview || '') === String(vmToken?.thirdPreview || '') &&
        Number(browserToken?.thirdLength || 0) === Number(vmToken?.thirdLength || 0),
      thirdCommonPrefixLen: commonPrefixLen(
        decodeBase64Utf8(browserPayload?.deviceToken || '')?.split('#')[2] || '',
        decodeBase64Utf8(vmPayload?.deviceToken || '')?.split('#')[2] || '',
      ),
      fourthSame: String(browserToken?.fourth || '') === String(vmToken?.fourth || ''),
      fifthSame: String(browserToken?.fifth || '') === String(vmToken?.fifth || ''),
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
