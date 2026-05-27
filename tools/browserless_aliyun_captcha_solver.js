#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createContext, encodeFinalCaptchaVerifyParam, runProbe, tryDecodeBase64Json } = require('./probe_feilin_runtime');
const { parseTokenPlain, computeFifthSegment, verifyTokenPlain, normalizeToBrowserLikeInitToken } = require('./feilin_local_token');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');
const { ensureAliyunBundleFiles } = require('./aliyun_bundle_bootstrap');
const { encodeVerifyData } = require('./aliyun_verify_data_local');
const {
  buildTokenVectorFromReport,
  collectTokenVectorsFromReport,
  buildTokenLPreviewFromVector,
} = require('./aliyun_token_vector');
const {
  extractPayloadForSynthesis,
  rebuildPreidFromSolverResult,
  rebuildPreidUsingRuntimeIvFromSolverResult,
  synthesizeCaptchaVerifyParamFromSolverResult,
} = require('./aliyun_pure_local_pipeline');
const {
  buildCaptchaVerifyParam,
  compareCaptchaVerifyParam,
} = require('./aliyun_captcha_verify_param_local');
const {
  buildInitCaptchaV3Request,
  buildVerifyCaptchaV3Request,
  compareRequestShape,
} = require('./aliyun_verify_request_local');
const {
  buildPreidRuntimeContext,
  buildSnapshotPreviewFromRuntimeContext,
  computePreidFromRuntimeContext,
} = require('./aliyun_local_context_builder');
const {
  extractReplaySeedFromSolverResult,
  collectPureLocalFlowIssues,
  buildPureLocalFlowFromSeed,
  expandCompactReplaySeed,
  toCompactReplaySeed,
  toLiveReplaySeed,
  toMinimalLiveReplaySeed,
  toUltraMinimalLiveReplaySeed,
} = require('./aliyun_pure_local_full_flow');

function summarizeReplaySeedIssues(seed, issues) {
  return {
    issues: Array.isArray(issues) ? issues : [],
    sceneId: seed?.sceneId || null,
    certifyId: seed?.runtimeContext?.certifyId || null,
    nO: seed?.runtimeContext?.nO || null,
    hasVerifyDataPrefixHex: !!seed?.verifyDataPrefixHex,
    hasVerifyDataPayload: !!seed?.verifyDataPayload,
  };
}
const {
  encodeDeviceConfigParts,
  parseDeviceConfigToken,
  signCaptchaParams,
  KEY_SECRET,
  KEY_ID,
} = require('./aliyun_local_reverse');
const { splitPreidH, PREID_H_STATIC_PREFIX_BASE64 } = require('./aliyun_preid_h_local');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function getJsonArg(name, fallback = null) {
  const raw = getArg(name);
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function pickCallbackPayload(report) {
  const events = Array.isArray(report?.autoInit) ? report.autoInit : [];
  for (const event of events) {
    if (event?.type === 'captchaVerifyCallback' && event.payload && typeof event.payload === 'object') {
      return event.payload;
    }
  }
  return null;
}

function pickSuccessPayload(report) {
  const events = Array.isArray(report?.autoInit) ? report.autoInit : [];
  for (const event of events) {
    if (event?.type === 'success' && typeof event.payload === 'string') {
      return {
        captcha_verify_param: event.payload,
        decoded: event.decoded ?? null,
      };
    }
  }
  return null;
}

function pickVerifyRequest(report) {
  const entries = Array.isArray(report?.xhrLog) ? report.xhrLog : [];
  for (const entry of entries) {
    if (entry?.params?.Action === 'VerifyCaptchaV3') {
      return {
        url: entry.url,
        requestUrl: entry.requestUrl || entry.url,
        params: entry.params,
        headers: entry.requestHeaders || null,
        responseStatus: entry.responseStatus || null,
        responseHeaders: entry.responseHeaders || null,
        responseJson: entry.responseJson || null,
      };
    }
  }
  return null;
}

function isProbeCredentialValue(value) {
  if (typeof value !== 'string' || !value) return false;
  return value.includes('probe-security-token') || value.includes('probe-certify-id');
}

function sanitizeCredentialValue(value) {
  if (typeof value !== 'string' || !value || isProbeCredentialValue(value)) return null;
  if (value === 'null' || value === 'undefined') return null;
  return value;
}

function isSyntheticProbeResponse(response) {
  const requestId = response?.bodyJson?.RequestId || response?.responseJson?.RequestId || null;
  return typeof requestId === 'string' && requestId.startsWith('probe-');
}

function pickCanonicalLiveVerifyRequest(output = {}, base = {}) {
  return (
    output?.liveVerifyRequest ||
    output?.liveVerifyRequestFromVmXhr ||
    output?.vmVerifyRequest ||
    base.verifyRequest ||
    null
  );
}

function pickCanonicalLiveVerifyResponse(output = {}) {
  if (output?.externalLiveVerify?.bodyJson?.Result) {
    return output.externalLiveVerify;
  }
  if (output?.liveVerifyFromVmXhr === true) {
    return output.liveVerify || null;
  }
  if (output?.liveVerify?.bodyJson?.Result) {
    return output.liveVerify;
  }
  return null;
}

function summarizeObjectKeys(value, limit = 24) {
  if (!value || typeof value !== 'object') return null;
  try {
    return Object.keys(value).slice(0, limit);
  } catch {
    return null;
  }
}

function summarizeVerifyRequestLite(request) {
  if (!request || typeof request !== 'object') return null;
  return {
    url: request.url || request.requestUrl || null,
    requestUrl: request.requestUrl || request.url || null,
    params: request.params && typeof request.params === 'object'
      ? {
        Action: request.params.Action || null,
        SceneId: request.params.SceneId || null,
        CertifyId: request.params.CertifyId || null,
        DeviceToken: request.params.DeviceToken || null,
        CaptchaVerifyParamLength:
          typeof request.params.CaptchaVerifyParam === 'string'
            ? request.params.CaptchaVerifyParam.length
            : null,
      }
      : null,
    requestHeaders: request.requestHeaders || request.headers || null,
    responseStatus: request.responseStatus || null,
  };
}

function summarizeLiveResponseLite(response) {
  if (!response || typeof response !== 'object') return null;
  const result = response.bodyJson?.Result || null;
  return {
    status: response.status || null,
    ok: typeof response.ok === 'boolean' ? response.ok : null,
    requestUrl: response.requestUrl || null,
    bodyJson: response.bodyJson
      ? {
        Code: response.bodyJson.Code || null,
        Message: response.bodyJson.Message || null,
        RequestId: response.bodyJson.RequestId || null,
        Success: typeof response.bodyJson.Success === 'boolean' ? response.bodyJson.Success : null,
        CertifyId: response.bodyJson.CertifyId || null,
        LimitFlow: typeof response.bodyJson.LimitFlow === 'boolean' ? response.bodyJson.LimitFlow : null,
        LimitedFlowToken: response.bodyJson.LimitedFlowToken || null,
        Result: result
          ? {
            VerifyResult: result.VerifyResult ?? null,
            VerifyCode: result.VerifyCode || null,
            certifyId: result.certifyId || null,
            securityTokenPresent: typeof result.securityToken === 'string' && result.securityToken.length > 0,
          }
          : null,
      }
      : null,
  };
}

function extractTokenString(value) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }
  if (!value || typeof value !== 'object') return null;
  if (typeof value.token === 'string' && value.token.trim()) {
    return value.token.trim();
  }
  if (typeof value.tokenPreview === 'string' && value.tokenLength === value.tokenPreview.length) {
    const normalized = value.tokenPreview.trim();
    return normalized || null;
  }
  return null;
}

function captureEncodedTokenSummary(token, error = null) {
  const decoded = typeof token === 'string' && token ? decodeBase64Utf8(token) : null;
  return {
    token: typeof token === 'string' ? token : '',
    tokenLength: typeof token === 'string' ? token.length : 0,
    tokenPreview: typeof token === 'string' ? token.slice(0, 240) : '',
    decoded,
    parsed: decoded ? parseTokenPlain(decoded) : null,
    error: error ? String(error && error.stack || error) : null,
  };
}

function normalizeRollingVerifyLikeTokenBase64(tokenValue) {
  const plain = typeof tokenValue === 'string' && tokenValue.includes('#')
    ? tokenValue
    : decodeBase64Utf8(tokenValue);
  if (typeof plain !== 'string' || !plain) return null;
  const parts = plain.split('#');
  if (parts.length < 5) return null;
  const second = parts[1] || null;
  const third = parts[2] || '';
  const fourth = parts[3] || '0';
  if (!second || !third) return null;
  if (parts[0] === 'SG_WEB' && third.length >= 200) {
    return typeof tokenValue === 'string' && !tokenValue.includes('#')
      ? tokenValue
      : Buffer.from(plain, 'utf8').toString('base64');
  }
  if (parts[0] !== 'SG_WEB_PREID') return null;
  const nextPlain = `SG_WEB#${second}#${third}#${fourth}#${computeFifthSegment(second, { prefix: 'SG_WEB', flag: fourth })}`;
  return Buffer.from(nextPlain, 'utf8').toString('base64');
}

function applyProbeConfigToContainer(container, {
  liveCfg = null,
  liveCfgRaw = null,
  certifyId = null,
  deviceToken = null,
} = {}) {
  if (!container || typeof container !== 'object') return;
  const sessionId = liveCfg?.sessionId || null;
  const timestamp = liveCfg?.timestamp || null;
  const ip = liveCfg?.ip || null;
  if (certifyId) {
    container.CertifyId = certifyId;
    container.certifyId = certifyId;
    container.UserCertifyId = certifyId;
  }
  if (deviceToken) {
    container.DeviceToken = deviceToken;
    container.deviceToken = deviceToken;
  }
  if (liveCfgRaw) {
    container.DeviceConfig = liveCfgRaw;
  }
  if (liveCfg && typeof liveCfg === 'object') {
    container.deviceConfig = {
      ...(container.deviceConfig && typeof container.deviceConfig === 'object' ? container.deviceConfig : {}),
      ...liveCfg,
    };
    if (sessionId) container.sessionId = sessionId;
    if (timestamp) container.timestamp = String(timestamp);
    if (ip) container.ip = ip;
  }
  if (!container.logInfo || typeof container.logInfo !== 'object') {
    container.logInfo = {};
  }
  if (certifyId) container.logInfo.cId = certifyId;
  if (ip) container.logInfo.ip = ip;
  if (container.deviceData && typeof container.deviceData === 'object') {
    if (certifyId) container.deviceData.xcvbrt454 = certifyId;
    if (ip) container.deviceData.fghjfghe = ip;
    if (timestamp) container.deviceData.h9w87s9 = String(timestamp);
  }
}

async function probePostLiveInitTokensWithRuntime({
  files,
  loaderPath,
  options,
  liveDeviceConfigRaw,
  parsedLiveDeviceConfig,
  certifyId,
  deviceToken,
}) {
  try {
    const runtime = await FeilinVmRuntime.create({
      feilinPath: files[0],
      dynamicPath: files[1],
      loaderPath,
      initialAliyunCaptchaConfig: {
        ...(options.initialAliyunCaptchaConfig && typeof options.initialAliyunCaptchaConfig === 'object'
          ? options.initialAliyunCaptchaConfig
          : {}),
        UserCertifyId: certifyId || null,
        CertifyId: certifyId || null,
        DeviceConfig: liveDeviceConfigRaw || null,
        deviceConfig: parsedLiveDeviceConfig || null,
        DeviceToken: deviceToken || null,
      },
      setGlobalAliyunCaptchaConfig: options.setGlobalConfig !== false,
      documentCookie: options.documentCookie || null,
      locationHref: options.locationHref || null,
      referrer: options.referrer || null,
      localStorageSeed: options.localStorageSeed || null,
      sessionStorageSeed: options.sessionStorageSeed || null,
      cookieSeed: options.cookieSeed || null,
      navigatorOverrides: options.navigatorOverrides || null,
      screenOverrides: options.screenOverrides || null,
      navigatorLanguages: options.navigatorLanguages || null,
      windowOverrides: options.windowOverrides || null,
      mediaScenario: options.mediaScenario || null,
      autoInitLanguage: options.autoInitLanguage || null,
      autoInitConfig: options.autoInitConfig || null,
      log1DeviceConfig: liveDeviceConfigRaw || null,
      log1DeviceToken: deviceToken || null,
    });
    if (parsedLiveDeviceConfig) {
      try {
        runtime.callSvInit({ deviceConfig: parsedLiveDeviceConfig });
      } catch {}
    }
    const windowRef = runtime.window;
    const applyConfig = (container) => applyProbeConfigToContainer(container, {
      liveCfg: parsedLiveDeviceConfig,
      liveCfgRaw: liveDeviceConfigRaw,
      certifyId,
      deviceToken,
    });
    applyConfig(runtime.re);
    applyConfig(windowRef.__FEILIN_RE__);
    applyConfig(windowRef.__FEILIN_EXPORT_RE__);
    applyConfig(windowRef.__ALIYUN_INIT_STATE__);
    applyConfig(windowRef.__ALIYUN_LAST_INSTANCE__?.config);
    applyConfig(windowRef.__ALIYUN_LAST_CAPTCHA_INSTANCE__?.config);
    const capture = async (fn) => {
      try {
        const token = await Promise.resolve(fn());
        return captureEncodedTokenSummary(token, null);
      } catch (error) {
        return captureEncodedTokenSummary('', error);
      }
    };
    const um = certifyId && windowRef.um && typeof windowRef.um.getToken === 'function'
      ? await capture(() => windowRef.um.getToken.call(windowRef.um, certifyId))
      : null;
    const zUm = certifyId && windowRef.z_um && typeof windowRef.z_um.getToken === 'function'
      ? await capture(() => windowRef.z_um.getToken.call(windowRef.z_um, certifyId))
      : null;
    return {
      um,
      zUm,
      snapshot: {
        reKeys: summarizeObjectKeys(windowRef.__FEILIN_RE__ || windowRef.__FEILIN_EXPORT_RE__),
        aliyunInitStateKeys: summarizeObjectKeys(windowRef.__ALIYUN_INIT_STATE__),
        instanceConfigKeys: summarizeObjectKeys(windowRef.__ALIYUN_LAST_INSTANCE__?.config),
      },
      error: null,
    };
  } catch (error) {
    return {
      um: null,
      zUm: null,
      snapshot: null,
      error: String(error && error.stack || error),
    };
  }
}

function pruneHeavySolverOutputInPlace(output) {
  if (!output || typeof output !== 'object') return output;
  const deleteKeys = [
    'xhrRequests',
    'scriptLoadLogs',
    'selectorLogs',
    'nodeAccessLogs',
    'documentAccessLogs',
    'umObjectSnapshot',
    'zUmObjectSnapshot',
    'aliyunInitStateSnapshot',
    'aliyunInitPreCollectDataSnapshot',
    'aliyunPrecollectSnapshot',
    'aliyunVerifyHelpersSnapshot',
    'aliyunVerifyHelpersSource',
    'peKLogs',
    'peKOutputLogs',
    'peDeflateLogs',
    'verifyDataCallsiteLogs',
    'verifyGCallsiteLogs',
    'verifyVmContext',
    'tVmCalls',
    'tVmLast',
    'tVmInitSnapshot',
    'tVm1020Snapshots',
    'tVm74EntryLogs',
    'tVmApplyLogs',
    'tVmAssignLogs',
    'tVmTrace',
    'tVmGetLogs',
    'btoaLogs',
    'peTyLogs',
    'peTyReturns',
    'preidVLogs',
    'preidNgLogs',
    'wordArrayToStringLogs',
    'base64StringifyLogs',
    'aesEncryptToStringLogs',
    'stringCharCodeLogs',
    'stringFromCharCodeLogs',
    'stringSliceLogs',
    'stringOpLogs',
    'stringCharOpLogs',
    'cryptoTraceLogs',
    'raTraceLogs',
    'jsonStringifyLogs',
    'aliyunRuntimeCredentialLogs',
    'aliyunExtendAssignLogs',
    'joinLogs',
    'rlLogs',
    'feilinIoLogs',
    'feilinIuLogs',
    'mediaDeviceLogs',
    'feilinSbTrace',
    'feilinUbLogs',
    'feilinUyLogs',
    'feilinSessionHelperLogs',
    'feilinUuLogs',
    'feilinUDollarLogs',
    'feilinBeLogs',
    'peTcCalls',
    'peTdCalls',
    'peTy2Calls',
    'peNcCalls',
    'peTs74Logs',
    'dateNowLogs',
    'feilinRsLogs',
    'feilinRsInnerLogs',
    'feilinRsSelectorLogs',
    'feilinRxLogs',
    'feilinRkAccessLogs',
    'preidExprLogs',
    'preidHRealLogs',
    'n0GLogs',
    'n0PartLogs',
    'feilinStLogs',
    'feilinSeSnapshot',
    'feilinSaSnapshot',
    'feilinReSnapshot',
    'feilinRaSnapshot',
    'feilinRkSnapshot',
    'feilinRmSnapshot',
    'feilinRoSnapshot',
    'feilinRuSnapshot',
    'feilinRnSnapshot',
    'aliyunDeviceCvsSnapshot',
    'aliyunDeviceIfrSnapshot',
    'feilinLastSessionDeriveSnapshot',
    'feilinSessionDeriveLogs',
    'feilinDeriveHelperCalls',
    'feilinDeriveSecretBlobSnapshot',
    'feilinDeriveSessionBlobSnapshot',
    'probeJsonParseLogs',
    'probeJsonAccessLogs',
    'probeAssignLogs',
    'extendConsumeLogs',
    'bundleBootstrap',
    'localReplayFullFlow',
    'localReplayCompactFullFlow',
  ];
  for (const key of deleteKeys) {
    delete output[key];
  }
  if (Array.isArray(output.asyncErrors) && output.asyncErrors.length > 8) {
    output.asyncErrors = output.asyncErrors.slice(0, 8);
  }
  if (Array.isArray(output.autoInit) && output.autoInit.length > 8) {
    output.autoInit = output.autoInit.slice(0, 8);
  }
  if (Array.isArray(output.xhrLog) && output.xhrLog.length > 8) {
    output.xhrLog = output.xhrLog.slice(0, 8);
  }
  if (Array.isArray(output.tokenPathLogs) && output.tokenPathLogs.length > 12) {
    output.tokenPathLogs = output.tokenPathLogs.slice(0, 12);
  }
  if (Array.isArray(output.liveVerifyCandidateResponses) && output.liveVerifyCandidateResponses.length > 12) {
    output.liveVerifyCandidateResponses = output.liveVerifyCandidateResponses.slice(0, 12);
  }
  if (Array.isArray(output.liveVerifyCandidateRequests) && output.liveVerifyCandidateRequests.length > 12) {
    output.liveVerifyCandidateRequests = output.liveVerifyCandidateRequests.slice(0, 12);
  }
  if (output.liveVerifyRebuiltFromDeviceConfig) {
    output.liveVerifyRebuiltFromDeviceConfig = {
      runtimeContext: output.liveVerifyRebuiltFromDeviceConfig.runtimeContext
        ? {
          certifyId: output.liveVerifyRebuiltFromDeviceConfig.runtimeContext.certifyId || null,
          nO: output.liveVerifyRebuiltFromDeviceConfig.runtimeContext.nO || null,
          sessionTimestamp: output.liveVerifyRebuiltFromDeviceConfig.runtimeContext.sessionTimestamp || null,
        }
        : null,
      verifyRequest: summarizeVerifyRequestLite(output.liveVerifyRebuiltFromDeviceConfig.verifyRequest),
    };
  }
  if (output.postLiveInitStateProbe) {
    output.postLiveInitStateProbe = {
      um: output.postLiveInitStateProbe.um
        ? {
          tokenLength: output.postLiveInitStateProbe.um.tokenLength || null,
          tokenPreview: output.postLiveInitStateProbe.um.tokenPreview || null,
          decodedPreview: typeof output.postLiveInitStateProbe.um.decoded === 'string'
            ? output.postLiveInitStateProbe.um.decoded.slice(0, 240)
            : null,
          parsed: output.postLiveInitStateProbe.um.parsed || null,
          error: output.postLiveInitStateProbe.um.error || null,
        }
        : null,
      zUm: output.postLiveInitStateProbe.zUm
        ? {
          tokenLength: output.postLiveInitStateProbe.zUm.tokenLength || null,
          tokenPreview: output.postLiveInitStateProbe.zUm.tokenPreview || null,
          decodedPreview: typeof output.postLiveInitStateProbe.zUm.decoded === 'string'
            ? output.postLiveInitStateProbe.zUm.decoded.slice(0, 240)
            : null,
          parsed: output.postLiveInitStateProbe.zUm.parsed || null,
          error: output.postLiveInitStateProbe.zUm.error || null,
        }
        : null,
      snapshotKeys: summarizeObjectKeys(output.postLiveInitStateProbe.snapshot),
      liveCheckChainStateCertifyId: output.postLiveInitStateProbe.liveCheckChainState?.certifyId || null,
      error: output.postLiveInitStateProbe.error || null,
    };
  }
  if (output.dryVmBootstrap) {
    output.dryVmBootstrap = {
      source: output.dryVmBootstrap.source || null,
      tokenPreview: output.dryVmBootstrap.tokenPreview || null,
      verifyRequest: summarizeVerifyRequestLite(output.dryVmBootstrap.verifyRequest),
    };
  }
  if (output.vmVerifyRequest) output.vmVerifyRequest = summarizeVerifyRequestLite(output.vmVerifyRequest);
  if (output.lightLiveProbe) {
    output.lightLiveProbe = {
      ok: output.lightLiveProbe.ok === true,
      error: output.lightLiveProbe.error || null,
      verifyRequest: summarizeVerifyRequestLite(output.lightLiveProbe.verifyRequest),
      xhrActions: Array.isArray(output.lightLiveProbe.xhrActions) ? output.lightLiveProbe.xhrActions.slice(0, 8) : [],
      runtimeState: output.lightLiveProbe.runtimeState
        ? {
          initConfig: output.lightLiveProbe.runtimeState.initConfig || null,
          instanceConfig: output.lightLiveProbe.runtimeState.instanceConfig || null,
          captchaConfig: output.lightLiveProbe.runtimeState.captchaConfig || null,
        }
        : null,
      asyncErrors: Array.isArray(output.lightLiveProbe.asyncErrors) ? output.lightLiveProbe.asyncErrors.slice(0, 6) : [],
    };
  }
  if (output.liveVerifyRequestFromVmXhr) {
    output.liveVerifyRequestFromVmXhr = summarizeVerifyRequestLite(output.liveVerifyRequestFromVmXhr);
  }
  if (output.callbackVerifyRequestSynthesized) {
    output.callbackVerifyRequestSynthesized = summarizeVerifyRequestLite(output.callbackVerifyRequestSynthesized);
  }
  if (output.postLiveInitSyntheticVerifyRequest) {
    output.postLiveInitSyntheticVerifyRequest = summarizeVerifyRequestLite(output.postLiveInitSyntheticVerifyRequest);
  }
  if (output.diagnosticRebuiltLiveVerifyRequest) {
    output.diagnosticRebuiltLiveVerifyRequest = summarizeVerifyRequestLite(output.diagnosticRebuiltLiveVerifyRequest);
  }
  if (output.externalLiveVerify) output.externalLiveVerify = summarizeLiveResponseLite(output.externalLiveVerify);
  if (output.liveInit) output.liveInit = summarizeLiveResponseLite(output.liveInit);
  if (output.liveVerify && output.liveVerifyFromVmXhr !== true) {
    output.liveVerify = summarizeLiveResponseLite(output.liveVerify);
  }
  return output;
}

function buildLiveCheckChainState(report, output = {}) {
  const base = report?.liveCheckChainState && typeof report.liveCheckChainState === 'object'
    ? JSON.parse(JSON.stringify(report.liveCheckChainState))
    : {};
  const runtimeInitCfg = base?.instanceState?.runtimeState?.initConfig || null;
  const runtimeInstanceCfg = base?.instanceState?.runtimeState?.instanceConfig || null;
  const runtimeCaptchaCfg = base?.instanceState?.runtimeState?.captchaConfig || null;
  const canonicalLiveVerifyRequest = pickCanonicalLiveVerifyRequest(output, base);
  const canonicalLiveVerifyResponse = pickCanonicalLiveVerifyResponse(output);
  const syntheticInitFallback = isSyntheticProbeResponse(output?.liveInit) || isSyntheticProbeResponse(base.initRequest);
  const syntheticVerifyFallback = isSyntheticProbeResponse(canonicalLiveVerifyResponse) || isSyntheticProbeResponse(base.verifyRequest);
  const liveVerifyResult = canonicalLiveVerifyResponse?.bodyJson?.Result || null;
  const verifyParam = canonicalLiveVerifyRequest?.params?.CaptchaVerifyParam || base.verifyParam || null;
  const verifyParamChanged =
    typeof verifyParam === 'string' &&
    verifyParam &&
    verifyParam !== base.verifyParam;
  let verifyParamDecoded = (!verifyParamChanged && base.verifyParamDecoded) ? base.verifyParamDecoded : null;
  if (typeof verifyParam === 'string' && verifyParam && !verifyParamDecoded) {
    verifyParamDecoded = tryDecodeBase64Json(verifyParam);
    if (!verifyParamDecoded) {
      try {
        verifyParamDecoded = JSON.parse(verifyParam);
      } catch {
        verifyParamDecoded = null;
      }
    }
  }
  return {
    ...base,
    certifyId:
      sanitizeCredentialValue(output?.verifyPayload?.certifyId) ||
      sanitizeCredentialValue(liveVerifyResult?.certifyId) ||
      sanitizeCredentialValue(output?.liveInit?.bodyJson?.CertifyId) ||
      sanitizeCredentialValue(canonicalLiveVerifyRequest?.params?.CertifyId) ||
      sanitizeCredentialValue(runtimeInitCfg?.certifyId) ||
      sanitizeCredentialValue(runtimeInstanceCfg?.certifyId) ||
      sanitizeCredentialValue(runtimeCaptchaCfg?.certifyId) ||
      sanitizeCredentialValue(base.certifyId) ||
      null,
    securityToken: sanitizeCredentialValue(liveVerifyResult?.securityToken) || sanitizeCredentialValue(base.securityToken) || null,
    verifyParam,
    verifyParamDecoded,
    initRequest: output?.liveInitRequest || output?.initRequest || base.initRequest || null,
    verifyRequest: canonicalLiveVerifyRequest,
    liveVerifyResponse: canonicalLiveVerifyResponse,
    syntheticInitFallback,
    syntheticVerifyFallback,
    canonicalSource: output?.externalLiveVerify?.bodyJson?.Result
      ? 'external-live-verify'
      : canonicalLiveVerifyResponse
      ? 'vm-live-xhr'
      : (canonicalLiveVerifyRequest ? 'vm-live-request-only' : 'runtime-base'),
    vmInitResponse: base.initRequest?.responseJson || null,
    vmVerifyResponse: base.verifyRequest?.responseJson || null,
    vmFailPayload: Array.isArray(report?.autoInit)
      ? report.autoInit.find((item) => item?.type === 'fail')?.payload || null
      : null,
    diagnostics: {
      rebuiltVerifyRequest: output?.diagnosticRebuiltLiveVerifyRequest || null,
      externalLiveVerify: output?.externalLiveVerify || null,
      supplementalReplay: output?.supplementalReplay || null,
      synthesizedFromLiveVerify: output?.synthesizedFromLiveVerify || null,
    },
  };
}

function pickInitRequest(report) {
  const entries = Array.isArray(report?.xhrLog) ? report.xhrLog : [];
  for (const entry of entries) {
    if (entry?.params?.Action === 'InitCaptchaV3') {
      return {
        url: entry.url,
        requestUrl: entry.requestUrl || entry.url,
        params: entry.params,
        headers: entry.requestHeaders || null,
        responseStatus: entry.responseStatus || null,
        responseHeaders: entry.responseHeaders || null,
        responseJson: entry.responseJson || null,
      };
    }
  }
  return null;
}

function serializeForm(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    body.set(key, value == null ? '' : String(value));
  }
  return body.toString();
}

function isoTimestampNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildStage2OffsetPreset() {
  return {
    stringOpTargets: ['WEB_PREID#', 'certifyId', 'sceneId', 'deviceToken'],
    stringCharOpTargets: ['WEB_PREID#'],
    literalSnippetPatches: [
      {
        match: 'y=function(t){er._extend(kn({},t)),Dn({SceneId:o,DeviceToken:er.DeviceToken},er,n,c,p,d)}',
        replace: 'y=function(t){window.__STAGE2_DN_FLOW_LOGS__=window.__STAGE2_DN_FLOW_LOGS__||[],window.__STAGE2_DN_FLOW_LOGS__.push({stage:"reinit-before-extend",sceneId:o||null,inputKeys:t&&typeof t==="object"?Object.keys(t).slice(0,20):null,inputPreview:t&&typeof t==="object"?Object.fromEntries(Object.keys(t).slice(0,12).map(function(k){var v=t[k];return[k,typeof v==="string"?v.slice(0,240):v&&typeof v==="object"?Object.keys(v).slice(0,12):v]})):t,erCertifyId:er.CertifyId||er.certifyId||er.UserCertifyId||null,erDeviceToken:typeof er.DeviceToken==="string"?er.DeviceToken.slice(0,240):er.DeviceToken}),window.__STAGE2_DN_FLOW_LOGS__.length>200&&window.__STAGE2_DN_FLOW_LOGS__.shift(),er._extend(kn({},t)),window.__STAGE2_DN_FLOW_LOGS__.push({stage:"reinit-before-dn",sceneId:o||null,erCertifyId:er.CertifyId||er.certifyId||er.UserCertifyId||null,erDeviceToken:typeof er.DeviceToken==="string"?er.DeviceToken.slice(0,240):er.DeviceToken,erKeys:er&&typeof er==="object"?Object.keys(er).slice(0,30):null}),window.__STAGE2_DN_FLOW_LOGS__.length>200&&window.__STAGE2_DN_FLOW_LOGS__.shift(),Dn({SceneId:o,DeviceToken:er.DeviceToken},er,n,c,p,d)}',
        sentinel: 'STAGE2_DN_REINIT_BEFORE_DN',
      },
      {
        match: 'er._extend({reInitCaptcha:y}),r.next=1,Dn({SceneId:o},er,n,c,p,d);',
        replace: 'er._extend({reInitCaptcha:y}),window.__STAGE2_DN_FLOW_LOGS__=window.__STAGE2_DN_FLOW_LOGS__||[],window.__STAGE2_DN_FLOW_LOGS__.push({stage:"initial-before-dn",sceneId:o||null,erCertifyId:er.CertifyId||er.certifyId||er.UserCertifyId||null,erDeviceToken:typeof er.DeviceToken==="string"?er.DeviceToken.slice(0,240):er.DeviceToken,erKeys:er&&typeof er==="object"?Object.keys(er).slice(0,30):null,dKeys:d&&typeof d==="object"?Object.keys(d).slice(0,20):null}),window.__STAGE2_DN_FLOW_LOGS__.length>200&&window.__STAGE2_DN_FLOW_LOGS__.shift(),r.next=1,Dn({SceneId:o},er,n,c,p,d);',
        sentinel: 'STAGE2_DN_INITIAL_BEFORE_DN',
      },
      {
        match: 'return f&&l&&(t.CertifyId=f),p&&(o?t.UserCertifyId=p:t.UserCheckString=p),De._extend({_prefix:y}),{action:d,_prefix:y}}',
        replace: 'return window.__STAGE2_INIT_STATE_LOGS__=window.__STAGE2_INIT_STATE_LOGS__||[],window.__STAGE2_INIT_STATE_LOGS__.push({stage:"rn-before-return",sceneId:t.SceneId||null,certifyId:t.CertifyId||null,userCertifyId:t.UserCertifyId||null,userCheckString:t.UserCheckString||null,deviceToken:typeof t.DeviceToken==="string"?t.DeviceToken.slice(0,240):t.DeviceToken,isFromTraceless:!!l,configCertifyId:f||null}),window.__STAGE2_INIT_STATE_LOGS__.length>160&&window.__STAGE2_INIT_STATE_LOGS__.shift(),f&&l&&(t.CertifyId=f),p&&(o?t.UserCertifyId=p:t.UserCheckString=p),De._extend({_prefix:y}),{action:d,_prefix:y}}',
        sentinel: '__STAGE2_INIT_STATE_LOGS__',
      },
      {
        match: 'c={sceneId:n,certifyId:i,deviceToken:o||yr(),failover:"T"},u=M()(e),ln!==u&&(c.err=e,ln=u),!r.captchaVerifyCallback||"function"!=typeof r.captchaVerifyCallback){t.next=3;break}return t.next=1,r.captchaVerifyCallback(M()(c),hn.bind(r));',
        replace: 'c={sceneId:n,certifyId:i,deviceToken:o||yr(),failover:"T"},window.__STAGE2_CALLBACK_FLOW_LOGS__=window.__STAGE2_CALLBACK_FLOW_LOGS__||[],window.__STAGE2_CALLBACK_FLOW_LOGS__.push({stage:"pn-before-callback",sceneId:n||null,certifyId:i||null,sourceDeviceTokenPreview:typeof o==="string"?o.slice(0,240):o,generatedDeviceTokenPreview:typeof c.deviceToken==="string"?c.deviceToken.slice(0,320):c.deviceToken,hasCallback:!!r.captchaVerifyCallback}),u=M()(e),ln!==u&&(c.err=e,ln=u),!r.captchaVerifyCallback||"function"!=typeof r.captchaVerifyCallback){t.next=3;break}return t.next=1,r.captchaVerifyCallback(M()(c),hn.bind(r));',
        sentinel: '__STAGE2_CALLBACK_FLOW_LOGS__',
      },
      {
        match: 'if(null!=(a=t.sent)&&"string"==typeof a)return t.abrupt("return",a);',
        replace: 'if(window.__STAGE2_CALLBACK_FLOW_LOGS__=window.__STAGE2_CALLBACK_FLOW_LOGS__||[],window.__STAGE2_CALLBACK_FLOW_LOGS__.push({stage:"pn-after-callback",callbackResultType:typeof(a=t.sent),callbackResultPreview:typeof a==="string"?a.slice(0,400):a}),window.__STAGE2_CALLBACK_FLOW_LOGS__.length>160&&window.__STAGE2_CALLBACK_FLOW_LOGS__.shift(),null!=(a)&&"string"==typeof a)return t.abrupt("return",a);',
        sentinel: 'STAGE2_CALLBACK_AFTER',
      },
      {
        match: 'case 1:!(m=t.sent).Success||m.LimitFlow||m.LimitedFlowToken?(m.LimitedFlowToken?m.CertifyId=m.LimitedFlowToken:m.CertifyId||(m.CertifyId=dr().substring(0,5)),xr("cId",m.CertifyId),n(Ee.ACTION_STATE.FAIL,m)):(e._extend({log:on}),xr("cId",m.CertifyId),!e.isFromTraceless&&De._extend({initialRequestTime:Date.now(),overTime:!1}),m.DeviceConfig&&void 0===Ie.DeviceConfig&&Ie._extend({DeviceConfig:m.DeviceConfig}),en(m.DeviceConfig,y,u,"captcha"),x=be(m,e),n(Ee.ACTION_STATE.SUCCESS,x));',
        replace: 'case 1:window.__STAGE2_INIT_STATE_LOGS__=window.__STAGE2_INIT_STATE_LOGS__||[],window.__STAGE2_INIT_STATE_LOGS__.push({stage:"init-response",success:!!(m=t.sent).Success,limitFlow:!!m.LimitFlow,limitedFlowToken:m.LimitedFlowToken||null,certifyId:m.CertifyId||null,deviceConfigPreview:typeof m.DeviceConfig==="string"?m.DeviceConfig.slice(0,280):m.DeviceConfig,responseKeys:m&&typeof m==="object"?Object.keys(m).slice(0,20):null,isFromTraceless:!!e.isFromTraceless,runtimeDeviceConfigPresent:void 0!==Ie.DeviceConfig}),window.__STAGE2_INIT_STATE_LOGS__.length>160&&window.__STAGE2_INIT_STATE_LOGS__.shift(),!m.Success||m.LimitFlow||m.LimitedFlowToken?(m.LimitedFlowToken?m.CertifyId=m.LimitedFlowToken:m.CertifyId||(m.CertifyId=dr().substring(0,5)),xr("cId",m.CertifyId),n(Ee.ACTION_STATE.FAIL,m)):(e._extend({log:on}),xr("cId",m.CertifyId),!e.isFromTraceless&&De._extend({initialRequestTime:Date.now(),overTime:!1}),m.DeviceConfig&&void 0===Ie.DeviceConfig&&Ie._extend({DeviceConfig:m.DeviceConfig}),window.__STAGE2_INIT_STATE_LOGS__.push({stage:"init-success-commit",certifyId:m.CertifyId||null,deviceConfigPreview:typeof m.DeviceConfig==="string"?m.DeviceConfig.slice(0,280):m.DeviceConfig,runtimeDeviceConfigPresent:void 0!==Ie.DeviceConfig}),window.__STAGE2_INIT_STATE_LOGS__.length>160&&window.__STAGE2_INIT_STATE_LOGS__.shift(),en(m.DeviceConfig,y,u,"captcha"),x=be(m,e),n(Ee.ACTION_STATE.SUCCESS,x));',
        sentinel: 'STAGE2_INIT_RESPONSE',
      },
      {
        match: 'function s(){"1.0"===e.verifyType?e.success&&e.success(u.CertifyId):"3.0"===e.verifyType&&e.success&&e.success(window.btoa(M()({certifyId:u.CertifyId,sceneId:e.SceneId,isSign:!0})))}',
        replace: 'function s(){var __stage2_payload="3.0"===e.verifyType?window.btoa(M()({certifyId:u.CertifyId,sceneId:e.SceneId,isSign:!0})):null;window.__STAGE2_LOCAL_FALLBACK_LOGS__=window.__STAGE2_LOCAL_FALLBACK_LOGS__||[],window.__STAGE2_LOCAL_FALLBACK_LOGS__.push({stage:"local-success-wrapper",verifyType:e.verifyType||null,sceneId:e.SceneId||null,certifyId:u&&u.CertifyId||null,limitFlow:!!(u&&u.LimitFlow),message:u&&u.Message||null,code:u&&u.Code||null,payloadPreview:typeof __stage2_payload==="string"?__stage2_payload.slice(0,280):__stage2_payload}),window.__STAGE2_LOCAL_FALLBACK_LOGS__.length>160&&window.__STAGE2_LOCAL_FALLBACK_LOGS__.shift(),"1.0"===e.verifyType?e.success&&e.success(u.CertifyId):"3.0"===e.verifyType&&e.success&&e.success(__stage2_payload)}',
        sentinel: '__STAGE2_LOCAL_FALLBACK_LOGS__',
      },
      {
        match: 'fn.call(e,{code:v,msg:u.err}),s(),er.onError&&er.onError({code:v,msg:null==u?void 0:u.err}),t(u),pr("networkError")',
        replace: 'fn.call(e,{code:v,msg:u.err}),window.__STAGE2_LOCAL_FALLBACK_LOGS__=window.__STAGE2_LOCAL_FALLBACK_LOGS__||[],window.__STAGE2_LOCAL_FALLBACK_LOGS__.push({stage:"fail-branch-before-local-success",code:v||null,err:u&&u.err||null,message:u&&u.Message||null,certifyId:u&&u.CertifyId||null,limitFlow:!!(u&&u.LimitFlow),captchaType:u&&u.CaptchaType||null,responseKeys:u&&typeof u==="object"?Object.keys(u).slice(0,20):null}),window.__STAGE2_LOCAL_FALLBACK_LOGS__.length>160&&window.__STAGE2_LOCAL_FALLBACK_LOGS__.shift(),s(),er.onError&&er.onError({code:v,msg:null==u?void 0:u.err}),t(u),pr("networkError")',
        sentinel: 'STAGE2_FAIL_BRANCH_LOCAL_SUCCESS',
      },
      {
        match: 'n="1.0"===this.config.verifyType?t:window.btoa(JSON.stringify({certifyId:t,sceneId:this.config.SceneId,isSign:!0,securityToken:this.config.securityToken})),this.success&&this.success(n)',
        replace: 'n="1.0"===this.config.verifyType?t:(window.__STAGE2_PE_BIZ_SUCCESS_LOGS__=window.__STAGE2_PE_BIZ_SUCCESS_LOGS__||[],window.__STAGE2_PE_BIZ_SUCCESS_LOGS__.push({stage:"before-signed-success-json",certifyId:t||null,sceneId:this&&this.config?this.config.SceneId||null:null,securityToken:this&&this.config?this.config.securityToken||null:null,configKeys:this&&this.config&&typeof this.config==="object"?Object.keys(this.config).slice(0,24):null,stack:String((new Error("STAGE2_PE_BIZ_SUCCESS")).stack||"").slice(0,1200)}),window.__STAGE2_PE_BIZ_SUCCESS_LOGS__.length>160&&window.__STAGE2_PE_BIZ_SUCCESS_LOGS__.shift(),window.btoa(JSON.stringify({certifyId:t,sceneId:this.config.SceneId,isSign:!0,securityToken:this.config.securityToken}))),this.success&&this.success(n)',
        sentinel: 'STAGE2_PE_BIZ_SUCCESS',
      },
    ],
    offsetSnippetPatches: [
      {
        offset: 278271,
        radius: 420,
        match: 'return tT=tP[e3.D(eH,(eH(),27),(eH(),47))](tN)||"",-23>e3.H((tT[eH(e3.c(58,~eH),e3.c(77,~eH))]-250)*78,-23)&&(tT=tK(tN)),tT;return e3.e(tK,tN)}catch(t){return e3.e(tK,tN)}',
        replace: 'return tT=tP[e3.D(eH,(eH(),27),(eH(),47))](tN)||"",window.__STAGE2_TOKEN_FALLBACK_LOGS__=window.__STAGE2_TOKEN_FALLBACK_LOGS__||[],window.__STAGE2_TOKEN_FALLBACK_LOGS__.push({stage:"um-or-window-token",input:typeof tN==="string"?tN.slice(0,280):tN,tokenPreview:typeof tT==="string"?tT.slice(0,280):tT,tokenLength:typeof tT==="string"?tT.length:null,stack:String((new Error("STAGE2_TOKEN_FALLBACK")).stack||"").slice(0,1200)}),-23>e3.H((tT[eH(e3.c(58,~eH),e3.c(77,~eH))]-250)*78,-23)&&(tT=tK(tN)),tT;return (function(__out){window.__STAGE2_TOKEN_FALLBACK_LOGS__=window.__STAGE2_TOKEN_FALLBACK_LOGS__||[],window.__STAGE2_TOKEN_FALLBACK_LOGS__.push({stage:"token-fallback-return",input:typeof tN==="string"?tN.slice(0,280):tN,outputPreview:typeof __out==="string"?__out.slice(0,280):__out,outputLength:typeof __out==="string"?__out.length:null,stack:String((new Error("STAGE2_TOKEN_FALLBACK_RETURN")).stack||"").slice(0,1200)}),window.__STAGE2_TOKEN_FALLBACK_LOGS__.length>160&&window.__STAGE2_TOKEN_FALLBACK_LOGS__.shift();return __out})(e3.e(tK,tN))}catch(t){return (function(__out){window.__STAGE2_TOKEN_FALLBACK_LOGS__=window.__STAGE2_TOKEN_FALLBACK_LOGS__||[],window.__STAGE2_TOKEN_FALLBACK_LOGS__.push({stage:"token-fallback-catch",input:typeof tN==="string"?tN.slice(0,280):tN,error:String(t&&t.stack||t),outputPreview:typeof __out==="string"?__out.slice(0,280):__out,outputLength:typeof __out==="string"?__out.length:null,stack:String((new Error("STAGE2_TOKEN_FALLBACK_CATCH")).stack||"").slice(0,1200)}),window.__STAGE2_TOKEN_FALLBACK_LOGS__.length>160&&window.__STAGE2_TOKEN_FALLBACK_LOGS__.shift();return __out})(e3.e(tK,tN))}',
        sentinel: '__STAGE2_TOKEN_FALLBACK_LOGS__',
      },
      {
        offset: 208772,
        radius: 360,
        match: 'p=null===h?l.apply(s,o):h[l].apply(h,o),r[n++]&&e.push(p))',
        replace: 'window.__STAGE2_VM_APPLY_LOGS__=window.__STAGE2_VM_APPLY_LOGS__||[],p=null===h?l.apply(s,o):h[l].apply(h,o),window.__STAGE2_VM_APPLY_LOGS__.push({calleeType:typeof l,calleePreview:typeof l==="function"?String(l).slice(0,240):typeof l==="string"?l.slice(0,240):l,holderType:typeof h,holderKeys:h&&typeof h==="object"?Object.keys(h).slice(0,16):null,argPreview:o.map(function(x){return typeof x==="string"?x.slice(0,240):x&&typeof x==="object"?{tag:Object.prototype.toString.call(x),keys:Object.keys(x).slice(0,12)}:x}),resultType:typeof p,resultPreview:typeof p==="string"?p.slice(0,280):p&&typeof p==="object"?{tag:Object.prototype.toString.call(p),keys:Object.keys(p).slice(0,12)}:p,stack:String((new Error("STAGE2_VM_APPLY")).stack||"").slice(0,1200)}),window.__STAGE2_VM_APPLY_LOGS__.length>240&&window.__STAGE2_VM_APPLY_LOGS__.shift(),r[n++]&&e.push(p))',
        sentinel: '__STAGE2_VM_APPLY_LOGS__',
      },
      {
        offset: 342451,
        radius: 320,
        match: 'nj(ng,a.b(c,[60,c()][0],[11,a.p(c)][0]),f),e=15',
        replace: 'window.__STAGE2_DATA_BUILD_LOGS__=window.__STAGE2_DATA_BUILD_LOGS__||[],window.__STAGE2_DATA_BUILD_LOGS__.push({stage:"nj-before",ngPreview:typeof ng==="string"?ng.slice(0,800):ng,fPreview:typeof f==="string"?f.slice(0,400):f,fLength:typeof f==="string"?f.length:null,computedPreview:(function(){var __v=a.b(c,[60,c()][0],[11,a.p(c)][0]);return typeof __v==="string"?__v.slice(0,800):__v&&typeof __v==="object"?{tag:Object.prototype.toString.call(__v),keys:Object.keys(__v).slice(0,12)}:__v})(),stack:String((new Error("STAGE2_DATA_BUILD")).stack||"").slice(0,1200)}),window.__STAGE2_DATA_BUILD_LOGS__.length>240&&window.__STAGE2_DATA_BUILD_LOGS__.shift(),nj(ng,a.b(c,[60,c()][0],[11,a.p(c)][0]),f),e=15',
        sentinel: '__STAGE2_DATA_BUILD_LOGS__',
      },
      {
        offset: 307955,
        radius: 420,
        match: 'I=nq+(~eH?eH:2)(7,172),u+=-317',
        replace: 'window.__STAGE2_FINAL_JSON_LOGS__=window.__STAGE2_FINAL_JSON_LOGS__||[],window.__STAGE2_FINAL_JSON_LOGS__.push({stage:"before-final-json",nqPreview:typeof nq==="string"?nq.slice(0,400):nq&&typeof nq==="object"?{tag:Object.prototype.toString.call(nq),keys:Object.keys(nq).slice(0,12),sigBytes:Number.isFinite(nq.sigBytes)?nq.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(nq,128):null}:nq,stack:String((new Error("STAGE2_FINAL_JSON")).stack||"").slice(0,1200)}),window.__STAGE2_FINAL_JSON_LOGS__.length>160&&window.__STAGE2_FINAL_JSON_LOGS__.shift(),I=nq+(~eH?eH:2)(7,172),u+=-317',
        sentinel: '__STAGE2_FINAL_JSON_LOGS__',
      },
    ],
  };
}

function refreshSignedCaptchaParams(params) {
  if (!params || typeof params !== 'object') return params;
  const nextParams = {
    ...params,
    Timestamp: isoTimestampNow(),
    SignatureNonce: crypto.randomUUID(),
  };
  nextParams.Signature = signCaptchaParams(nextParams);
  return nextParams;
}

function decodeDeviceTokenPreview(verifyRequest) {
  const plain = decodeDeviceTokenPlain(verifyRequest);
  return typeof plain === 'string' ? plain.slice(0, 300) : null;
}

function pickLiveDeviceConfigSources(report, output = {}) {
  const runtimeInitCfg = report?.liveCheckChainState?.instanceState?.runtimeState?.initConfig || null;
  const runtimeInstanceCfg = report?.liveCheckChainState?.instanceState?.runtimeState?.instanceConfig || null;
  const lightRuntimeInitCfg = output?.lightLiveProbe?.runtimeState?.initConfig || null;
  const lightRuntimeInstanceCfg = output?.lightLiveProbe?.runtimeState?.instanceConfig || null;
  const bodyJson = output?.liveInit?.bodyJson || null;
  const deviceConfigRaw =
    bodyJson?.DeviceConfig ||
    lightRuntimeInitCfg?.deviceConfigRawPreview ||
    lightRuntimeInstanceCfg?.deviceConfigRawPreview ||
    runtimeInitCfg?.deviceConfigRawPreview ||
    runtimeInstanceCfg?.deviceConfigRawPreview ||
    null;
  const deviceConfig =
    lightRuntimeInitCfg?.deviceConfig ||
    lightRuntimeInstanceCfg?.deviceConfig ||
    runtimeInitCfg?.deviceConfig ||
    runtimeInstanceCfg?.deviceConfig ||
    null;
  return {
    deviceConfigRaw: typeof deviceConfigRaw === 'string' && deviceConfigRaw ? deviceConfigRaw : null,
    deviceConfig: deviceConfig && typeof deviceConfig === 'object' ? deviceConfig : null,
  };
}

async function probeLightLiveVerifyState(files, options = {}, sessionContext = null) {
  try {
    const report = await runProbe(files, {
      ...options,
      executeLive: true,
      executeLiveInVm: false,
      captureXhrStacks: false,
      setGlobalAliyunCaptchaConfig: options.setGlobalConfig !== false,
      sessionContext,
    });
    const runtimeState = report?.liveCheckChainState?.instanceState?.runtimeState || null;
    return {
      ok: true,
      verifyRequest: report?.liveCheckChainState?.verifyRequest || null,
      runtimeState,
      xhrActions: Array.isArray(report?.xhrLog)
        ? report.xhrLog.map((x) => x?.params?.Action).filter(Boolean)
        : [],
      asyncErrors: Array.isArray(report?.asyncErrors) ? report.asyncErrors.slice(0, 6) : [],
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.stack || error),
    };
  }
}

function decodeDeviceTokenPlain(verifyRequest) {
  const raw = verifyRequest?.params?.CaptchaVerifyParam;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const token = parsed?.deviceToken;
    if (!token || typeof token !== 'string') return null;
    return Buffer.from(token, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function analyzeThirdSegmentStructure(deviceTokenPlain) {
  if (typeof deviceTokenPlain !== 'string' || !deviceTokenPlain) return null;
  const parts = deviceTokenPlain.split('#');
  const third = parts[2] || '';
  if (!third) {
    return {
      thirdLength: 0,
      splitOk: false,
    };
  }
  try {
    const split = splitPreidH(third);
    const defaultPrefix = Buffer.from(PREID_H_STATIC_PREFIX_BASE64, 'base64');
    let commonPrefixBytes = 0;
    while (
      commonPrefixBytes < Math.min(defaultPrefix.length, split.prefix.length) &&
      defaultPrefix[commonPrefixBytes] === split.prefix[commonPrefixBytes]
    ) {
      commonPrefixBytes += 1;
    }
    return {
      thirdLength: third.length,
      splitOk: true,
      totalBytes: split.buffer.length,
      prefixBytes: split.prefix.length,
      tailBytes: split.tail.length,
      prefixBase64Preview: split.prefix.toString('base64').slice(0, 160),
      defaultPrefixCommonBytes: commonPrefixBytes,
      defaultPrefixExactMatch: commonPrefixBytes === defaultPrefix.length && split.prefix.length === defaultPrefix.length,
    };
  } catch (error) {
    return {
      thirdLength: third.length,
      splitOk: false,
      error: String(error && error.message || error),
    };
  }
}

function extractThirdSegmentFromTokenPlain(deviceTokenPlain) {
  if (typeof deviceTokenPlain !== 'string' || !deviceTokenPlain) return null;
  const parts = deviceTokenPlain.split('#');
  const third = parts[2] || null;
  return typeof third === 'string' && third ? third : null;
}

function commonBufferPrefixLen(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left || '');
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right || '');
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

function commonBufferSuffixLen(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left || '');
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right || '');
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

function compareThirdSegmentBase64(left, right) {
  if (typeof left !== 'string' || !left || typeof right !== 'string' || !right) return null;
  try {
    const a = splitPreidH(left);
    const b = splitPreidH(right);
    return {
      leftLength: left.length,
      rightLength: right.length,
      leftBytes: a.buffer.length,
      rightBytes: b.buffer.length,
      prefixCommonBytes: commonBufferPrefixLen(a.prefix, b.prefix),
      suffixCommonBytes: commonBufferSuffixLen(a.buffer, b.buffer),
      tailCommonBytes: commonBufferPrefixLen(a.tail, b.tail),
      leftPrefixPreview: a.prefix.toString('base64').slice(0, 120),
      rightPrefixPreview: b.prefix.toString('base64').slice(0, 120),
      leftTailPreview: a.tail.toString('base64').slice(0, 120),
      rightTailPreview: b.tail.toString('base64').slice(0, 120),
    };
  } catch (error) {
    return {
      leftLength: left.length,
      rightLength: right.length,
      error: String(error && error.message || error),
    };
  }
}

function collectThirdSegmentCandidates(report, verifyRequest) {
  const candidates = [];
  const pushCandidate = (source, value, extra = null) => {
    if (typeof value !== 'string' || !value) return;
    if (candidates.some((item) => item.value === value)) return;
    candidates.push({
      source,
      value,
      analysis: analyzeThirdSegmentStructure(`x#y#${value}#z#w`),
      ...(extra && typeof extra === 'object' ? extra : {}),
    });
  };

  const verifyThird = extractThirdSegmentFromTokenPlain(decodeDeviceTokenPlain(verifyRequest));
  pushCandidate('verifyRequest.deviceToken.third', verifyThird);

  const join = Array.isArray(report?.verifyGCallsiteLogs)
    ? report.verifyGCallsiteLogs.find((item) => item?.stage === 'join') || null
    : null;
  pushCandidate('verifyGCallsite.join.H', join?.namedParts?.H, {
    joinedLength: join?.joinedLength ?? null,
  });

  const hReal = Array.isArray(report?.preidHRealLogs) ? report.preidHRealLogs[0] || null : null;
  pushCandidate('preidHReal.value', hReal?.valuePreview, {
    decodedBytes: hReal?.decodedBytes ?? null,
  });

  const genericJoinLogs = Array.isArray(report?.joinLogs) ? report.joinLogs : [];
  for (const entry of genericJoinLogs) {
    const parts = Array.isArray(entry?.parts) ? entry.parts : null;
    if (!parts || parts.length < 5) continue;
    const third = typeof parts[2] === 'string' ? parts[2] : null;
    const second = typeof parts[1] === 'string' ? parts[1] : '';
    if (!third || !/^[A-Za-z0-9+/=]{200,}$/.test(third)) continue;
    if (!(second.includes('-h-') || second.includes('SG_WEB') || /[0-9a-f]{32}/i.test(second))) continue;
    pushCandidate('genericJoin.parts[2]', third, {
      separator: entry.separator || null,
      secondPreview: second.slice(0, 160),
      outputPreview: typeof entry.output === 'string' ? entry.output.slice(0, 240) : null,
    });
  }

  const baseline = candidates[0]?.value || null;
  return {
    candidates: candidates.map((item) => ({
      source: item.source,
      fullValue: item.value,
      thirdLength: item.analysis?.thirdLength ?? item.value.length,
      splitOk: item.analysis?.splitOk ?? false,
      decodedBytes: item.analysis?.totalBytes ?? item.decodedBytes ?? null,
      prefixBytes: item.analysis?.prefixBytes ?? null,
      tailBytes: item.analysis?.tailBytes ?? null,
      defaultPrefixCommonBytes: item.analysis?.defaultPrefixCommonBytes ?? null,
      secondPreview: item.secondPreview || null,
      joinedLength: item.joinedLength ?? null,
      outputPreview: item.outputPreview || null,
      preview: item.value.slice(0, 160),
    })),
    pairwiseAgainstBaseline: baseline
      ? candidates.slice(1).map((item) => ({
        baselineSource: candidates[0].source,
        source: item.source,
        compare: compareThirdSegmentBase64(baseline, item.value),
      }))
      : [],
  };
}

function buildDynamicUrlFromStaticPath(staticPath) {
  if (typeof staticPath !== 'string' || !staticPath.trim()) return null;
  const clean = staticPath.trim().replace(/^\/+/, '').replace(/\.js$/i, '');
  if (!clean) return null;
  return `https://g.alicdn.com/captcha-frontend/dynamicJS/${clean}.js`;
}

function buildFeilinUrlFromVersion(versionPath) {
  if (typeof versionPath !== 'string' || !versionPath.trim()) return null;
  const clean = versionPath.trim().replace(/^\/+/, '').replace(/\.js$/i, '');
  if (!clean) return null;
  return `https://g.alicdn.com/captcha-frontend/FeiLin/${clean}.js`;
}

async function downloadTextToFile(url, filePath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0',
    },
  });
  if (!response.ok) {
    throw new Error(`download failed ${response.status} ${response.statusText} for ${url}`);
  }
  const text = await response.text();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, text, 'utf8');
  return {
    url,
    filePath,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function normalizeBrowserLikeTokenPreview(tokenPlain) {
  if (typeof tokenPlain !== 'string' || !tokenPlain) return null;
  const normalized = normalizeToBrowserLikeInitToken(tokenPlain);
  return normalized?.ok ? normalized.normalizedPlain : null;
}

function applyLiveDeviceConfigToSeed(seed, liveDeviceConfig, certifyId) {
  if (!seed?.runtimeContext || !liveDeviceConfig?.sessionId) {
    return seed;
  }
  const rewriteRuntimeCredentialFields = (value, deviceTokenOverride = null) => {
    if (Array.isArray(value)) {
      return value.map((item) => rewriteRuntimeCredentialFields(item, deviceTokenOverride));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      const lowered = String(key).toLowerCase();
      if (certifyId && ['certifyid', 'usercertifyid', 'cid', 'certifiyid'].includes(lowered)) {
        out[key] = certifyId;
        continue;
      }
      if (deviceTokenOverride && lowered === 'devicetoken') {
        out[key] = deviceTokenOverride;
        continue;
      }
      out[key] = rewriteRuntimeCredentialFields(raw, deviceTokenOverride);
    }
    return out;
  };
  const nextVerifyDataPayload = seed.verifyDataPayload && typeof seed.verifyDataPayload === 'object'
    ? rewriteRuntimeCredentialFields(seed.verifyDataPayload)
    : seed.verifyDataPayload;
  return {
    ...seed,
    runtimeContext: {
      ...seed.runtimeContext,
      nO: liveDeviceConfig.sessionId,
      sessionTimestamp: liveDeviceConfig.timestamp || seed.runtimeContext.sessionTimestamp,
      ip: liveDeviceConfig.ip || seed.runtimeContext.ip,
      certifyId: certifyId || seed.runtimeContext.certifyId,
    },
    verifyDataPayload: nextVerifyDataPayload,
  };
}

function rewriteRuntimeCredentialFields(value, certifyId = null, deviceTokenOverride = null) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteRuntimeCredentialFields(item, certifyId, deviceTokenOverride));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const lowered = String(key).toLowerCase();
    if (certifyId && ['certifyid', 'usercertifyid', 'cid', 'certifiyid'].includes(lowered)) {
      out[key] = certifyId;
      continue;
    }
    if (deviceTokenOverride && lowered === 'devicetoken') {
      out[key] = deviceTokenOverride;
      continue;
    }
    out[key] = rewriteRuntimeCredentialFields(raw, certifyId, deviceTokenOverride);
  }
  return out;
}

function inspectCaptchaVerifyParam(verifyRequest) {
  const raw = verifyRequest?.params?.CaptchaVerifyParam;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      keys: Object.keys(parsed),
      certifyId: parsed.certifyId || null,
      sceneId: parsed.sceneId || null,
      dataValue: typeof parsed.data === 'string' ? parsed.data : null,
      deviceTokenPreview: typeof parsed.deviceToken === 'string'
        ? Buffer.from(parsed.deviceToken, 'base64').toString('utf8').slice(0, 600)
        : null,
      deviceTokenPlain: typeof parsed.deviceToken === 'string'
        ? Buffer.from(parsed.deviceToken, 'base64').toString('utf8')
        : null,
      deviceTokenLength: typeof parsed.deviceToken === 'string' ? parsed.deviceToken.length : null,
      dataLength: typeof parsed.data === 'string' ? parsed.data.length : null,
      dataPreview: typeof parsed.data === 'string' ? parsed.data.slice(0, 300) : null,
      riskDataLength: typeof parsed.riskData === 'string' ? parsed.riskData.length : null,
    };
  } catch (err) {
    return { error: String(err && err.stack || err) };
  }
}

function inspectVerifyDataReverse(verifyRequest, peKOutputLogs) {
  const raw = verifyRequest?.params?.CaptchaVerifyParam;
  const kLog = Array.isArray(peKOutputLogs) ? peKOutputLogs[0] : null;
  if (!raw && !kLog) return null;
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    const seed = typeof kLog?.inputPreview === 'string' ? kLog.inputPreview : null;
    const seedPrefix = seed ? seed.slice(0, 32) : null;
    const seedJson = seed && seed.length > 32 ? seed.slice(32) : null;
    let seedJsonParsed = null;
    try {
      seedJsonParsed = seedJson ? JSON.parse(seedJson) : null;
    } catch {
      seedJsonParsed = null;
    }
    return {
      dataValue: typeof parsed?.data === 'string' ? parsed.data : null,
      dataPreview: typeof parsed?.data === 'string' ? parsed.data.slice(0, 300) : null,
      seedLength: seed?.length ?? null,
      seedPrefix,
      seedJson,
      seedJsonParsed,
      transformedLen: kLog?.transformedLen ?? null,
      transformedHexPreview: kLog?.transformedHexPreview ?? null,
    };
  } catch (err) {
    return { error: String(err && err.stack || err) };
  }
}

function rebuildVerifyDataLocally(reverseInfo) {
  const prefixHex = reverseInfo?.seedPrefix;
  const payload = reverseInfo?.seedJsonParsed;
  if (!prefixHex || !payload || typeof payload !== 'object') return null;
  try {
    const rebuilt = encodeVerifyData(prefixHex, payload);
    return {
      rebuilt,
      rebuiltLength: rebuilt.length,
      rebuiltPreview: rebuilt.slice(0, 300),
      matchRuntime: rebuilt === reverseInfo?.dataValue,
    };
  } catch (err) {
    return {
      error: String(err && err.stack || err),
    };
  }
}

function extractVerifyDataRuntimeFrame(report, verifyRequest) {
  const verifyInspection = inspectCaptchaVerifyParam(verifyRequest);
  const rawData = typeof verifyInspection?.dataValue === 'string' ? verifyInspection.dataValue : null;
  const btoaMatch = Array.isArray(report?.btoaLogs) && rawData
    ? report.btoaLogs.find((entry) => entry?.outputPreview === rawData)
    : null;
  const rawBinaryFull = typeof btoaMatch?.inputPreview === 'string' ? btoaMatch.inputPreview : null;
  const frame = Array.isArray(report?.tVmGetLogs)
    ? [...report.tVmGetLogs].reverse().find((x) =>
      x?.f === 'C' &&
      typeof x?.lPreview?.tPreview === 'string' &&
      rawBinaryFull &&
      rawBinaryFull.startsWith(x.lPreview.tPreview)
    ) || [...report.tVmGetLogs].reverse().find((x) => x?.f === 'C')
    : null;
  const runtimeSeedBase64Like = frame?.lPreview?.oPreview || null;
  const initSnapshot = Array.isArray(report?.tVm1020Snapshots)
    ? report.tVm1020Snapshots.find((x) =>
      typeof x?.sPreview?.o === 'string' &&
      runtimeSeedBase64Like &&
      x.sPreview.o === runtimeSeedBase64Like
    ) || null
    : null;
  const matchedRawFromCharCode = (() => {
    const logs = Array.isArray(report?.stringFromCharCodeLogs) ? report.stringFromCharCodeLogs : [];
    if (!rawBinaryFull || !logs.length) return null;
    for (let i = 0; i < logs.length; i += 1) {
      if (logs[i]?.ch !== rawBinaryFull[0]) continue;
      let ok = true;
      for (let j = 1; j < rawBinaryFull.length; j += 1) {
        if (!logs[i + j] || logs[i + j].ch !== rawBinaryFull[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const seq = logs.slice(i, i + rawBinaryFull.length);
        return {
          start: i,
          end: i + rawBinaryFull.length,
          length: seq.length,
          nSet: [...new Set(seq.map((x) => x.n))],
          head: seq.slice(0, 16),
          tail: seq.slice(-16),
        };
      }
    }
    return null;
  })();
  return {
    seedBase64Like: report?.peKOutputLogs?.[0]?.outputPreview || null,
    runtimeSeedBase64Like,
    runtimeSeedToken: frame?.lPreview?.oPreview && typeof frame.lPreview.oPreview === 'string' && frame.lPreview.oPreview.length < 80
      ? frame.lPreview.oPreview
      : null,
    seedCallsite: Array.isArray(report?.verifyDataCallsiteLogs) ? report.verifyDataCallsiteLogs[0] || null : null,
    keyHex: frame?.lPreview?.nPreview || null,
    initialVmState: initSnapshot ? {
      n: initSnapshot.sPreview?.n ?? null,
      e: initSnapshot.sPreview?.e ?? null,
      a: initSnapshot.sPreview?.a ?? null,
      m: initSnapshot.sPreview?.m ?? null,
      oPreview: initSnapshot.sPreview?.o ?? null,
      tPreview: initSnapshot.sPreview?.t ?? null,
    } : null,
    initialPermTable: initSnapshot?.sPreview?.r || null,
    permTable: Array.isArray(frame?.lPreview?.rPreview) ? frame.lPreview.rPreview : null,
    rawBinaryPreview: frame?.lPreview?.tPreview || null,
    rawBinaryFull,
    rawBinaryHex: typeof rawBinaryFull === 'string'
      ? Buffer.from(rawBinaryFull, 'latin1').toString('hex')
      : null,
    rawBinaryLength: typeof rawBinaryFull === 'string' ? rawBinaryFull.length : null,
    finalDataBase64: rawData,
    finalDataLength: typeof rawData === 'string' ? rawData.length : null,
    runtimeHelpers: frame?.lPreview ? {
      CSource: frame.lPreview.CSource || null,
      eSource: frame.lPreview.eSource || null,
      aSource: frame.lPreview.aSource || null,
      hSource: frame.lPreview.hSource || null,
      mSource: frame.lPreview.mSource || null,
      lSource: frame.lPreview.lSource || null,
      cSource: frame.lPreview.cSource || null,
      fSource: frame.lPreview.fSource || null,
      sSource: frame.lPreview.sSource || null,
    } : null,
    matchedRawFromCharCode,
  };
}

function pickInterestingBtoaLogs(logs) {
  const entries = Array.isArray(logs) ? logs : [];
  const umSeed = entries.find((x) =>
    typeof x?.inputPreview === 'string' &&
    x.inputPreview.includes('#####null')
  ) || null;
  const initToken = entries.find((x) =>
    typeof x?.inputPreview === 'string' &&
    x.inputPreview.startsWith('SG_WEB#')
  ) || null;
  const verifyToken = entries.find((x) =>
    typeof x?.inputPreview === 'string' &&
    x.inputPreview.startsWith('SG_WEB_PREID#')
  ) || null;
  return {
    umSeedPreview: umSeed?.inputPreview || null,
    initTokenPlainPreview: initToken?.inputPreview || null,
    verifyTokenPlainPreview: verifyToken?.inputPreview || null,
  };
}

function decodeBase64Utf8(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function deriveStandaloneTokenChecks(report) {
  const rows = [];
  const experiment = report?.sessionIdBlobExperiment;
  const collect = (label, row) => {
    const parsed = row?.parsed;
    if (!parsed?.second) return;
    rows.push({
      label,
      second: parsed.second,
      actualFifth: parsed.fifth || null,
      derivedFifth: computeFifthSegment(parsed.second),
      verify: parsed?.raw ? verifyTokenPlain(parsed.raw) : null,
    });
  };
  collect('baseline', experiment?.baseline);
  for (const row of Array.isArray(experiment?.rows) ? experiment.rows : []) {
    collect(row?.label || 'row', row);
  }
  return rows;
}

function deriveBestVectorThirdRuntimeCandidate(report, vector) {
  if (!vector?.trPreview) return null;
  const rows = Array.isArray(report?.feilinRsLogs) ? report.feilinRsLogs : [];
  const expectedLPreview = buildTokenLPreviewFromVector(vector);
  const matches = rows.filter((row) =>
    row &&
    row.arg0 === vector.trPreview &&
    typeof row.outputString === 'string' &&
    row.outputString !== 'null' &&
    typeof row.arg1 === 'string');
  if (!matches.length) return null;
  const best = [...matches].sort((a, b) => {
    const aExact = a.arg1 === expectedLPreview ? 1 : 0;
    const bExact = b.arg1 === expectedLPreview ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    if ((a.arg1Length || 0) !== (b.arg1Length || 0)) return (b.arg1Length || 0) - (a.arg1Length || 0);
    return (b.outputStringLength || 0) - (a.outputStringLength || 0);
  })[0];
  return {
    arg0: best.arg0,
    arg1Length: best.arg1Length || (typeof best.arg1 === 'string' ? best.arg1.length : null),
    arg1Preview: typeof best.arg1 === 'string' ? best.arg1.slice(0, 600) : null,
    arg1ExactMatchToBestVector: best.arg1 === expectedLPreview,
    outputPreview: best.outputString ? best.outputString.slice(0, 600) : null,
    outputString: best.outputString || null,
    outputStringLength: best.outputStringLength || (typeof best.outputString === 'string' ? best.outputString.length : null),
    outputDecodedPreview: best.outputDecoded || null,
    innerStages: best.innerStages || [],
    stack: best.stack || null,
  };
}

function normalizeVerifyDeviceToken(verifyRequest, initRequest, forceFlag = null) {
  const raw = verifyRequest?.params?.CaptchaVerifyParam;
  if (!raw) return null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const verifyPlain = decodeBase64Utf8(payload.deviceToken);
  const initPlain = decodeBase64Utf8(initRequest?.params?.DeviceToken);
  if (!verifyPlain) return null;
  const verifyParts = verifyPlain.split('#');
  const initParts = initPlain ? initPlain.split('#') : [];
  if (verifyParts.length < 5) return null;
  const nextParts = [...verifyParts];
  const initLooksLikeRollingVerifyToken = (
    initParts.length >= 5 &&
    typeof initParts[2] === 'string' &&
    initParts[2].length >= 200
  );
  const normalizePrefix = (value) => {
    if (typeof value !== 'string' || !value) return null;
    if (value === 'WEB_PREID') return 'WEB';
    if (value === 'SG_WEB_PREID') return 'SG_WEB';
    return value;
  };
  const verifyPrefix = normalizePrefix(verifyParts[0]);
  const initPrefix = normalizePrefix(initParts[0]);
  const preferredPrefix =
    verifyPrefix && initPrefix && verifyPrefix !== initPrefix
      ? verifyPrefix
      : (initPrefix || verifyPrefix);
  if (preferredPrefix) {
    nextParts[0] = preferredPrefix;
  }
  if (initLooksLikeRollingVerifyToken && initParts[1]) {
    nextParts[1] = initParts[1];
  }
  if (forceFlag) {
    nextParts[3] = forceFlag;
  } else if (
    initLooksLikeRollingVerifyToken &&
    typeof initParts[3] === 'string' &&
    initParts[3] !== ''
  ) {
    nextParts[3] = initParts[3];
  }
  const nextPlain = nextParts.join('#');
  const nextPayload = {
    ...payload,
    deviceToken: Buffer.from(nextPlain, 'utf8').toString('base64'),
  };
  return {
    plain: nextPlain,
    verifyPlain,
    initPlain,
    initLooksLikeRollingVerifyToken,
    payload: nextPayload,
  };
}

function isRollingVerifyLikeTokenPlain(tokenPlain) {
  if (typeof tokenPlain !== 'string' || !tokenPlain) return false;
  const parts = tokenPlain.split('#');
  return parts.length >= 5 && typeof parts[2] === 'string' && parts[2].length >= 200;
}

function buildSyntheticLog1DeviceConfig(loaderPath) {
  const appKey = '3795d28242a11619bc25f786f84e53d4';
  const sessionId = `${appKey}-h-${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
  const wrap = (value) => value ? Buffer.from(String(value), 'utf8').toString('base64') : '';
  return encodeDeviceConfigParts([
    wrap(appKey),
    wrap('513'),
    sessionId,
    '3.25.0',
    wrap(''),
    wrap(''),
    wrap(''),
    String(Date.now()),
    '1.2.3.4',
  ]);
}

function buildLatestBrowserProfile(overrides = {}) {
  const base = {
    locationHref: 'https://chat.z.ai/c/live-probe',
    referrer: '',
    navigatorOverrides: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      appVersion: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
    },
    navigatorLanguages: ['en-US', 'en'],
    screenOverrides: {
      width: 1536,
      height: 864,
      availWidth: 1536,
      availHeight: 824,
      colorDepth: 24,
      pixelDepth: 24,
    },
    autoInitLanguage: 'en',
    autoInitConfig: {
      language: 'en',
      upLang: true,
    },
    requestHeaders: {
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Priority': 'u=1, i',
      'Referer': '',
      'Sec-Ch-Ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Linux"',
    },
  };
  return {
    ...base,
    ...overrides,
    navigatorOverrides: {
      ...base.navigatorOverrides,
      ...(overrides.navigatorOverrides || {}),
    },
    screenOverrides: {
      ...base.screenOverrides,
      ...(overrides.screenOverrides || {}),
    },
    autoInitConfig: {
      ...base.autoInitConfig,
      ...(overrides.autoInitConfig || {}),
    },
    requestHeaders: {
      ...base.requestHeaders,
      ...(overrides.requestHeaders || {}),
    },
  };
}

function buildCookieHeader(documentCookie = null, cookieSeed = null) {
  const cookieMap = new Map();
  if (typeof documentCookie === 'string' && documentCookie.trim()) {
    for (const part of documentCookie.split(/;\s*/)) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) cookieMap.set(key, value);
    }
  }
  if (cookieSeed && typeof cookieSeed === 'object' && !Array.isArray(cookieSeed)) {
    for (const [key, value] of Object.entries(cookieSeed)) {
      cookieMap.set(String(key), value == null ? '' : String(value));
    }
  }
  return [...cookieMap.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function executeVerifyRequest(verifyRequest, sessionContext) {
  if (!verifyRequest?.url || !verifyRequest?.params) {
    throw new Error('missing verifyRequest');
  }
  return await executeFormRequest(verifyRequest.url, verifyRequest.params, sessionContext);
}

function parseJsonObjectSafe(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function applyDeviceTokenOverrideToCaptchaVerifyPayload(payload, deviceToken) {
  if (!payload || typeof payload !== 'object' || !deviceToken) {
    return payload;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'deviceToken')) {
    payload.deviceToken = deviceToken;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'DeviceToken')) {
    payload.DeviceToken = deviceToken;
  }
  if (payload.arg && typeof payload.arg === 'object') {
    if (Object.prototype.hasOwnProperty.call(payload.arg, 'deviceToken')) {
      payload.arg.deviceToken = deviceToken;
    }
    if (Object.prototype.hasOwnProperty.call(payload.arg, 'DeviceToken')) {
      payload.arg.DeviceToken = deviceToken;
    }
  }
  return payload;
}

function collectLiveVerifyDeviceTokenCandidates(
  report,
  liveDeviceConfig,
  initRequest,
  freshInitParams,
  extraTokens = [],
) {
  const out = [];
  const seen = new Set();
  const push = (source, token) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    out.push({ source, token: normalized });
  };

  for (const extra of Array.isArray(extraTokens) ? extraTokens : []) {
    if (!extra || typeof extra !== 'object') continue;
    push(extra.source || 'extra-token', extra.token);
  }

  push('live-device-config.deviceToken', liveDeviceConfig?.deviceToken);
  push('live-device-config.DeviceToken', liveDeviceConfig?.DeviceToken);

  const dnFlow = Array.isArray(report?.stage2OffsetLogs?.dnFlow)
    ? report.stage2OffsetLogs.dnFlow
    : [];
  for (const row of dnFlow) {
    push('dn-flow.erDeviceToken', row?.erDeviceToken);
    push('dn-flow.deviceToken', row?.deviceToken);
    push('dn-flow.DeviceToken', row?.DeviceToken);
  }

  push('fresh-init.DeviceToken', freshInitParams?.DeviceToken);
  push('init-request.DeviceToken', initRequest?.params?.DeviceToken);
  return out.sort((a, b) => {
    const aPlain = decodeBase64Utf8(a?.token);
    const bPlain = decodeBase64Utf8(b?.token);
    const aRolling = isRollingVerifyLikeTokenPlain(aPlain) ? 1 : 0;
    const bRolling = isRollingVerifyLikeTokenPlain(bPlain) ? 1 : 0;
    if (aRolling !== bRolling) return bRolling - aRolling;
    const aLen = typeof aPlain === 'string' ? aPlain.length : 0;
    const bLen = typeof bPlain === 'string' ? bPlain.length : 0;
    return bLen - aLen;
  });
}

function buildLiveVerifyRequestCandidate(baseVerifyRequest, {
  certifyId,
  deviceTokenOverride = null,
  applyOuterDeviceToken = false,
  rewritePayloadCertifyId = true,
  rewriteInnerDeviceToken = true,
  rewriteVerifyData = true,
  normalizeVerifyToken = false,
  freshInitDeviceToken = null,
  verifyDataReverseInfo = null,
} = {}) {
  if (!baseVerifyRequest?.url || !baseVerifyRequest?.params?.CaptchaVerifyParam) {
    return null;
  }

  const nextParams = refreshSignedCaptchaParams({
    ...baseVerifyRequest.params,
    CertifyId: certifyId,
  });

  if (deviceTokenOverride && applyOuterDeviceToken) {
    nextParams.DeviceToken = deviceTokenOverride;
  }

  const parsed = parseJsonObjectSafe(nextParams.CaptchaVerifyParam);
  if (!parsed) {
    return null;
  }

  let rewrittenPayload = JSON.parse(JSON.stringify(parsed));
  if (rewritePayloadCertifyId || (deviceTokenOverride && rewriteInnerDeviceToken)) {
    rewrittenPayload = rewriteRuntimeCredentialFields(
      rewrittenPayload,
      rewritePayloadCertifyId ? certifyId : null,
      (deviceTokenOverride && rewriteInnerDeviceToken) ? deviceTokenOverride : null,
    );
  }
  if (rewritePayloadCertifyId) {
    rewrittenPayload.certifyId = certifyId;
  }
  if (deviceTokenOverride && rewriteInnerDeviceToken) {
    applyDeviceTokenOverrideToCaptchaVerifyPayload(rewrittenPayload, deviceTokenOverride);
  }
  if (
    rewriteVerifyData &&
    typeof rewrittenPayload.data === 'string' &&
    verifyDataReverseInfo?.seedPrefix &&
    verifyDataReverseInfo?.seedJsonParsed &&
    typeof verifyDataReverseInfo.seedJsonParsed === 'object'
  ) {
    try {
      const rebuiltVerifySeed = rewriteRuntimeCredentialFields(
        JSON.parse(JSON.stringify(verifyDataReverseInfo.seedJsonParsed)),
        certifyId,
        deviceTokenOverride,
      );
      rewrittenPayload.data = encodeVerifyData(verifyDataReverseInfo.seedPrefix, rebuiltVerifySeed);
    } catch {
      // ignore verifyData rebuild errors and keep minimal mutation path
    }
  }
  nextParams.CaptchaVerifyParam = JSON.stringify(rewrittenPayload);

  let normalizeDebug = null;
  if (normalizeVerifyToken) {
    const normalizedForLiveVerify = normalizeVerifyDeviceToken(
      { params: nextParams },
      { params: { DeviceToken: freshInitDeviceToken } },
    );
    if (normalizedForLiveVerify) {
      normalizedForLiveVerify.payload.certifyId = certifyId;
      applyDeviceTokenOverrideToCaptchaVerifyPayload(
        normalizedForLiveVerify.payload,
        deviceTokenOverride,
      );
      nextParams.CaptchaVerifyParam = JSON.stringify(normalizedForLiveVerify.payload);
      normalizeDebug = {
        normalized: true,
        verifyPlainPreview: typeof normalizedForLiveVerify.verifyPlain === 'string'
          ? normalizedForLiveVerify.verifyPlain.slice(0, 800)
          : null,
        initPlainPreview: typeof normalizedForLiveVerify.initPlain === 'string'
          ? normalizedForLiveVerify.initPlain.slice(0, 800)
          : null,
        plainPreview: typeof normalizedForLiveVerify.plain === 'string'
          ? normalizedForLiveVerify.plain.slice(0, 800)
          : null,
      };
    } else {
      normalizeDebug = {
        normalized: false,
        reason: 'normalizeVerifyDeviceToken-returned-null',
      };
    }
  } else {
    normalizeDebug = {
      normalized: false,
      reason: 'normalizeVerifyToken-disabled',
    };
  }

  nextParams.Signature = signCaptchaParams(nextParams);
  return {
    request: {
      url: baseVerifyRequest.url,
      params: nextParams,
    },
    meta: {
      certifyId,
      deviceToken: deviceTokenOverride || nextParams.DeviceToken || null,
      applyOuterDeviceToken,
      rewritePayloadCertifyId,
      rewriteInnerDeviceToken,
      rewriteVerifyData,
      parsedPayloadKeys: Object.keys(rewrittenPayload),
      normalizeDebug,
    },
  };
}

function buildSyntheticLiveVerifyBaseRequest({
  sceneId,
  certifyId,
  deviceToken,
  data,
  url,
}) {
  if (!sceneId || !certifyId || !deviceToken || !data || !url) {
    return null;
  }
  const payload = {
    sceneId,
    certifyId,
    deviceToken,
    data,
  };
  return buildVerifyCaptchaV3Request({
    timestamp: isoTimestampNow(),
    nonce: crypto.randomUUID(),
    sceneId,
    certifyId,
    captchaVerifyParam: payload,
    url,
  });
}

function summarizeLiveVerifyCandidateResult(candidate, response, error = null) {
  const result = response?.bodyJson?.Result || null;
  return {
    source: candidate?.source || 'unknown',
    baseSource: candidate?.baseSource || null,
    deviceTokenSource: candidate?.deviceTokenSource || null,
    sentCertifyId: candidate?.request?.params?.CertifyId || null,
    sentDeviceToken: candidate?.request?.params?.DeviceToken || null,
    verifyCode: result?.VerifyCode || null,
    verifyResult: result?.VerifyResult === true,
    returnedCertifyId: result?.CertifyId || result?.certifyId || response?.bodyJson?.CertifyId || null,
    securityTokenPresent: typeof result?.securityToken === 'string' && result.securityToken.length > 0,
    responseCode: response?.bodyJson?.Code || null,
    ok: response?.ok === true,
    error: error ? String(error && error.stack || error) : null,
  };
}

function scoreLiveVerifyCandidateResult(summary) {
  if (!summary || summary.error) return -100;
  if (summary.securityTokenPresent) return 1000;
  if (summary.verifyResult) return 900;
  if (summary.verifyCode === 'T001') return 800;
  if (summary.verifyCode === 'F011') return 300;
  if (summary.verifyCode === 'F002') return 250;
  if (summary.verifyCode === 'F008') return 200;
  if (summary.verifyCode === 'F001') return 100;
  if (summary.ok) return 50;
  return 0;
}

function isBetterLiveVerifyCandidateResult(nextSummary, currentSummary) {
  return scoreLiveVerifyCandidateResult(nextSummary) > scoreLiveVerifyCandidateResult(currentSummary);
}

function rewriteUploadLogCertifyId(params, certifyId) {
  if (!params || !certifyId || !params.log) {
    return params;
  }
  try {
    const parsedLog = JSON.parse(String(params.log));
    if (!parsedLog || typeof parsedLog !== 'object') {
      return params;
    }
    parsedLog.cId = certifyId;
    const nextParams = { ...params, log: JSON.stringify(parsedLog) };
    nextParams.Signature = signCaptchaParams(nextParams);
    return nextParams;
  } catch {
    return params;
  }
}

async function replaySupplementalCaptchaActions(report, certifyId, sessionContext) {
  const xhrLog = Array.isArray(report?.xhrLog) ? report.xhrLog : [];
  if (!xhrLog.length || !certifyId) {
    return [];
  }
  const byAction = new Map();
  for (const entry of xhrLog) {
    const action = entry?.params?.Action;
    if (typeof action === 'string' && !byAction.has(action)) {
      byAction.set(action, entry);
    }
  }
  const order = ['Log1', 'UploadLog', 'Log2', 'Log3'];
  const responses = [];
  for (const action of order) {
    const entry = byAction.get(action);
    if (!entry?.url || !entry?.params || typeof entry.params !== 'object') {
      continue;
    }
    let params = refreshSignedCaptchaParams({ ...entry.params });
    if (action === 'UploadLog') {
      params = rewriteUploadLogCertifyId(params, certifyId);
    }
    try {
      const response = await executeFormRequest(entry.url, params, sessionContext);
      responses.push({
        action,
        status: response.status,
        ok: response.ok,
        code: response.bodyJson?.Code || null,
        verifyCode: response.bodyJson?.Result?.VerifyCode || null,
        certifyId,
      });
    } catch (error) {
      responses.push({
        action,
        ok: false,
        certifyId,
        error: String(error && error.stack || error),
      });
    }
  }
  return responses;
}

async function executeFormRequest(url, params, sessionContext) {
  if (!url || !params) {
    throw new Error('missing form request params');
  }
  const effectiveUrl = sessionContext?.requestUrlRewriteMap?.[url] || url;
  const body = serializeForm(params);
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://chat.z.ai',
    'Referer': '',
    'Sec-Ch-Ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Linux"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site'
  };
  if (sessionContext?.requestHeaders && typeof sessionContext.requestHeaders === 'object') {
    Object.assign(headers, sessionContext.requestHeaders);
  }
  if (sessionContext && sessionContext.cookie) {
    headers['Cookie'] = sessionContext.cookie;
  }
  const response = await fetch(effectiveUrl, {
    method: 'POST',
    headers,
    body,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  
  if (sessionContext) {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const cookies = [];
      if (sessionContext.cookie) {
        cookies.push(...sessionContext.cookie.split(';').map(c => c.trim()).filter(Boolean));
      }
      const newCookies = setCookie.split(/,(?=[^;]+=[^;]+)/).map(c => c.trim());
      for (const rawCookie of newCookies) {
        const match = rawCookie.match(/^([^;]+)/);
        if (match) {
          const pair = match[1].trim();
          const eqIdx = pair.indexOf('=');
          if (eqIdx !== -1) {
            const key = pair.substring(0, eqIdx).trim();
            const filtered = cookies.filter(c => !c.startsWith(key + '='));
            filtered.push(pair);
            cookies.length = 0;
            cookies.push(...filtered);
          }
        }
      }
      sessionContext.cookie = cookies.join('; ');
    }
  }

  return {
    requestUrl: effectiveUrl,
    requestHeaders: { ...headers },
    requestBody: body,
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    bodyText: text,
    bodyJson: json,
  };
}

function parseCliOptions(argv = process.argv.slice(2)) {
  const getArgv = (name, fallback = null) => {
    const idx = argv.indexOf(name);
    if (idx === -1) return fallback;
    return argv[idx + 1] ?? fallback;
  };
  const getJsonArgv = (name, fallback = null) => {
    const raw = getArgv(name);
    if (!raw) return fallback;
    return JSON.parse(raw);
  };
  const loaderPath = argv[2] || '/tmp/AliyunCaptcha.js';
  const securityToken = getArgv('--security-token');
  const forceCallbackMode = argv.includes('--force-callback-mode');
  const stage2OffsetPreset = argv.includes('--stage2-offset-preset');
  const executeLive = argv.includes('--execute-live') || stage2OffsetPreset;
  const executeLiveInVm = argv.includes('--execute-live-in-vm') || stage2OffsetPreset;
  const documentCookie = getArgv('--document-cookie');
  const locationHref = getArgv('--location-href');
  const referrer = getArgv('--referrer');
  const syntheticEvents = getJsonArgv('--synthetic-events');
  const localStorageSeed = getJsonArgv('--local-storage-seed');
  const sessionStorageSeed = getJsonArgv('--session-storage-seed');
  const cookieSeed = getJsonArgv('--cookie-seed');
  const navigatorOverrides = getJsonArgv('--navigator-overrides');
  const screenOverrides = getJsonArgv('--screen-overrides');
  const navigatorLanguages = getJsonArgv('--navigator-languages');
  const log1DeviceToken = getArgv('--log1-device-token');
  const log1ResultObject = getJsonArgv('--log1-result-object');
  const log2Response = getJsonArgv('--log2-response');
  const mediaScenario = getArgv('--media-scenario');
  const log1DeviceConfigArg = getArgv('--log1-device-config');
  const autoInitConfig = getJsonArgv('--auto-init-config');
  const requestHeaders = getJsonArgv('--request-headers');
  const setGlobalConfig = !argv.includes('--no-global-config');
  const executeLiveInit = !argv.includes('--no-execute-live-init');
  const normalizeVerifyToken = argv.includes('--normalize-verify-token');
  const ioMutationExperiment = argv.includes('--io-mutation-experiment');
  const iuMutationExperiment = argv.includes('--iu-mutation-experiment');
  const manualTokenExperiment = argv.includes('--manual-token-experiment');
  const extendTableExperiment = argv.includes('--extend-table-experiment');
  const reMutationExperiment = argv.includes('--re-mutation-experiment');
  const sessionIdBlobExperiment = argv.includes('--sessionid-blob-experiment');
  const customSessionIdBlobBase64 = getArgv('--custom-sessionid-blob-base64');
  const failSyntheticInit = argv.includes('--fail-synthetic-init');
  const syntheticLog1DeviceConfig = log1DeviceConfigArg
    ? log1DeviceConfigArg
    : null;
  const files = argv.filter((x, i, arr) => {
    if (x === '--security-token') return false;
    if (x === '--document-cookie') return false;
    if (x === '--location-href') return false;
    if (x === '--referrer') return false;
    if (x === '--synthetic-events') return false;
    if (x === '--local-storage-seed') return false;
    if (x === '--session-storage-seed') return false;
    if (x === '--cookie-seed') return false;
    if (x === '--navigator-overrides') return false;
    if (x === '--screen-overrides') return false;
    if (x === '--navigator-languages') return false;
    if (x === '--log1-device-token') return false;
    if (x === '--log1-result-object') return false;
    if (x === '--log2-response') return false;
    if (x === '--media-scenario') return false;
    if (x === '--log1-device-config') return false;
    if (x === '--auto-init-config') return false;
    if (x === '--request-headers') return false;
    if (x === '--custom-sessionid-blob-base64') return false;
    const prev = arr[i - 1];
    if ([
      '--security-token',
      '--document-cookie',
      '--location-href',
      '--referrer',
      '--synthetic-events',
      '--local-storage-seed',
      '--session-storage-seed',
      '--cookie-seed',
      '--navigator-overrides',
      '--screen-overrides',
      '--navigator-languages',
      '--log1-device-token',
      '--log1-result-object',
      '--log2-response',
      '--media-scenario',
      '--log1-device-config',
      '--auto-init-config',
      '--request-headers',
      '--custom-sessionid-blob-base64',
    ].includes(prev)) return false;
    if (x === '--force-callback-mode') return false;
    if (x === '--execute-live') return false;
    if (x === '--execute-live-in-vm') return false;
    if (x === '--no-execute-live-init') return false;
    if (x === '--normalize-verify-token') return false;
    if (x === '--io-mutation-experiment') return false;
    if (x === '--iu-mutation-experiment') return false;
    if (x === '--manual-token-experiment') return false;
    if (x === '--extend-table-experiment') return false;
    if (x === '--re-mutation-experiment') return false;
    if (x === '--sessionid-blob-experiment') return false;
    if (x === '--stage2-offset-preset') return false;
    if (x === '--custom-sessionid-blob-base64') return false;
    if (x === '--no-global-config') return false;
    if (x === '--no-synthetic-log1-device-config') return false;
    return true;
  });
  return {
    files,
    loaderPath,
    securityToken,
    forceCallbackMode,
    executeLive,
    executeLiveInVm,
    documentCookie,
    locationHref,
    referrer,
    syntheticEvents,
    localStorageSeed,
    sessionStorageSeed,
    cookieSeed,
    navigatorOverrides,
    screenOverrides,
    navigatorLanguages,
    log1DeviceToken,
    log1ResultObject,
    log2Response,
    mediaScenario,
    syntheticLog1DeviceConfig,
    autoInitConfig,
    requestHeaders,
    setGlobalConfig,
    executeLiveInit,
    failSyntheticInit,
    normalizeVerifyToken,
    ioMutationExperiment,
    iuMutationExperiment,
    manualTokenExperiment,
    extendTableExperiment,
    reMutationExperiment,
    sessionIdBlobExperiment,
    stage2OffsetPreset,
    customSessionIdBlobBase64,
  };
}

async function solveCaptcha(options = {}) {
  const {
    files: inputFiles = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: inputLoaderPath = inputFiles[2] || '/tmp/AliyunCaptcha.js',
    loaderOnly = false,
    scriptFetchMode = null,
    scriptFetchCacheDir = null,
    scriptMappings = undefined,
    securityToken = null,
    initCertifyId = null,
    fallbackCertifyId = null,
    forceCallbackMode = false,
    executeLive = false,
    executeLiveInVm = false,
    documentCookie = null,
    locationHref = null,
    referrer = null,
    syntheticEvents = null,
    localStorageSeed = null,
    sessionStorageSeed = null,
    cookieSeed = null,
    navigatorOverrides = null,
    screenOverrides = null,
    navigatorLanguages = null,
    windowOverrides = null,
    log1DeviceToken = null,
    log1ResultObject = null,
    log2Response = null,
    mediaScenario = null,
    syntheticLog1DeviceConfig = undefined,
    autoInitLanguage = null,
    autoInitConfig = null,
    requestHeaders = null,
    requestUrlRewriteMap = null,
    initialAliyunCaptchaConfig = null,
    setGlobalConfig = true,
    executeLiveInit = true,
    normalizeVerifyToken = false,
    ioMutationExperiment = false,
    iuMutationExperiment = false,
    manualTokenExperiment = false,
    extendTableExperiment = false,
    reMutationExperiment = false,
    sessionIdBlobExperiment = false,
    stage2OffsetPreset = false,
    failSyntheticInit = false,
    customSessionIdBlobBase64 = null,
    staticPathRetry = true,
    skipDryVmBootstrap = false,
    enableDryVmBootstrap = false,
    enableRecursiveStaticPathRetry = false,
    deviceDataOverrideExperimentInputs = null,
    deviceObjectOverrideExperimentInputs = null,
    reMutationExperimentInputs = null,
    rkMutationExperimentInputs = null,
    rsExperimentInputs = null,
    rsAidReplayExperiment = false,
    directRxSessionIdBase64 = null,
    directRxTr = null,
    cryptoTraceTargets = null,
    raTraceTargets = null,
    stringOpTargets = null,
    stringCharOpTargets = null,
    stringSliceTargets = null,
    literalSnippetPatches = null,
    offsetSnippetPatches = null,
    mutateInitAliyunCaptchaConfig = false,
    slimOutput = false,
    enablePostLiveInitRuntimeProbe = false,
    enableLightLiveProbe = false,
  } = options;

  const effectiveExecuteLive = executeLive || stage2OffsetPreset === true;
  const effectiveExecuteLiveInVm = executeLiveInVm || stage2OffsetPreset === true;
  const effectiveInitCertifyId =
    sanitizeCredentialValue(initCertifyId) ||
    sanitizeCredentialValue(fallbackCertifyId) ||
    null;

  const stage2Preset = stage2OffsetPreset ? buildStage2OffsetPreset() : null;
  const effectiveStringOpTargets = stage2Preset
    ? [...new Set([...(Array.isArray(stringOpTargets) ? stringOpTargets : []), ...stage2Preset.stringOpTargets])]
    : stringOpTargets;
  const effectiveStringCharOpTargets = stage2Preset
    ? [...new Set([...(Array.isArray(stringCharOpTargets) ? stringCharOpTargets : []), ...stage2Preset.stringCharOpTargets])]
    : stringCharOpTargets;
  const effectiveOffsetSnippetPatches = stage2Preset
    ? [...(Array.isArray(offsetSnippetPatches) ? offsetSnippetPatches : []), ...stage2Preset.offsetSnippetPatches]
    : offsetSnippetPatches;
  const effectiveLiteralSnippetPatches = stage2Preset
    ? [...(Array.isArray(literalSnippetPatches) ? literalSnippetPatches : []), ...stage2Preset.literalSnippetPatches]
    : literalSnippetPatches;

  let bundle;
  if (loaderOnly) {
    bundle = await ensureAliyunBundleFiles({
      loaderPath: inputLoaderPath,
    });
  } else {
    bundle = await ensureAliyunBundleFiles({
      feilinPath: inputFiles[0],
      dynamicPath: inputFiles[1],
      loaderPath: inputLoaderPath,
    });
  }
  const files = loaderOnly ? [bundle.loaderPath] : bundle.files;
  const loaderPath = bundle.loaderPath;
  const effectiveSyntheticLog1DeviceConfig = syntheticLog1DeviceConfig === undefined
    ? null
    : syntheticLog1DeviceConfig;

  // Do not silently rewrite the CN no8xfe endpoints to southeast.
  // That crosses the runtime state between CN init/device config and SG verify paths,
  // which produces SG_WEB tokens under a CN session and reliably triggers F001.
  const defaultRequestUrlRewriteMap = null;
  const sessionCookieHeader = buildCookieHeader(documentCookie, cookieSeed);
  const sessionContext = {
    cookie: sessionCookieHeader,
    requestHeaders: requestHeaders || null,
    requestUrlRewriteMap: requestUrlRewriteMap || defaultRequestUrlRewriteMap,
  };
  const effectiveScriptMappings =
    scriptMappings !== undefined
      ? scriptMappings
      : (loaderOnly ? [] : undefined);

  const report = await runProbe(files, {
    executeLive: effectiveExecuteLive && effectiveExecuteLiveInVm,
    scriptFetchMode,
    scriptFetchCacheDir,
    ...(effectiveScriptMappings !== undefined ? { scriptMappings: effectiveScriptMappings } : {}),
    initCertifyId: effectiveInitCertifyId,
    sessionContext,
    failSyntheticInit,
    injectCaptchaVerifyCallback: forceCallbackMode ? true : false,
    initialAliyunCaptchaConfig: initialAliyunCaptchaConfig || {
      region: 'sgp',
      prefix: 'no8xfe',
    },
    captureXhrStacks: true,
    setGlobalAliyunCaptchaConfig: setGlobalConfig,
    log1DeviceConfig: effectiveSyntheticLog1DeviceConfig || undefined,
    log1DeviceToken: log1DeviceToken || undefined,
    log1ResultObject: log1ResultObject || undefined,
    log2Response: log2Response || undefined,
    mediaScenario: mediaScenario || undefined,
    documentCookie,
    locationHref,
    referrer,
    syntheticEventsBeforeTrigger: syntheticEvents,
    localStorageSeed,
    sessionStorageSeed,
    cookieSeed,
    navigatorOverrides,
    screenOverrides,
    navigatorLanguages,
    windowOverrides,
    autoInitLanguage,
    autoInitConfig,
    ioMutationExperiment,
    iuMutationExperiment,
    manualTokenExperiment,
    extendTableExperiment,
    reMutationExperiment,
    sessionIdBlobExperiment,
    customSessionIdBlobBase64,
    deviceDataOverrideExperimentInputs,
    deviceObjectOverrideExperimentInputs,
    reMutationExperimentInputs,
    rkMutationExperimentInputs,
    rsExperimentInputs,
    rsAidReplayExperiment,
    directRxSessionIdBase64,
    directRxTr,
    cryptoTraceTargets,
    raTraceTargets,
    stringOpTargets: effectiveStringOpTargets,
    stringCharOpTargets: effectiveStringCharOpTargets,
    stringSliceTargets,
    literalSnippetPatches: effectiveLiteralSnippetPatches,
    offsetSnippetPatches: effectiveOffsetSnippetPatches,
    mutateInitAliyunCaptchaConfig,
  });
  const verifyPayload = pickCallbackPayload(report);
  const successPayload = pickSuccessPayload(report);
  const initRequest = pickInitRequest(report);
  const verifyRequest = pickVerifyRequest(report);
  const verifyDataReverse = inspectVerifyDataReverse(verifyRequest, report.peKOutputLogs);
  const tokenVectors = collectTokenVectorsFromReport(report);
  const bestTokenVector = buildTokenVectorFromReport(report);
  const initDeviceTokenPlain = decodeBase64Utf8(initRequest?.params?.DeviceToken);
  const umTokenPlain = decodeBase64Utf8(report.getTokenValue || report.getTokenValuePreview);
  const zUmTokenPlain = decodeBase64Utf8(report.zGetTokenValue || report.zGetTokenValuePreview);
  const postAutoInitUmTokenPlain = decodeBase64Utf8(report.postAutoInitGetTokenValue || report.postAutoInitGetTokenValuePreview);
  const postAutoInitZUmTokenPlain = decodeBase64Utf8(report.postAutoInitZGetTokenValue || report.postAutoInitZGetTokenValuePreview);
  const postAutoInitUmTokenWithCertifyIdPlain = decodeBase64Utf8(
    report.postAutoInitGetTokenWithCertifyIdValue || report.postAutoInitGetTokenWithCertifyIdPreview,
  );
  const postAutoInitZUmTokenWithCertifyIdPlain = decodeBase64Utf8(
    report.postAutoInitZGetTokenWithCertifyIdValue || report.postAutoInitZGetTokenWithCertifyIdPreview,
  );
  const initDeviceTokenPreview = initDeviceTokenPlain ? initDeviceTokenPlain.slice(0, 300) : null;
  const umTokenPreview = umTokenPlain ? umTokenPlain.slice(0, 300) : null;
  const zUmTokenPreview = zUmTokenPlain ? zUmTokenPlain.slice(0, 300) : null;
  const postAutoInitUmTokenPreview = postAutoInitUmTokenPlain ? postAutoInitUmTokenPlain.slice(0, 300) : null;
  const postAutoInitZUmTokenPreview = postAutoInitZUmTokenPlain ? postAutoInitZUmTokenPlain.slice(0, 300) : null;
  const browserLikeInitDeviceTokenPreview =
    normalizeBrowserLikeTokenPreview(postAutoInitUmTokenWithCertifyIdPlain) ||
    normalizeBrowserLikeTokenPreview(postAutoInitZUmTokenWithCertifyIdPlain) ||
    normalizeBrowserLikeTokenPreview(postAutoInitUmTokenPlain) ||
    normalizeBrowserLikeTokenPreview(postAutoInitZUmTokenPlain) ||
    normalizeBrowserLikeTokenPreview(initDeviceTokenPlain) ||
    normalizeBrowserLikeTokenPreview(postAutoInitUmTokenPreview) ||
    normalizeBrowserLikeTokenPreview(postAutoInitZUmTokenPreview) ||
    normalizeBrowserLikeTokenPreview(umTokenPreview) ||
    normalizeBrowserLikeTokenPreview(zUmTokenPreview) ||
    null;

  const minimalXhrLog = Array.isArray(report.xhrLog)
    ? report.xhrLog.map((x) => ({
      action: x?.params?.Action || null,
      url: x?.url || null,
      requestUrl: x?.requestUrl || x?.url || null,
      params: x?.params || null,
      requestHeaders: x?.requestHeaders || null,
      responseStatus: x?.responseStatus || null,
      responseHeaders: slimOutput ? null : (x?.responseHeaders || null),
      responseJson: x?.responseJson || null,
      responsePreview: !slimOutput && typeof x?.response === 'string' ? x.response.slice(0, 1200) : null,
    }))
    : [];
  const output = {
    evalOk: report.evalOk,
    autoInit: report.autoInit || [],
    verifyPayload,
    initRequest,
    verifyRequest,
    successPayload,
    xhrActions: minimalXhrLog.map((x) => x?.action).filter(Boolean),
    xhrLog: minimalXhrLog,
    asyncErrors: report.asyncErrors || [],
    mode: forceCallbackMode ? 'callback' : 'direct-internal-verify',
    deviceTokenPreview: decodeDeviceTokenPreview(verifyRequest),
    initDeviceTokenPreview,
    browserLikeInitDeviceTokenPreview,
    umTokenPreview,
    zUmTokenPreview,
    postAutoInitUmTokenPreview,
    postAutoInitZUmTokenPreview,
    postAutoInitUmTokenWithCertifyIdPreview: postAutoInitUmTokenWithCertifyIdPlain
      ? postAutoInitUmTokenWithCertifyIdPlain.slice(0, 300)
      : null,
    postAutoInitZUmTokenWithCertifyIdPreview: postAutoInitZUmTokenWithCertifyIdPlain
      ? postAutoInitZUmTokenWithCertifyIdPlain.slice(0, 300)
      : null,
    liveCheckChainState: report.liveCheckChainState || null,
    stage2OffsetLogs: slimOutput ? null : (report.stage2OffsetLogs || null),
    tokenPathLogs: slimOutput ? [] : (report.tokenPathLogs || []),
    feilinIoExposed: report.feilinIoExposed || false,
    feilinIuExposed: report.feilinIuExposed || false,
    ioMutationExperiment: report.ioMutationExperiment || null,
    iuMutationExperiment: report.iuMutationExperiment || null,
    manualTokenExperiment: report.manualTokenExperiment || null,
    extendTableExperiment: report.extendTableExperiment || null,
    reMutationExperiment: report.reMutationExperiment || null,
    deviceDataOverrideExperiment: report.deviceDataOverrideExperiment || null,
    deviceObjectOverrideExperiment: report.deviceObjectOverrideExperiment || null,
    reMutationApplied: report.reMutationApplied || null,
    rkMutationApplied: report.rkMutationApplied || null,
    sessionIdBlobExperiment: report.sessionIdBlobExperiment || null,
    customSessionIdBlobResult: report.customSessionIdBlobResult || null,
    rsExperiment: report.rsExperiment || null,
    directRxSessionResult: report.directRxSessionResult || null,
    standaloneTokenChecks: slimOutput ? null : deriveStandaloneTokenChecks(report),
    tokenVectors: slimOutput ? null : tokenVectors,
    tokenVector: bestTokenVector,
    bestVectorThirdRuntimeCandidate: slimOutput ? null : deriveBestVectorThirdRuntimeCandidate(report, bestTokenVector),
    verifyParamInspection: inspectCaptchaVerifyParam(verifyRequest),
    verifyThirdSegmentAnalysis: analyzeThirdSegmentStructure(decodeDeviceTokenPlain(verifyRequest)),
    thirdSegmentCandidates: slimOutput ? [] : collectThirdSegmentCandidates(report, verifyRequest),
    verifyDataReverse,
    verifyDataLocalRebuild: rebuildVerifyDataLocally(verifyDataReverse),
    verifyDataRuntimeFrame: slimOutput ? null : extractVerifyDataRuntimeFrame(report, verifyRequest),
    syntheticLog1DeviceConfig: effectiveSyntheticLog1DeviceConfig || null,
    documentCookie: report.documentCookie,
    localStorageSnapshot: slimOutput ? null : report.localStorageSnapshot,
    sessionStorageSnapshot: slimOutput ? null : report.sessionStorageSnapshot,
    bundleBootstrap: slimOutput ? null : bundle,
  };
  if (!slimOutput) {
    Object.assign(output, {
      xhrRequests: Array.isArray(report.xhrLog)
        ? report.xhrLog.map((x) => ({
          action: x?.params?.Action || null,
          url: x?.url || null,
          stack: x?.stack ? String(x.stack).slice(0, 1200) : null,
        }))
        : [],
      scriptLoadLogs: report.scriptLoadLogs || [],
      selectorLogs: report.selectorLogs || [],
      nodeAccessLogs: report.nodeAccessLogs || [],
      documentAccessLogs: report.documentAccessLogs || [],
      umGetTokenSourcePreview: report.getTokenSourcePreview || null,
      zUmGetTokenSourcePreview: report.zGetTokenSourcePreview || null,
      umCameraInfoPreview: report.umCameraInfoPreview || null,
      zUmCameraInfoPreview: report.zUmCameraInfoPreview || null,
      umObjectSnapshot: report.umObjectSnapshot || null,
      zUmObjectSnapshot: report.zUmObjectSnapshot || null,
      aliyunInitStateSnapshot: report.aliyunInitStateSnapshot || null,
      aliyunInitPreCollectDataSnapshot: report.aliyunInitPreCollectDataSnapshot || null,
      aliyunPrecollectSnapshot: report.aliyunPrecollectSnapshot || null,
      initAliyunCaptchaType: report.initAliyunCaptchaType || null,
      initAliyunCaptchaPreview: report.initAliyunCaptchaPreview || null,
      initAliyunCaptchaCalls: report.initAliyunCaptchaCalls || [],
      feilinDeviceDataEntries: report.feilinDeviceDataEntries || [],
      aliyunVerifyHelpersSnapshot: report.aliyunVerifyHelpersSnapshot || null,
      aliyunVerifyHelpersSource: report.aliyunVerifyHelpersSource || null,
      peKLogs: report.peKLogs || [],
      peKOutputLogs: report.peKOutputLogs || [],
      peDeflateLogs: report.peDeflateLogs || [],
      verifyDataCallsiteLogs: report.verifyDataCallsiteLogs || [],
      verifyGCallsiteLogs: report.verifyGCallsiteLogs || [],
      verifyVmContext: report.verifyVmContext || null,
      tVmCalls: report.tVmCalls || [],
      tVmLast: report.tVmLast || null,
      tVmInitSnapshot: report.tVmInitSnapshot || null,
      tVm1020Snapshots: report.tVm1020Snapshots || [],
      tVm74EntryLogs: report.tVm74EntryLogs || [],
      tVmApplyLogs: report.tVmApplyLogs || [],
      tVmAssignLogs: report.tVmAssignLogs || [],
      tVmTrace: report.tVmTrace || [],
      tVmGetLogs: report.tVmGetLogs || [],
      btoaLogs: report.btoaLogs || [],
      peTyLogs: report.peTyLogs || [],
      peTyReturns: report.peTyReturns || [],
      preidVLogs: report.preidVLogs || [],
      preidNgLogs: report.preidNgLogs || [],
      wordArrayToStringLogs: report.wordArrayToStringLogs || [],
      base64StringifyLogs: report.base64StringifyLogs || [],
      aesEncryptToStringLogs: report.aesEncryptToStringLogs || [],
      stringCharCodeLogs: report.stringCharCodeLogs || [],
      stringFromCharCodeLogs: report.stringFromCharCodeLogs || [],
      stringSliceLogs: report.stringSliceLogs || [],
      stringOpLogs: report.stringOpLogs || [],
      stringCharOpLogs: report.stringCharOpLogs || [],
      cryptoTraceLogs: report.cryptoTraceLogs || [],
      raTraceLogs: report.raTraceLogs || [],
      btoaInteresting: pickInterestingBtoaLogs(report.btoaLogs),
      jsonStringifyLogs: report.jsonStringifyLogs || [],
      aliyunRuntimeCredentialLogs: report.aliyunRuntimeCredentialLogs || [],
      aliyunExtendAssignLogs: report.aliyunExtendAssignLogs || [],
      joinLogs: report.joinLogs || [],
      rlLogs: report.rlLogs || [],
      feilinIoLogs: report.feilinIoLogs || [],
      feilinIuLogs: report.feilinIuLogs || [],
      mediaDeviceLogs: report.mediaDeviceLogs || [],
      feilinSbTrace: report.feilinSbTrace || [],
      feilinUbLogs: report.feilinUbLogs || [],
      feilinUyLogs: report.feilinUyLogs || [],
      feilinSessionHelperLogs: report.feilinSessionHelperLogs || [],
      feilinUuLogs: report.feilinUuLogs || [],
      feilinUDollarLogs: report.feilinUDollarLogs || [],
      feilinBeLogs: report.feilinBeLogs || [],
      peTcCalls: report.peTcCalls || [],
      peTdCalls: report.peTdCalls || [],
      peTy2Calls: report.peTy2Calls || [],
      peNcCalls: report.peNcCalls || [],
      peTs74Logs: report.peTs74Logs || [],
      dateNowLogs: report.dateNowLogs || [],
      feilinRsLogs: report.feilinRsLogs || [],
      feilinRsInnerLogs: report.feilinRsInnerLogs || [],
      feilinRsSelectorLogs: report.feilinRsSelectorLogs || [],
      rsAidReplayExperiment: report.rsAidReplayExperiment || null,
      feilinRxLogs: report.feilinRxLogs || [],
      feilinRkAccessLogs: report.feilinRkAccessLogs || [],
      preidExprLogs: report.preidExprLogs || [],
      preidHRealLogs: report.preidHRealLogs || [],
      n0GLogs: report.n0GLogs || [],
      n0PartLogs: report.n0PartLogs || [],
      feilinStLogs: report.feilinStLogs || [],
      feilinSeSnapshot: report.feilinSeSnapshot || null,
      feilinSaSnapshot: report.feilinSaSnapshot || null,
      feilinReSnapshot: report.feilinReSnapshot || null,
      feilinRaSnapshot: report.feilinRaSnapshot || null,
      feilinRkSnapshot: report.feilinRkSnapshot || null,
      feilinRmSnapshot: report.feilinRmSnapshot || null,
      feilinRoSnapshot: report.feilinRoSnapshot || null,
      feilinRuSnapshot: report.feilinRuSnapshot || null,
      feilinRnSnapshot: report.feilinRnSnapshot || null,
      aliyunDeviceCvsSnapshot: report.aliyunDeviceCvsSnapshot || null,
      aliyunDeviceIfrSnapshot: report.aliyunDeviceIfrSnapshot || null,
      feilinLastSessionDeriveSnapshot: report.feilinLastSessionDeriveSnapshot || null,
      feilinSessionDeriveLogs: report.feilinSessionDeriveLogs || [],
      feilinDeriveHelperCalls: report.feilinDeriveHelperCalls || [],
      feilinDeriveSecretBlobSnapshot: report.feilinDeriveSecretBlobSnapshot || null,
      feilinDeriveSessionBlobSnapshot: report.feilinDeriveSessionBlobSnapshot || null,
      probeJsonParseLogs: report.probeJsonParseLogs || [],
      probeJsonAccessLogs: report.probeJsonAccessLogs || [],
      probeAssignLogs: report.probeAssignLogs || [],
      extendConsumeLogs: report.extendConsumeLogs || [],
      feilinReSnapshotAfterMutation: report.feilinReSnapshotAfterMutation || null,
      feilinRkSnapshotAfterMutation: report.feilinRkSnapshotAfterMutation || null,
    });
  }

  if (!output.successPayload) {
    const autoInitSuccess = pickSuccessPayload({ autoInit: output.autoInit });
    if (autoInitSuccess?.captcha_verify_param) {
      output.successPayload = autoInitSuccess;
    }
  }

  if (!output.browserLikeInitDeviceTokenPreview || !output.initDeviceTokenPreview) {
    try {
      if (![files[0], files[1], loaderPath].every((path) => typeof path === 'string' && path && fs.existsSync(path))) {
        output.directVmFallback = {
          skipped: true,
          reason: 'bundle files missing for direct-vm fallback',
          files: [files[0] || null, files[1] || null, loaderPath || null],
        };
      } else {
      const runtime = await FeilinVmRuntime.create({
        feilinPath: files[0],
        dynamicPath: files[1],
        loaderPath,
      });
      await Promise.resolve(runtime.callSvInit());
      const browserLike = runtime.getBrowserLikeInitDeviceToken();
      output.directVmFallback = {
        browserLikeInitDeviceTokenPreview: browserLike?.plain || null,
        runtimeDeviceTokenPreview: runtime.getRuntimeDeviceToken()?.plain || null,
        preferredDeviceTokenPreview: runtime.getPreferredDeviceToken()?.plain || null,
      };
      if (!output.browserLikeInitDeviceTokenPreview && browserLike?.plain) {
        output.browserLikeInitDeviceTokenPreview = browserLike.plain;
      }
      if (!output.initDeviceTokenPreview && browserLike?.plain) {
        output.initDeviceTokenPreview = browserLike.plain;
      }
      }
    } catch (error) {
      output.directVmFallback = {
        error: String(error && error.stack || error),
      };
    }
  }

  output.localPreidExactRuntimeIv = rebuildPreidUsingRuntimeIvFromSolverResult(output);
  output.localPreidDeterministicIv0 = rebuildPreidFromSolverResult(output, {
    iv: Buffer.alloc(16, 0),
  });
  output.localPreidRuntimeIvIndependent = rebuildPreidFromSolverResult(output);

  const payloadForSynthesis = extractPayloadForSynthesis(output);
  const runtimeCaptchaVerifyPayload = verifyRequest?.params?.CaptchaVerifyParam
    ? (() => {
      try {
        return JSON.parse(verifyRequest.params.CaptchaVerifyParam);
      } catch {
        return null;
      }
    })()
    : null;

  if (
    payloadForSynthesis?.certifyId &&
    payloadForSynthesis?.sceneId &&
    output.verifyDataReverse?.seedPrefix &&
    output.verifyDataReverse?.seedJsonParsed
  ) {
    if (output.localPreidExactRuntimeIv?.ok && output.localPreidExactRuntimeIv?.rebuilt?.preidPlain) {
      output.localCaptchaVerifyParamExactRuntimeIv = buildCaptchaVerifyParam({
        certifyId: payloadForSynthesis.certifyId,
        sceneId: payloadForSynthesis.sceneId,
        preidPlain: output.localPreidExactRuntimeIv.rebuilt.preidPlain,
        data: output.verifyDataLocalRebuild?.rebuilt,
      });
      output.localCaptchaVerifyParamExactRuntimeIvCompare = compareCaptchaVerifyParam(
        runtimeCaptchaVerifyPayload,
        output.localCaptchaVerifyParamExactRuntimeIv,
      );
    }
    if (output.localPreidDeterministicIv0?.ok && output.localPreidDeterministicIv0?.rebuilt?.preidPlain) {
      output.localCaptchaVerifyParamDeterministicIv0 = buildCaptchaVerifyParam({
        certifyId: payloadForSynthesis.certifyId,
        sceneId: payloadForSynthesis.sceneId,
        preidPlain: output.localPreidDeterministicIv0.rebuilt.preidPlain,
        data: output.verifyDataLocalRebuild?.rebuilt,
      });
      output.localCaptchaVerifyParamDeterministicIv0Compare = compareCaptchaVerifyParam(
        runtimeCaptchaVerifyPayload,
        output.localCaptchaVerifyParamDeterministicIv0,
      );
    }
  }

  const join = Array.isArray(output.verifyGCallsiteLogs)
    ? output.verifyGCallsiteLogs.find((item) => item?.stage === 'join') || null
    : null;
  const initSecondSegment = join?.namedParts?.nO || null;
  if (initRequest?.params?.Timestamp && initRequest?.params?.SignatureNonce && initRequest?.params?.SceneId && initSecondSegment) {
    output.localInitRequestExact = buildInitCaptchaV3Request({
      timestamp: initRequest.params.Timestamp,
      nonce: initRequest.params.SignatureNonce,
      sceneId: initRequest.params.SceneId,
      deviceSecondSegment: initSecondSegment,
      language: initRequest.params.Language,
      mode: initRequest.params.Mode,
      url: initRequest.url,
    });
    output.localInitRequestExactCompare = compareRequestShape(initRequest, output.localInitRequestExact);
  }
  if (
    verifyRequest?.params?.Timestamp &&
    verifyRequest?.params?.SignatureNonce &&
    verifyRequest?.params?.SceneId &&
    verifyRequest?.params?.CertifyId &&
    output.localCaptchaVerifyParamExactRuntimeIv
  ) {
    output.localVerifyRequestExact = buildVerifyCaptchaV3Request({
      timestamp: verifyRequest.params.Timestamp,
      nonce: verifyRequest.params.SignatureNonce,
      sceneId: verifyRequest.params.SceneId,
      certifyId: verifyRequest.params.CertifyId,
      captchaVerifyParam: output.localCaptchaVerifyParamExactRuntimeIv,
      url: verifyRequest.url,
    });
    output.localVerifyRequestExactCompare = compareRequestShape(verifyRequest, output.localVerifyRequestExact);
  }

  if (output.localPreidExactRuntimeIv?.ok) {
    const preview = output.localPreidExactRuntimeIv.context?.snapshotPreview || null;
    const deviceCfg = preview?.deviceConfig?.value || {};
    const deviceData = preview?.deviceData?.value || {};
    output.localGeneratedRuntimeContextSeed = buildPreidRuntimeContext({
      prefix: preview?.prefix?.value,
      region: preview?.region?.value,
      appName: preview?.appName?.value,
      appKey: preview?.appKey?.value,
      nO: output.localPreidExactRuntimeIv.context?.nO,
      sessionTimestamp: deviceCfg.timestamp,
      initTime: preview?.initTime?.value,
      finalTimestamp: output.localPreidExactRuntimeIv.context?.finalTimestamp,
      token71: deviceData.asf65445,
      certifyId: deviceData.xcvbrt454,
      fontsNum: preview?.preCollectData?.value?.fontsNum,
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
    });
    output.localGeneratedSnapshotPreview = buildSnapshotPreviewFromRuntimeContext(output.localGeneratedRuntimeContextSeed);
    output.localGeneratedPreid = computePreidFromRuntimeContext(output.localGeneratedRuntimeContextSeed, {
      iv: output.localPreidExactRuntimeIv.rebuilt.iv,
    });
    output.localGeneratedPreidCompare = {
      tTMatch: output.localGeneratedPreid.tT === output.localPreidExactRuntimeIv.rebuilt.tT,
      hMatch: output.localGeneratedPreid.H === output.localPreidExactRuntimeIv.rebuilt.H,
      ngMatch: output.localGeneratedPreid.ng === output.localPreidExactRuntimeIv.rebuilt.ng,
      preidPlainMatch: output.localGeneratedPreid.preidPlain === output.localPreidExactRuntimeIv.rebuilt.preidPlain,
    };
  }

  if (normalizeVerifyToken && verifyRequest && initRequest?.params?.DeviceToken) {
    const normalized = normalizeVerifyDeviceToken(verifyRequest, initRequest);
    if (normalized) {
      verifyRequest.params.CaptchaVerifyParam = JSON.stringify(normalized.payload);
      verifyRequest.params.Signature = signCaptchaParams(verifyRequest.params);
      output.normalizedVerifyTokenPreview = normalized.plain.slice(0, 800);
      output.verifyParamInspection = inspectCaptchaVerifyParam(verifyRequest);
    }
  }

  if (payloadForSynthesis && securityToken) {
    output.synthesizedFromSecurityToken = synthesizeCaptchaVerifyParamFromSolverResult(output, securityToken) || {
      captcha_verify_param: encodeFinalCaptchaVerifyParam({
        certifyId: payloadForSynthesis.certifyId,
        sceneId: payloadForSynthesis.sceneId,
        securityToken,
      }),
      decoded: {
        certifyId: payloadForSynthesis.certifyId,
        sceneId: payloadForSynthesis.sceneId,
        isSign: true,
        securityToken,
      },
    };
  }

  if (effectiveExecuteLive && !effectiveExecuteLiveInVm && enableLightLiveProbe) {
    output.lightLiveProbe = await probeLightLiveVerifyState(files, {
      ...options,
      executeLive: true,
      executeLiveInVm: false,
      stage2OffsetPreset: false,
    }, sessionContext);
    if (output.lightLiveProbe?.verifyRequest?.params?.CaptchaVerifyParam) {
      output.lightLiveVerifyRequest = summarizeVerifyRequestLite(output.lightLiveProbe.verifyRequest);
    }
  }

  if (effectiveExecuteLive && initRequest) {
    const vmVerifyEntry = report.xhrLog?.find((x) => x?.params?.Action === 'VerifyCaptchaV3');
    if (vmVerifyEntry?.url && vmVerifyEntry?.params) {
      output.vmVerifyRequest = {
        url: vmVerifyEntry.url,
        requestUrl: vmVerifyEntry.requestUrl || vmVerifyEntry.url,
        params: { ...vmVerifyEntry.params },
        requestHeaders: vmVerifyEntry.requestHeaders || null,
        responseStatus: vmVerifyEntry.responseStatus || null,
        responseHeaders: vmVerifyEntry.responseHeaders || null,
        responseJson: vmVerifyEntry.responseJson || null,
      };
      output.liveVerifyRequestFromVmXhr = {
        url: vmVerifyEntry.url,
        requestUrl: vmVerifyEntry.requestUrl || vmVerifyEntry.url,
        params: { ...vmVerifyEntry.params },
        requestHeaders: vmVerifyEntry.requestHeaders || null,
      };
    }
    if (vmVerifyEntry?.responseJson) {
      const verifyResult = vmVerifyEntry.responseJson?.Result?.VerifyResult;
      const verifyCode = vmVerifyEntry.responseJson?.Result?.VerifyCode;
      output.liveVerify = {
        status: verifyResult === true ? 200 : 400,
        ok: verifyResult === true,
        headers: {},
        bodyText: vmVerifyEntry.response,
        bodyJson: vmVerifyEntry.responseJson,
      };
      output.liveVerifyFromVmXhr = true;
      if (verifyCode && verifyResult !== true) {
        output.liveVerifyFromVmXhrFailure = {
          verifyCode,
          message: vmVerifyEntry.responseJson?.Message || null,
        };
      }
    }

    output.liveCheckChainState = buildLiveCheckChainState(report, output);
    const callbackPayloadForVerify = extractPayloadForSynthesis(output);
    if (
      !verifyRequest &&
      initRequest?.url &&
      callbackPayloadForVerify?.sceneId &&
      callbackPayloadForVerify?.certifyId &&
      callbackPayloadForVerify?.deviceToken &&
      callbackPayloadForVerify?.data
    ) {
      try {
        output.callbackVerifyRequestSynthesized = buildVerifyCaptchaV3Request({
          timestamp: isoTimestampNow(),
          nonce: crypto.randomUUID(),
          sceneId: callbackPayloadForVerify.sceneId,
          certifyId: callbackPayloadForVerify.certifyId,
          captchaVerifyParam: callbackPayloadForVerify,
          url: initRequest.url,
        });
      } catch (error) {
        output.callbackVerifyRequestSynthesizedError = String(error && error.stack || error);
      }
    }

    const sessionContext = {
      cookie: sessionCookieHeader,
      requestHeaders: requestHeaders || null,
      requestUrlRewriteMap: requestUrlRewriteMap || defaultRequestUrlRewriteMap,
    };
    let diagnosticVerifyRequest = verifyRequest || output.callbackVerifyRequestSynthesized || null;
    let synthesisBase = output;
    let pendingLiveVerifyCandidateRequests = [];
    const shouldAttemptExternalLiveVerify =
      (!output.liveVerify || output.liveVerify.ok !== true) &&
      executeLiveInit &&
      initRequest;
    if (shouldAttemptExternalLiveVerify) {
      const freshInitParams = refreshSignedCaptchaParams(initRequest.params);
      let rollingInitDeviceTokenPlain =
        decodeDeviceTokenPlain(output.lightLiveProbe?.verifyRequest) ||
        decodeDeviceTokenPlain(output.vmVerifyRequest) ||
        decodeDeviceTokenPlain(output.liveVerifyRequestFromVmXhr) ||
        decodeDeviceTokenPlain(output.callbackVerifyRequestSynthesized) ||
        output.verifyParamInspection?.deviceTokenPlain ||
        decodeDeviceTokenPlain(verifyRequest) ||
        null;
      let dryVmBootstrapVerifyRequest = null;
      if (
        enableDryVmBootstrap &&
        !skipDryVmBootstrap &&
        !isRollingVerifyLikeTokenPlain(rollingInitDeviceTokenPlain)
      ) {
        try {
          const bootstrap = await solveCaptcha({
            ...options,
            executeLive: true,
            executeLiveInVm: true,
            executeLiveInit: false,
            staticPathRetry: false,
            skipDryVmBootstrap: true,
          });
          dryVmBootstrapVerifyRequest = bootstrap?.vmVerifyRequest || null;
          const bootstrapTokenPlain = decodeDeviceTokenPlain(dryVmBootstrapVerifyRequest);
          if (isRollingVerifyLikeTokenPlain(bootstrapTokenPlain)) {
            rollingInitDeviceTokenPlain = bootstrapTokenPlain;
            output.dryVmBootstrap = {
              source: 'recursive-solveCaptcha',
              verifyRequest: dryVmBootstrapVerifyRequest,
              tokenPreview: bootstrapTokenPlain.slice(0, 800),
            };
          }
        } catch (error) {
          output.dryVmBootstrapError = String(error && error.stack || error);
        }
      }
      const effectiveBrowserLikeInitDeviceTokenPlain =
        rollingInitDeviceTokenPlain ||
        output.browserLikeInitDeviceTokenPreview ||
        browserLikeInitDeviceTokenPreview ||
        null;
      if (effectiveBrowserLikeInitDeviceTokenPlain) {
        freshInitParams.DeviceToken = Buffer.from(effectiveBrowserLikeInitDeviceTokenPlain, 'utf8').toString('base64');
        freshInitParams.Signature = signCaptchaParams(freshInitParams);
        output.liveInitDeviceTokenNormalizedPreview = effectiveBrowserLikeInitDeviceTokenPlain.slice(0, 800);
      }
      output.liveInitRequest = {
        url: initRequest.url,
        params: freshInitParams,
      };
      output.liveInit = await executeFormRequest(initRequest.url, freshInitParams, sessionContext);
      output.liveInitRequest = {
        url: initRequest.url,
        requestUrl: output.liveInit?.requestUrl || initRequest.url,
        params: freshInitParams,
        requestHeaders: output.liveInit?.requestHeaders || null,
        requestBody: output.liveInit?.requestBody || null,
      };
      const vmStaticPath = report?.liveCheckChainState?.vmInitResponse?.StaticPath || null;
      const liveStaticPath = output.liveInit?.bodyJson?.StaticPath || vmStaticPath || null;
      const runtimeFeilinVersion =
        report?.liveCheckChainState?.instanceState?.runtimeState?.initConfig?.deviceConfig?.version ||
        report?.liveCheckChainState?.instanceState?.runtimeState?.instanceConfig?.deviceConfig?.version ||
        null;
      if (staticPathRetry && enableRecursiveStaticPathRetry && (liveStaticPath || runtimeFeilinVersion)) {
        const dynamicUrl = buildDynamicUrlFromStaticPath(liveStaticPath);
        const feilinUrl = buildFeilinUrlFromVersion(runtimeFeilinVersion);
        const currentDynamicName = files[1] ? path.basename(files[1]) : null;
        const currentFeilinName = files[0] ? path.basename(files[0]) : null;
        const nextDynamicName = dynamicUrl ? path.basename(dynamicUrl) : null;
        const nextFeilinName = feilinUrl ? path.basename(feilinUrl) : null;
        const shouldRefreshDynamic = !!(dynamicUrl && nextDynamicName && currentDynamicName !== nextDynamicName);
        const shouldRefreshFeilin = !!(feilinUrl && nextFeilinName && currentFeilinName !== nextFeilinName);
        if (shouldRefreshDynamic || shouldRefreshFeilin) {
          try {
            const refreshedDynamicPath = shouldRefreshDynamic
              ? path.join('/tmp', nextDynamicName)
              : files[1];
            const refreshedFeilinPath = shouldRefreshFeilin
              ? path.join('/tmp', nextFeilinName)
              : files[0];
            const downloads = {};
            if (shouldRefreshDynamic) {
              downloads.dynamic = await downloadTextToFile(dynamicUrl, refreshedDynamicPath);
            }
            if (shouldRefreshFeilin) {
              downloads.feilin = await downloadTextToFile(feilinUrl, refreshedFeilinPath);
            }
            const refreshed = await solveCaptcha({
              ...options,
              files: [refreshedFeilinPath, refreshedDynamicPath, loaderPath],
              loaderPath,
              executeLive: false,
              staticPathRetry: false,
            });
            output.staticPathRetry = {
              attempted: true,
              liveStaticPath,
              vmStaticPath,
              runtimeFeilinVersion,
              dynamicUrl,
              feilinUrl,
              dynamicPath: refreshedDynamicPath,
              feilinPath: refreshedFeilinPath,
              downloadedBytes: {
                dynamic: downloads.dynamic?.bytes || null,
                feilin: downloads.feilin?.bytes || null,
              },
              refreshedHasSuccessPayload: !!refreshed?.successPayload?.captcha_verify_param,
              refreshedHasCompactReplaySeed: !!refreshed?.localReplayCompactSeed,
              refreshedDeviceTokenPreview: refreshed?.deviceTokenPreview
                ? String(refreshed.deviceTokenPreview).slice(0, 160)
                : null,
              refreshedVerifyTokenPreview: refreshed?.verifyParamInspection?.deviceTokenPreview
                ? String(refreshed.verifyParamInspection.deviceTokenPreview).slice(0, 160)
                : null,
            };
            if (refreshed?.verifyRequest?.params) {
              diagnosticVerifyRequest = refreshed.verifyRequest;
              synthesisBase = refreshed;
              if (refreshed.successPayload?.captcha_verify_param) output.successPayload = refreshed.successPayload;
              if (refreshed.localReplayCompactSeed) output.localReplayCompactSeed = refreshed.localReplayCompactSeed;
              if (refreshed.localReplayLiveSeed) output.localReplayLiveSeed = refreshed.localReplayLiveSeed;
              if (refreshed.localReplayMinimalLiveSeed) output.localReplayMinimalLiveSeed = refreshed.localReplayMinimalLiveSeed;
              if (refreshed.localReplayUltraMinimalLiveSeed) output.localReplayUltraMinimalLiveSeed = refreshed.localReplayUltraMinimalLiveSeed;
              if (refreshed.localReplaySeed) output.localReplaySeed = refreshed.localReplaySeed;
              if (refreshed.localReplayFullFlow) output.localReplayFullFlow = refreshed.localReplayFullFlow;
              if (refreshed.localPreidExactRuntimeIv) output.localPreidExactRuntimeIv = refreshed.localPreidExactRuntimeIv;
              if (refreshed.verifyParamInspection) output.verifyParamInspection = refreshed.verifyParamInspection;
            }
          } catch (err) {
            output.staticPathRetry = {
              attempted: true,
              liveStaticPath,
              vmStaticPath,
              runtimeFeilinVersion,
              dynamicUrl,
              feilinUrl,
              error: String(err && err.stack || err),
            };
          }
        } else {
          output.staticPathRetry = {
            attempted: false,
            liveStaticPath,
            vmStaticPath,
            runtimeFeilinVersion,
            dynamicUrl,
            feilinUrl,
            reason: 'bundle-paths-already-current-or-unavailable',
          };
        }
      }
      let liveVerifyCandidateRequests = [];
      const liveCertifyId = output.liveInit?.bodyJson?.CertifyId;
      if (liveCertifyId) {
        let baseVerifyRequest =
          output.lightLiveProbe?.verifyRequest ||
          output.liveVerifyRequestFromVmXhr ||
          output.vmVerifyRequest ||
          diagnosticVerifyRequest ||
          verifyRequest;
        let rebuiltLiveVerifyRequest = null;
        const canonicalVmCertifyId =
          output.vmVerifyRequest?.params?.CertifyId ||
          report?.liveCheckChainState?.certifyId ||
          null;
        const canonicalCertifyId = liveCertifyId || canonicalVmCertifyId;
        output.liveVerifyCertifyIdChoice = {
          liveInitCertifyId: liveCertifyId,
          vmCertifyId: canonicalVmCertifyId,
          chosenCertifyId: canonicalCertifyId,
          source: liveCertifyId ? 'live-init' : (canonicalVmCertifyId ? 'vm-chain' : 'unknown'),
        };
        const liveDeviceConfigSources = pickLiveDeviceConfigSources(report, output);
        const liveDeviceConfigRaw = liveDeviceConfigSources.deviceConfigRaw;
        const runtimeLiveDeviceConfig = liveDeviceConfigSources.deviceConfig;
        let parsedLiveDeviceConfig = null;
        if (liveDeviceConfigRaw || runtimeLiveDeviceConfig) {
          try {
            parsedLiveDeviceConfig = runtimeLiveDeviceConfig || parseDeviceConfigToken(liveDeviceConfigRaw);
            output.liveDeviceConfig = parsedLiveDeviceConfig;
          } catch (err) {
            output.liveDeviceConfigError = String(err && err.stack || err);
          }
        }
        if (parsedLiveDeviceConfig) {
          const liveProbeDeviceToken =
            freshInitParams?.DeviceToken ||
            initRequest?.params?.DeviceToken ||
            null;
          const liveSyntheticInitResponse =
            output.liveInit?.bodyJson && typeof output.liveInit.bodyJson === 'object'
              ? output.liveInit.bodyJson
              : (liveCertifyId
                ? {
                  RequestId: 'post-live-probe-init',
                  Message: 'success',
                  Code: 'Success',
                  LimitFlow: false,
                  Success: true,
                  CertifyId: liveCertifyId,
                  CaptchaType: 'TRACELESS',
                }
                : null);
          const liveProbeAutoInitConfig = {
            UserCertifyId: liveCertifyId || null,
            CertifyId: liveCertifyId || null,
            DeviceConfig: liveDeviceConfigRaw || null,
            deviceConfig: parsedLiveDeviceConfig,
            DeviceToken: liveProbeDeviceToken,
          };
          try {
            const replaySeed = extractReplaySeedFromSolverResult(synthesisBase || output);
            const adjustedSeed = applyLiveDeviceConfigToSeed(
              replaySeed,
              parsedLiveDeviceConfig,
              canonicalCertifyId,
            );
            const rebuiltFlow = buildPureLocalFlowFromSeed(adjustedSeed);
            rebuiltLiveVerifyRequest = rebuiltFlow.verifyRequest;
            output.diagnosticRebuiltLiveVerifyRequest = rebuiltFlow.verifyRequest;
            output.liveVerifyRebuiltFromDeviceConfig = {
              runtimeContext: adjustedSeed.runtimeContext,
              verifyRequest: rebuiltFlow.verifyRequest,
              replaySeed,
              adjustedSeed,
            };
            if (!baseVerifyRequest?.params?.CaptchaVerifyParam) {
              baseVerifyRequest = rebuiltFlow.verifyRequest;
            }
            if (enablePostLiveInitRuntimeProbe) {
              const runtimeStateProbe = await probePostLiveInitTokensWithRuntime({
                files,
                loaderPath,
                options: {
                  ...options,
                  initialAliyunCaptchaConfig: {
                    ...(options.initialAliyunCaptchaConfig && typeof options.initialAliyunCaptchaConfig === 'object'
                      ? options.initialAliyunCaptchaConfig
                      : {}),
                    ...liveProbeAutoInitConfig,
                  },
                },
                liveDeviceConfigRaw,
                parsedLiveDeviceConfig,
                certifyId: liveCertifyId,
                deviceToken: liveProbeDeviceToken,
              });
              output.postLiveInitStateProbe = {
                um: runtimeStateProbe?.um || null,
                zUm: runtimeStateProbe?.zUm || null,
                snapshot: runtimeStateProbe?.snapshot || null,
                liveCheckChainState: null,
                error: runtimeStateProbe?.error || null,
              };
              if (runtimeStateProbe?.error) {
                output.postLiveInitStateProbeError = runtimeStateProbe.error;
              }
            } else {
              output.postLiveInitStateProbeSkipped = {
                reason: 'runtime-probe-disabled',
                certifyId: liveCertifyId,
              };
            }
          } catch (err) {
            output.liveDeviceConfigError = String(err && err.stack || err);
          }
        }
        const extraLiveVerifyTokens = [
          {
            source: 'post-auto-init.um.getToken',
            token: report.postAutoInitGetTokenValue || null,
          },
          {
            source: 'post-auto-init.z_um.getToken',
            token: report.postAutoInitZGetTokenValue || null,
          },
          {
            source: 'post-auto-init.um.getToken(certifyId)',
            token: report.postAutoInitGetTokenWithCertifyIdValue || null,
          },
          {
            source: 'post-auto-init.z_um.getToken(certifyId)',
            token: report.postAutoInitZGetTokenWithCertifyIdValue || null,
          },
          {
            source: 'post-live-init-state.um.getToken(certifyId)',
            token: extractTokenString(output.postLiveInitStateProbe?.um),
          },
          {
            source: 'post-live-init-state.z_um.getToken(certifyId)',
            token: extractTokenString(output.postLiveInitStateProbe?.zUm),
          },
          {
            source: 'fresh-init.DeviceToken->rolling-sg-web',
            token: normalizeRollingVerifyLikeTokenBase64(freshInitParams?.DeviceToken || null),
          },
          {
            source: 'init-request.DeviceToken->rolling-sg-web',
            token: normalizeRollingVerifyLikeTokenBase64(initRequest?.params?.DeviceToken || null),
          },
        ];
        const liveVerifyDeviceTokens = collectLiveVerifyDeviceTokenCandidates(
          report,
          parsedLiveDeviceConfig,
          initRequest,
          freshInitParams,
          extraLiveVerifyTokens,
        ).slice(0, 12);
        const liveVerifyDataReverseInfo = output.verifyDataReverse || null;
        const syntheticLiveVerifyBaseRequest = (() => {
          const dataValue = liveVerifyDataReverseInfo?.dataValue || output.verifyParamInspection?.dataValue || null;
          const browserLikeTokenBase64 = extractTokenString(output.postLiveInitStateProbe?.um)
            || extractTokenString(output.postLiveInitStateProbe?.zUm)
            || report.postAutoInitGetTokenValue
            || report.postAutoInitZGetTokenValue
            || report.getTokenValue
            || report.zGetTokenValue
            || null;
          return buildSyntheticLiveVerifyBaseRequest({
            sceneId: initRequest?.params?.SceneId || output.liveCheckChainState?.sceneId || null,
            certifyId: canonicalCertifyId,
            deviceToken: browserLikeTokenBase64,
            data: dataValue,
            url: initRequest?.url || verifyRequest?.url || DEFAULT_VERIFY_ENDPOINT,
          });
        })();
        const baseCandidates = [
          { source: 'light-live-base', request: output.lightLiveProbe?.verifyRequest || null },
          { source: 'dry-vm-bootstrap-base', request: output.dryVmBootstrap?.verifyRequest || null },
          { source: 'live-vm-base', request: output.liveVerifyRequestFromVmXhr || null },
          { source: 'vm-base', request: output.vmVerifyRequest || null },
          { source: 'original-base', request: verifyRequest || null },
          { source: 'rebuilt-device-config-base', request: rebuiltLiveVerifyRequest || null },
          { source: 'synthetic-browserlike-base', request: syntheticLiveVerifyBaseRequest || null },
        ];
        const seenLiveVerifyCandidates = new Set();
        const pushLiveVerifyCandidate = (
          baseSource,
          request,
          deviceTokenSource = null,
          deviceToken = null,
          applyOuterDeviceToken = false,
          rewritePayloadCertifyId = true,
          rewriteInnerDeviceToken = true,
          rewriteVerifyData = true,
        ) => {
          const built = buildLiveVerifyRequestCandidate(request, {
            certifyId: canonicalCertifyId,
            deviceTokenOverride: deviceToken,
            applyOuterDeviceToken,
            rewritePayloadCertifyId,
            rewriteInnerDeviceToken,
            rewriteVerifyData,
            normalizeVerifyToken,
            freshInitDeviceToken: freshInitParams.DeviceToken || initRequest.params?.DeviceToken,
            verifyDataReverseInfo: liveVerifyDataReverseInfo,
          });
          if (!built?.request?.url || !built?.request?.params?.CaptchaVerifyParam) {
            return;
          }
          const verifyParam = String(built.request.params.CaptchaVerifyParam || '');
          const verifyParamHash = crypto.createHash('sha1').update(verifyParam).digest('hex');
          const dedupeKey = [
            baseSource,
            deviceTokenSource || '',
            applyOuterDeviceToken ? 'outer-device-token' : 'no-outer-device-token',
            rewritePayloadCertifyId ? 'rewrite-inner-cert' : 'keep-inner-cert',
            rewriteInnerDeviceToken ? 'rewrite-inner-device-token' : 'keep-inner-device-token',
            rewriteVerifyData ? 'rewrite-data' : 'keep-data',
            built.request.url,
            built.request.params.CertifyId || '',
            built.request.params.DeviceToken || '',
            verifyParamHash,
          ].join('\n');
          if (seenLiveVerifyCandidates.has(dedupeKey)) {
            return;
          }
          seenLiveVerifyCandidates.add(dedupeKey);
          liveVerifyCandidateRequests.push({
            source: deviceTokenSource
              ? `${baseSource}+${deviceTokenSource}${applyOuterDeviceToken ? '+outer-device-token' : '+inner-device-token'}`
              : `${baseSource}${rewritePayloadCertifyId ? '+inner-cert' : '+outer-cert-only'}${rewriteVerifyData ? '+rewrite-data' : '+keep-data'}`,
            baseSource,
            deviceTokenSource,
            request: built.request,
            meta: built.meta,
          });
        };

        for (const baseCandidate of baseCandidates) {
          if (!baseCandidate.request?.params?.CaptchaVerifyParam) {
            continue;
          }
          pushLiveVerifyCandidate(baseCandidate.source, baseCandidate.request, null, null, false, false, false, false);
          pushLiveVerifyCandidate(baseCandidate.source, baseCandidate.request, null, null, false, true, false, false);
          pushLiveVerifyCandidate(baseCandidate.source, baseCandidate.request, null, null, false, true, false, true);
          for (const tokenCandidate of liveVerifyDeviceTokens) {
            pushLiveVerifyCandidate(
              baseCandidate.source,
              baseCandidate.request,
              tokenCandidate.source,
              tokenCandidate.token,
              false,
              true,
              true,
              true,
            );
            pushLiveVerifyCandidate(
              baseCandidate.source,
              baseCandidate.request,
              tokenCandidate.source,
              tokenCandidate.token,
              false,
              true,
              true,
              false,
            );
            pushLiveVerifyCandidate(
              baseCandidate.source,
              baseCandidate.request,
              `${tokenCandidate.source}:outer`,
              tokenCandidate.token,
              true,
              true,
              true,
              true,
            );
            pushLiveVerifyCandidate(
              baseCandidate.source,
              baseCandidate.request,
              `${tokenCandidate.source}:outer`,
              tokenCandidate.token,
              true,
              true,
              true,
              false,
            );
          }
        }

        diagnosticVerifyRequest = liveVerifyCandidateRequests[0]?.request || null;
        pendingLiveVerifyCandidateRequests = liveVerifyCandidateRequests;
        output.liveVerifyRequest = diagnosticVerifyRequest;
        output.liveVerifyCandidateRequests = liveVerifyCandidateRequests.map((candidate) => ({
          source: candidate.source,
          baseSource: candidate.baseSource,
          deviceTokenSource: candidate.deviceTokenSource,
          sentCertifyId: candidate.request?.params?.CertifyId || null,
          sentDeviceToken: candidate.request?.params?.DeviceToken || null,
          applyOuterDeviceToken: candidate.meta?.applyOuterDeviceToken === true,
          rewritePayloadCertifyId: candidate.meta?.rewritePayloadCertifyId !== false,
          rewriteInnerDeviceToken: candidate.meta?.rewriteInnerDeviceToken !== false,
          rewriteVerifyData: candidate.meta?.rewriteVerifyData !== false,
          normalizeDebug: candidate.meta?.normalizeDebug || null,
          parsedPayloadKeys: candidate.meta?.parsedPayloadKeys || [],
        }));
        output.liveVerifyNormalizeSkipped = {
          reason: normalizeVerifyToken
            ? 'candidate-matrix-with-normalize-enabled'
            : 'candidate-matrix-with-normalize-disabled',
          chosenCertifyId: canonicalCertifyId,
          candidateCount: liveVerifyCandidateRequests.length,
        };
        output.supplementalReplay = await replaySupplementalCaptchaActions(
          report,
          canonicalCertifyId,
          sessionContext,
        );

        const vmLiveVerifySecurityTokenNow = output?.liveVerify?.bodyJson?.Result?.securityToken || null;
        if (!(typeof vmLiveVerifySecurityTokenNow === 'string' && vmLiveVerifySecurityTokenNow.length > 0)
          && liveVerifyCandidateRequests.length > 0) {
          const candidateResponses = [];
          let chosenExternalLiveVerify = null;
          let chosenCandidate = null;
          let chosenSummary = null;
          for (const candidate of liveVerifyCandidateRequests) {
            try {
              const response = await executeVerifyRequest(candidate.request, sessionContext);
              const summary = summarizeLiveVerifyCandidateResult(candidate, response);
              candidateResponses.push(summary);
              if (!chosenExternalLiveVerify || isBetterLiveVerifyCandidateResult(summary, chosenSummary)) {
                chosenExternalLiveVerify = response;
                chosenCandidate = candidate;
                chosenSummary = summary;
              }
              if (summary.securityTokenPresent) {
                chosenExternalLiveVerify = response;
                chosenCandidate = candidate;
                chosenSummary = summary;
                break;
              }
            } catch (error) {
              candidateResponses.push(summarizeLiveVerifyCandidateResult(candidate, null, error));
            }
          }
          output.liveVerifyCandidateResponses = candidateResponses;
          if (chosenExternalLiveVerify) {
            output.externalLiveVerify = chosenExternalLiveVerify;
            output.liveVerifyRequest = chosenCandidate?.request || output.liveVerifyRequest;
          }
        }
      }
    }
    const vmLiveVerifySecurityToken = output?.liveVerify?.bodyJson?.Result?.securityToken || null;
    const hasCapturedCandidateResponses = Array.isArray(output.liveVerifyCandidateResponses)
      && output.liveVerifyCandidateResponses.length > 0;
    if (!(typeof vmLiveVerifySecurityToken === 'string' && vmLiveVerifySecurityToken.length > 0)
      && !hasCapturedCandidateResponses) {
      if (pendingLiveVerifyCandidateRequests.length > 0) {
        const candidateResponses = [];
        let chosenExternalLiveVerify = null;
        let chosenCandidate = null;
        let chosenSummary = null;
        for (const candidate of pendingLiveVerifyCandidateRequests) {
          try {
            const response = await executeVerifyRequest(candidate.request, sessionContext);
            const summary = summarizeLiveVerifyCandidateResult(candidate, response);
            candidateResponses.push(summary);
            if (!chosenExternalLiveVerify || isBetterLiveVerifyCandidateResult(summary, chosenSummary)) {
              chosenExternalLiveVerify = response;
              chosenCandidate = candidate;
              chosenSummary = summary;
            }
            if (summary.securityTokenPresent) {
              chosenExternalLiveVerify = response;
              chosenCandidate = candidate;
              chosenSummary = summary;
              break;
            }
          } catch (error) {
            candidateResponses.push(summarizeLiveVerifyCandidateResult(candidate, null, error));
          }
        }
        output.liveVerifyCandidateResponses = candidateResponses;
        if (chosenExternalLiveVerify) {
          output.externalLiveVerify = chosenExternalLiveVerify;
          output.liveVerifyRequest = chosenCandidate?.request || output.liveVerifyRequest;
        }
      } else if (diagnosticVerifyRequest?.url && diagnosticVerifyRequest?.params) {
        const externalLiveVerify = await executeVerifyRequest(diagnosticVerifyRequest, sessionContext);
        output.externalLiveVerify = externalLiveVerify;
      }
    }
    const liveToken = pickCanonicalLiveVerifyResponse(output)?.bodyJson?.Result?.securityToken || null;
    if (payloadForSynthesis && liveToken) {
      output.synthesizedFromLiveVerify = synthesizeCaptchaVerifyParamFromSolverResult(synthesisBase, liveToken) || {
        captcha_verify_param: encodeFinalCaptchaVerifyParam({
          certifyId: payloadForSynthesis.certifyId,
          sceneId: payloadForSynthesis.sceneId,
          securityToken: liveToken,
        }),
        decoded: {
          certifyId: payloadForSynthesis.certifyId,
          sceneId: payloadForSynthesis.sceneId,
          isSign: true,
          securityToken: liveToken,
        },
      };
    }
  }

  if (output.localPreidExactRuntimeIv?.ok) {
    output.localReplaySeed = extractReplaySeedFromSolverResult(output);
    output.localReplayCompactSeed = toCompactReplaySeed(output.localReplaySeed);
    output.localReplayLiveSeed = toLiveReplaySeed(output.localReplaySeed);
    output.localReplayMinimalLiveSeed = toMinimalLiveReplaySeed(output.localReplaySeed);
    output.localReplayUltraMinimalLiveSeed = toUltraMinimalLiveReplaySeed(output.localReplaySeed);
    const fullSeedIssues = collectPureLocalFlowIssues(output.localReplaySeed);
    output.localReplaySeedIssues = fullSeedIssues;
    if (fullSeedIssues.length === 0) {
      try {
        output.localReplayFullFlow = buildPureLocalFlowFromSeed(output.localReplaySeed);
      } catch (error) {
        output.localReplayFullFlow = null;
        output.localReplayFullFlowError = String(error && error.stack || error);
      }
    } else {
      output.localReplayFullFlow = null;
      output.localReplayFullFlowSkipped = summarizeReplaySeedIssues(output.localReplaySeed, fullSeedIssues);
    }
    const compactExpandedSeed = expandCompactReplaySeed(output.localReplayCompactSeed);
    const compactSeedIssues = collectPureLocalFlowIssues(compactExpandedSeed);
    output.localReplayCompactSeedIssues = compactSeedIssues;
    if (compactSeedIssues.length === 0) {
      try {
        output.localReplayCompactFullFlow = buildPureLocalFlowFromSeed(compactExpandedSeed);
      } catch (error) {
        output.localReplayCompactFullFlow = null;
        output.localReplayCompactFullFlowError = String(error && error.stack || error);
      }
    } else {
      output.localReplayCompactFullFlow = null;
      output.localReplayCompactFullFlowSkipped = summarizeReplaySeedIssues(compactExpandedSeed, compactSeedIssues);
    }
  }

  if (slimOutput) {
    pruneHeavySolverOutputInPlace(output);
  }

  return output;
}

async function main() {
  const output = await solveCaptcha(parseCliOptions(process.argv.slice(2)));
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  module.exports = {
    buildSyntheticLog1DeviceConfig,
    buildLatestBrowserProfile,
    buildStage2OffsetPreset,
    signCaptchaParams,
    parseCliOptions,
    solveCaptcha,
    KEY_ID,
    KEY_SECRET,
  };
}
