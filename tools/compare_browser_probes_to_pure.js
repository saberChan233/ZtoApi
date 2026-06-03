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

function pickProbe(input, label) {
  const found = (input.probes || []).find((item) => item.label === label);
  if (!found) throw new Error(`probe not found: ${label}`);
  return found.probe;
}

function compareValue(label, browserValue, pureValue) {
  return {
    label,
    browser: browserValue ?? null,
    pure: pureValue ?? null,
    same: browserValue === pureValue,
  };
}

async function main() {
  const browserPath = getArg('--browser');
  if (!browserPath) throw new Error('missing --browser <json>');
  const label = getArg('--label', 'after-uploadlog');
  const browserRaw = readJson(browserPath);
  const browser = pickProbe(browserRaw, label);
  const pure = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });

  const out = {
    browserLabel: label,
    browser: {
      href: browser.href,
      pathname: browser.pathname,
      aliyunCaptchaConfig: browser.aliyunCaptchaConfig || null,
      umGetToken: browser.umGetToken || null,
      zUmGetToken: browser.zUmGetToken || null,
      umShapeKeys: browser.umShape ? Object.keys(browser.umShape).sort() : [],
      zUmShapeKeys: browser.zUmShape ? Object.keys(browser.zUmShape).sort() : [],
      feilinShapeKeys: browser.feilinShape ? Object.keys(browser.feilinShape).sort() : [],
      deviceCvsKeys: browser.deviceCvsKeys || [],
      deviceIfrKeys: browser.deviceIfrKeys || [],
      localStorageKeys: browser.localStorage ? Object.keys(browser.localStorage).sort() : [],
    },
    pure: {
      umTokenPreview: pure.umTokenPreview || null,
      zUmTokenPreview: pure.zUmTokenPreview || null,
      umObjectSnapshot: pure.umObjectSnapshot || null,
      zUmObjectSnapshot: pure.zUmObjectSnapshot || null,
      feilinReSnapshot: pure.feilinReSnapshot || null,
      localStorageKeys: pure.localStorageSnapshot ? Object.keys(pure.localStorageSnapshot).sort() : [],
      sessionStorageKeys: pure.sessionStorageSnapshot ? Object.keys(pure.sessionStorageSnapshot).sort() : [],
      initDeviceTokenPreview: pure.initDeviceTokenPreview || null,
      deviceTokenPreview: pure.deviceTokenPreview || null,
    },
    compare: {
      umTokenDecoded: compareValue(
        'umTokenDecoded',
        browser.umGetToken?.decoded || null,
        pure.umTokenPreview || null,
      ),
      zUmTokenDecoded: compareValue(
        'zUmTokenDecoded',
        browser.zUmGetToken?.decoded || null,
        pure.zUmTokenPreview || null,
      ),
      browserHasUmGetToken: compareValue(
        'browserHasUmGetToken',
        browser.umGetToken?.ok === true,
        !!pure.umTokenPreview,
      ),
      browserHasZUmGetToken: compareValue(
        'browserHasZUmGetToken',
        browser.zUmGetToken?.ok === true,
        !!pure.zUmTokenPreview,
      ),
      localStorageHasArmsSession: compareValue(
        'localStorageHasArmsSession',
        !!browser.localStorage?._arms_session,
        !!pure.localStorageSnapshot?._arms_session,
      ),
    },
    hypotheses: [],
  };

  if (!out.compare.umTokenDecoded.same) {
    out.hypotheses.push('browser um.getToken decoded value differs from pure-code umTokenPreview; token runtime path may still be diverging');
  }
  if (!out.compare.zUmTokenDecoded.same) {
    out.hypotheses.push('browser z_um.getToken decoded value differs from pure-code zUmTokenPreview');
  }
  if ((browser.deviceCvsKeys || []).length && !pure.feilinReSnapshot) {
    out.hypotheses.push('browser has _aliyun_device_* runtime objects while pure-code does not expose equivalent browser-side device containers');
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
