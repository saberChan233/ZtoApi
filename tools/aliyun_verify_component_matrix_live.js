#!/usr/bin/env node
const {
  buildLatestBrowserProfile,
} = require('./browserless_aliyun_captcha_solver');
const {
  buildRuntimeSeed,
  decodeCaptchaVerifyParam,
  executeFormRequest,
  loadBrowserCapture,
  refreshSignedCaptchaParams,
  rewriteVerifyRequest,
  summarizeResponse,
  summarizeVerifyPayload,
  DEFAULT_BROWSER_CAPTURE_PATH,
  DEFAULT_VERIFY_URL,
} = require('./aliyun_light_rolling_chain');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildSessionContext(profile) {
  return {
    cookie: '',
    requestHeaders: profile.requestHeaders,
  };
}

function buildInitRequestFromTemplate(template) {
  const params = { ...(template?.params || {}) };
  delete params.DeviceToken;
  return {
    url: template?.url || DEFAULT_VERIFY_URL,
    params: refreshSignedCaptchaParams(params),
  };
}

function makeVerifyTemplate(baseRequest, certifyId, tokenBase64, dataValue) {
  const payload = decodeCaptchaVerifyParam(baseRequest?.params?.CaptchaVerifyParam);
  if (!payload) throw new Error('missing verify payload');
  payload.certifyId = certifyId;
  payload.deviceToken = tokenBase64;
  payload.data = dataValue;
  return rewriteVerifyRequest({
    url: baseRequest.url,
    params: {
      ...(baseRequest.params || {}),
      CaptchaVerifyParam: JSON.stringify(payload),
      CertifyId: certifyId,
    },
  }, certifyId);
}

async function runInit(initLabel, initTemplate, sessionContext) {
  const request = buildInitRequestFromTemplate(initTemplate);
  const response = await executeFormRequest(request.url, request.params, sessionContext);
  return {
    label: initLabel,
    request,
    response,
    certifyId: response?.bodyJson?.CertifyId || null,
  };
}

async function main() {
  const browserPath = process.argv[2] || DEFAULT_BROWSER_CAPTURE_PATH;
  const profile = buildLatestBrowserProfile();
  const runtimeSeed = await buildRuntimeSeed(profile);
  const browserCapture = loadBrowserCapture(browserPath);

  const runtimeVerifyPayload = decodeCaptchaVerifyParam(runtimeSeed.liveCheckChainState?.verifyRequest?.params?.CaptchaVerifyParam);
  const browserVerifyPayload = decodeCaptchaVerifyParam(browserCapture.verifyRequest?.params?.CaptchaVerifyParam);
  if (!runtimeVerifyPayload || !browserVerifyPayload) {
    throw new Error('failed to load runtime/browser verify payloads');
  }

  const initTemplates = [
    { label: 'runtime-init', template: runtimeSeed.initRequest },
    { label: 'browser-init', template: browserCapture.initRequest },
  ];

  const verifySources = {
    runtime: runtimeSeed.liveCheckChainState?.verifyRequest || runtimeSeed.verifyRequest,
    browser: browserCapture.verifyRequest,
  };

  const tokenSources = {
    runtime: runtimeVerifyPayload.deviceToken,
    browser: browserVerifyPayload.deviceToken,
  };
  const dataSources = {
    runtime: runtimeVerifyPayload.data,
    browser: browserVerifyPayload.data,
  };

  const results = [];
  for (const initSource of initTemplates) {
    for (const verifyBaseLabel of ['runtime', 'browser']) {
      for (const tokenLabel of ['runtime', 'browser']) {
        for (const dataLabel of ['runtime', 'browser']) {
          const sessionContext = buildSessionContext(profile);
          const initRun = await runInit(initSource.label, initSource.template, sessionContext);
          const certifyId = initRun.certifyId;
          const initSummary = {
            label: initRun.label,
            requestHasDeviceData: !!initRun.request.params.DeviceData,
            requestHasDeviceToken: !!initRun.request.params.DeviceToken,
            requestDeviceDataLen: typeof initRun.request.params.DeviceData === 'string' ? initRun.request.params.DeviceData.length : null,
            response: summarizeResponse(initRun.response),
          };
          const request = makeVerifyTemplate(
            verifySources[verifyBaseLabel],
            certifyId,
            tokenSources[tokenLabel],
            dataSources[dataLabel],
          );
          const response = await executeFormRequest(request.url, request.params, sessionContext);
          results.push({
            initSource: initSource.label,
            initSummary,
            verifyBase: verifyBaseLabel,
            tokenSource: tokenLabel,
            dataSource: dataLabel,
            verifyPayload: summarizeVerifyPayload(clone(request.payload)),
            verifyResponse: summarizeResponse(response),
          });
        }
      }
    }
  }

  console.log(JSON.stringify({
    browserPath,
    runtimeSeed: {
      initHasDeviceData: !!runtimeSeed.initRequest?.params?.DeviceData,
      initHasDeviceToken: !!runtimeSeed.initRequest?.params?.DeviceToken,
      verifyPayload: summarizeVerifyPayload(runtimeVerifyPayload),
    },
    browserSeed: {
      initHasDeviceData: !!browserCapture.initRequest?.params?.DeviceData,
      initHasDeviceToken: !!browserCapture.initRequest?.params?.DeviceToken,
      verifyPayload: summarizeVerifyPayload(browserVerifyPayload),
    },
    results,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
