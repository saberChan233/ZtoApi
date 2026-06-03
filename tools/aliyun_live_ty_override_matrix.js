#!/usr/bin/env node
const crypto = require('crypto');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');
const { ensureAliyunBundleFiles } = require('./aliyun_bundle_bootstrap');
const { buildLatestBrowserProfile } = require('./browserless_aliyun_captcha_solver');
const {
  buildRuntimeSeed,
  executeFormRequest,
  refreshSignedCaptchaParams,
  loadBrowserCapture,
  DEFAULT_BROWSER_CAPTURE_PATH,
} = require('./aliyun_light_rolling_chain');
const { parseDeviceConfigToken, signCaptchaParams, KEY_SECRET } = require('./aliyun_local_reverse');
const { computeFifthSegment } = require('./feilin_local_token');

const ACCESS_KEY_SECRET_BY_ID = Object.freeze({
  ...(process.env.ALIYUN_CAPTCHA_ACCESS_KEY_ID && process.env.ALIYUN_CAPTCHA_ACCESS_KEY_SECRET
    ? { [process.env.ALIYUN_CAPTCHA_ACCESS_KEY_ID]: process.env.ALIYUN_CAPTCHA_ACCESS_KEY_SECRET }
    : {}),
});

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function parseVerifyRow(entry) {
  if (!entry?.params?.CaptchaVerifyParam) return null;
  let payload = null;
  try {
    payload = JSON.parse(entry.params.CaptchaVerifyParam);
  } catch {
    payload = null;
  }
  let plain = null;
  let parts = [];
  try {
    plain = payload?.deviceToken ? Buffer.from(payload.deviceToken, 'base64').toString('utf8') : null;
    parts = plain ? plain.split('#') : [];
  } catch {
    plain = null;
    parts = [];
  }
  return {
    certifyId: entry.params.CertifyId || payload?.certifyId || null,
    tokenPlain: plain,
    tokenPrefix: parts[0] || null,
    second: parts[1] || null,
    third: parts[2] || null,
    fourth: parts[3] || null,
    fifth: parts[4] || null,
    thirdLen: (parts[2] || '').length || null,
    responseCode: entry.responseJson?.Code || null,
    responseVerifyCode: entry.responseJson?.Result?.VerifyCode || null,
    responseVerifyResult: entry.responseJson?.Result?.VerifyResult ?? null,
  };
}

function buildPatches() {
  return [
    {
      match: 'function tY(t,n){function e(t,n){return({0:to})[0](n,t-7)}return ts[[e][0](60,48)](this,75)[e(234,33)](this,arguments)}',
      replace: 'function tY(t,n){if(window.__PE_TY_OVERRIDE__){return typeof window.__PE_TY_OVERRIDE__==="function"?window.__PE_TY_OVERRIDE__.apply(this,arguments):window.__PE_TY_OVERRIDE__}function e(t,n){return({0:to})[0](n,t-7)}return ts[[e][0](60,48)](this,75)[e(234,33)](this,arguments)}',
    },
  ];
}

function extractBrowserTokenParts(browserPath) {
  const capture = loadBrowserCapture(browserPath);
  const raw = capture?.verifyRequest?.params?.CaptchaVerifyParam || capture?.verify_form?.CaptchaVerifyParam || null;
  if (!raw) throw new Error('browser capture missing CaptchaVerifyParam');
  const payload = JSON.parse(raw);
  const plain = Buffer.from(payload.deviceToken, 'base64').toString('utf8');
  const parts = plain.split('#');
  return {
    payload,
    plain,
    prefix: parts[0] || null,
    second: parts[1] || null,
    third: parts[2] || null,
    fourth: parts[3] || null,
    fifth: parts[4] || null,
  };
}

function parseSecond(second) {
  if (typeof second !== 'string') return null;
  const match = second.match(/^([0-9a-f]{32})-h-(\d+)-([0-9a-f]{32})$/i);
  if (!match) return null;
  return {
    appKey: match[1],
    sessionTimestamp: match[2],
    sessionNonceHex: match[3],
  };
}

function buildSecond({ appKey, sessionTimestamp, sessionNonceHex }) {
  if (!appKey || !sessionTimestamp || !sessionNonceHex) return null;
  return `${appKey}-h-${sessionTimestamp}-${sessionNonceHex}`;
}

function refreshSignedCaptchaParamsForAccessKey(params) {
  const nextParams = {
    ...(params || {}),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureNonce: crypto.randomUUID(),
  };
  const secret = ACCESS_KEY_SECRET_BY_ID[nextParams.AccessKeyId] || KEY_SECRET;
  nextParams.Signature = signCaptchaParams(nextParams, secret);
  return nextParams;
}

function pickLog1DeviceConfigRaw(responseJson) {
  if (!responseJson || typeof responseJson !== 'object') return null;
  return (
    responseJson?.ResultObject?.DeviceConfig ||
    responseJson?.Result?.DeviceConfig ||
    responseJson?.DeviceConfig ||
    null
  );
}

async function resolveLog1DeviceConfig(firstLog1Response, sessionContext) {
  if (!firstLog1Response?.url || !firstLog1Response?.params) {
    return { source: 'missing-log1-request', responseJson: null, raw: null, parsed: null };
  }
  let responseJson = firstLog1Response.responseJson || null;
  let raw = pickLog1DeviceConfigRaw(responseJson);
  let replayed = false;
  if (!raw) {
    const replay = await executeFormRequest(
      firstLog1Response.url,
      refreshSignedCaptchaParamsForAccessKey(firstLog1Response.params),
      sessionContext,
    );
    responseJson = replay.bodyJson || null;
    raw = pickLog1DeviceConfigRaw(responseJson);
    replayed = true;
  }
  let parsed = null;
  if (raw) {
    try {
      parsed = parseDeviceConfigToken(raw);
    } catch {
      parsed = null;
    }
  }
  return {
    source: replayed ? 'external-log1-replay' : 'in-process-log1-response',
    responseJson,
    raw,
    parsed,
  };
}

async function createRuntime(bundle, certifyId, deviceConfig, runtimeOptions = {}) {
  return FeilinVmRuntime.create({
    feilinPath: bundle.files[0],
    dynamicPath: bundle.files[1],
    loaderPath: bundle.files[2],
    initialAliyunCaptchaConfig: {
      region: 'sgp',
      prefix: 'no8xfe',
      UserCertifyId: certifyId,
      CertifyId: certifyId,
      certifyId,
      DeviceConfig: deviceConfig,
      deviceConfig,
    },
    setGlobalAliyunCaptchaConfig: true,
    patchAliyunOptions: {
      literalSnippetPatches: buildPatches(),
    },
    captureXhrStacks: false,
    executeLive: runtimeOptions.executeLive === true,
    sessionContext: runtimeOptions.sessionContext || null,
  });
}

async function runCase(bundle, certifyId, deviceConfig, label, overrideValue = null, runtimeOptions = {}) {
  const runtime = await createRuntime(bundle, certifyId, deviceConfig, runtimeOptions);
  if (overrideValue) {
    runtime.window.__PE_TY_OVERRIDE__ = overrideValue;
  }
  const auto = await runtime.bootstrapAliyunCaptcha({
    initialAliyunCaptchaConfig: {
      region: 'sgp',
      prefix: 'no8xfe',
      UserCertifyId: certifyId,
      CertifyId: certifyId,
      certifyId,
      DeviceConfig: deviceConfig,
      deviceConfig,
    },
    autoInitConfig: { language: 'en', upLang: true },
    injectCaptchaVerifyCallback: false,
    timeoutMs: 3500,
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const verifyEntries = runtime.xhrLog.filter((entry) => entry?.params?.Action === 'VerifyCaptchaV3');
    if (verifyEntries.length > 0 && verifyEntries.every((entry) => entry.responseStatus != null || entry.response != null)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const verifyRows = runtime.xhrLog
    .filter((entry) => entry?.params?.Action === 'VerifyCaptchaV3')
    .map(parseVerifyRow)
    .filter(Boolean);
  const firstVerifyEntry = runtime.xhrLog.find((entry) => entry?.params?.Action === 'VerifyCaptchaV3') || null;
  const firstLog1Entry = runtime.xhrLog.find((entry) => entry?.params?.Action === 'Log1') || null;
  return {
    label,
    overridePreview: typeof overrideValue === 'string' ? overrideValue.slice(0, 220) : null,
    xhrActions: runtime.xhrLog.map((x) => x?.params?.Action).filter(Boolean),
    verifyRows,
    firstLog1Response: firstLog1Entry
      ? {
          url: firstLog1Entry.url,
          params: firstLog1Entry.params,
          responseStatus: firstLog1Entry.responseStatus,
          responseJson: firstLog1Entry.responseJson || null,
        }
      : null,
    firstVerifyRequest: firstVerifyEntry ? { url: firstVerifyEntry.url, params: firstVerifyEntry.params, body: firstVerifyEntry.body } : null,
    autoTail: Array.isArray(auto?.events) ? auto.events.slice(-6) : [],
    peTy2Calls: Array.isArray(runtime.window.__PE_TY2_CALLS__) ? runtime.window.__PE_TY2_CALLS__.slice(-4) : [],
  };
}

function maybeGc() {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {}
  }
}

async function main() {
  const browserPath = process.argv[2] || DEFAULT_BROWSER_CAPTURE_PATH;
  const singleCase = getArg('--case', null);
  const executeLiveXhr = hasFlag('--execute-live-xhr');
  const bundle = await ensureAliyunBundleFiles();
  const browser = extractBrowserTokenParts(browserPath);
  const profile = buildLatestBrowserProfile();
  const seed = await buildRuntimeSeed(profile);
  const initParams = { ...seed.initRequest.params };
  delete initParams.DeviceToken;
  const sessionContext = { cookie: '', requestHeaders: profile.requestHeaders };
  const liveInit = await executeFormRequest(
    seed.initRequest.url,
    refreshSignedCaptchaParams(initParams),
    sessionContext,
  );
  const certifyId = liveInit.bodyJson?.CertifyId || null;
  const deviceConfig = liveInit.bodyJson?.DeviceConfig || null;
  if (!certifyId || !deviceConfig) {
    throw new Error('live init missing certifyId or deviceConfig');
  }

  const runtimeOptions = { executeLive: executeLiveXhr, sessionContext };
  const baseline = await runCase(bundle, certifyId, deviceConfig, 'baseline', null, runtimeOptions);
  const liveToken = baseline.verifyRows[0]?.tokenPlain || null;
  const liveParts = liveToken ? liveToken.split('#') : [];
  const liveSecond = liveParts[1] || null;
  const liveThird = liveParts[2] || null;
  const liveFourth = liveParts[3] || '0';
  const liveLog1DeviceConfig = await resolveLog1DeviceConfig(baseline.firstLog1Response, sessionContext);
  const liveLog1Second = liveLog1DeviceConfig?.parsed?.sessionId || null;
  const browserSecondParts = parseSecond(browser.second);
  const liveSecondParts = parseSecond(liveSecond);

  const candidates = [];
  if (browser.plain) {
    candidates.push({ label: 'override-browser-exact', token: Buffer.from(browser.plain, 'utf8').toString('base64') });
  }
  if (liveSecond && browser.third) {
    const hybrid = `SG_WEB#${liveSecond}#${browser.third}#0#${computeFifthSegment(liveSecond, { prefix: 'SG_WEB', flag: '0' })}`;
    candidates.push({ label: 'override-live-second-browser-third', token: Buffer.from(hybrid, 'utf8').toString('base64') });
  }
  if (browser.second && liveThird) {
    const browserSecondLiveThird = `SG_WEB#${browser.second}#${liveThird}#0#${computeFifthSegment(browser.second, { prefix: 'SG_WEB', flag: '0' })}`;
    candidates.push({ label: 'override-browser-second-live-third', token: Buffer.from(browserSecondLiveThird, 'utf8').toString('base64') });
  }
  if (liveLog1Second && liveThird) {
    const log1SecondLiveThird = `SG_WEB#${liveLog1Second}#${liveThird}#0#${computeFifthSegment(liveLog1Second, { prefix: 'SG_WEB', flag: '0' })}`;
    candidates.push({ label: 'override-live-log1-second-live-third', token: Buffer.from(log1SecondLiveThird, 'utf8').toString('base64') });
  }
  if (liveLog1Second && browser.third) {
    const log1SecondBrowserThird = `SG_WEB#${liveLog1Second}#${browser.third}#0#${computeFifthSegment(liveLog1Second, { prefix: 'SG_WEB', flag: '0' })}`;
    candidates.push({ label: 'override-live-log1-second-browser-third', token: Buffer.from(log1SecondBrowserThird, 'utf8').toString('base64') });
  }
  if (browserSecondParts && liveSecondParts && liveThird) {
    const secondTimestampSwap = buildSecond({
      appKey: liveSecondParts.appKey,
      sessionTimestamp: browserSecondParts.sessionTimestamp,
      sessionNonceHex: liveSecondParts.sessionNonceHex,
    });
    const secondNonceSwap = buildSecond({
      appKey: liveSecondParts.appKey,
      sessionTimestamp: liveSecondParts.sessionTimestamp,
      sessionNonceHex: browserSecondParts.sessionNonceHex,
    });
    if (secondTimestampSwap) {
      const token = `SG_WEB#${secondTimestampSwap}#${liveThird}#0#${computeFifthSegment(secondTimestampSwap, { prefix: 'SG_WEB', flag: '0' })}`;
      candidates.push({ label: 'override-browser-ts-live-nonce', token: Buffer.from(token, 'utf8').toString('base64') });
    }
    if (secondNonceSwap) {
      const token = `SG_WEB#${secondNonceSwap}#${liveThird}#0#${computeFifthSegment(secondNonceSwap, { prefix: 'SG_WEB', flag: '0' })}`;
      candidates.push({ label: 'override-live-ts-browser-nonce', token: Buffer.from(token, 'utf8').toString('base64') });
    }
  }
  if (liveSecond && liveThird) {
    const normalized = `SG_WEB#${liveSecond}#${liveThird}#${liveFourth || '0'}#${computeFifthSegment(liveSecond, { prefix: 'SG_WEB', flag: liveFourth || '0' })}`;
    candidates.push({ label: 'override-normalized-live-token', token: Buffer.from(normalized, 'utf8').toString('base64') });
  }

  const caseMap = Object.fromEntries(candidates.map((x) => [x.label, x]));

  if (singleCase) {
    const chosen = singleCase === 'baseline' ? null : caseMap[singleCase];
    if (singleCase !== 'baseline' && !chosen) {
      throw new Error(`unknown --case ${singleCase}`);
    }
    const result = singleCase === 'baseline'
      ? baseline
      : await runCase(bundle, certifyId, deviceConfig, chosen.label, chosen.token, runtimeOptions);
    console.log(JSON.stringify({
      liveInit: {
        certifyId,
        success: liveInit?.bodyJson?.Success ?? null,
        captchaType: liveInit?.bodyJson?.CaptchaType || null,
      },
      browserToken: {
        prefix: browser.prefix,
        secondLen: browser.second?.length || null,
        thirdLen: browser.third?.length || null,
      },
      liveLog1DeviceConfig: {
        source: liveLog1DeviceConfig.source,
        sessionId: liveLog1DeviceConfig?.parsed?.sessionId || null,
        timestamp: liveLog1DeviceConfig?.parsed?.timestamp || null,
        ip: liveLog1DeviceConfig?.parsed?.ip || null,
      },
      baselineToken: baseline.verifyRows[0]
        ? {
            tokenPrefix: baseline.verifyRows[0].tokenPrefix,
            secondLen: baseline.verifyRows[0].second?.length || null,
            thirdLen: baseline.verifyRows[0].thirdLen,
          }
        : null,
      result,
      availableCases: ['baseline', ...candidates.map((x) => x.label)],
    }, null, 2));
    return;
  }

  const results = [baseline];
  maybeGc();
  for (const candidate of candidates) {
    results.push(await runCase(bundle, certifyId, deviceConfig, candidate.label, candidate.token, runtimeOptions));
    maybeGc();
  }

  console.log(JSON.stringify({
    liveInit: {
      certifyId,
      success: liveInit?.bodyJson?.Success ?? null,
      captchaType: liveInit?.bodyJson?.CaptchaType || null,
    },
    browserToken: {
      prefix: browser.prefix,
      secondLen: browser.second?.length || null,
      thirdLen: browser.third?.length || null,
    },
    liveLog1DeviceConfig: {
      source: liveLog1DeviceConfig.source,
      sessionId: liveLog1DeviceConfig?.parsed?.sessionId || null,
      timestamp: liveLog1DeviceConfig?.parsed?.timestamp || null,
      ip: liveLog1DeviceConfig?.parsed?.ip || null,
    },
    baselineToken: baseline.verifyRows[0]
      ? {
          tokenPrefix: baseline.verifyRows[0].tokenPrefix,
          secondLen: baseline.verifyRows[0].second?.length || null,
          thirdLen: baseline.verifyRows[0].thirdLen,
        }
      : null,
    results,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
