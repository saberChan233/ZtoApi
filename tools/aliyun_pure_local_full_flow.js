#!/usr/bin/env node

const crypto = require('crypto');
const { encodeFinalCaptchaVerifyParam } = require('./probe_feilin_runtime');
const { DEFAULTS, buildSecondSegment, computePreidFromRuntimeContext, generateBase62 } = require('./aliyun_local_context_builder');
const { derivePreidTTContextFromTT } = require('./aliyun_preid_tt_local');
const { splitPreidH } = require('./aliyun_preid_h_local');
const { buildCaptchaVerifyParamFromParts } = require('./aliyun_captcha_verify_param_local');
const {
  DEFAULT_LANGUAGE,
  DEFAULT_MODE,
  DEFAULT_VERIFY_ENDPOINT,
  buildInitCaptchaV3Request,
  buildVerifyCaptchaV3Request,
} = require('./aliyun_verify_request_local');

const VERIFY_ARG_STATIC_PREFIX_HEX = '0e21f4fe6e802ca5641b48489a0f611a94';
const CERTIFY_ID_STATIC_PREFIX = 'probe-certify-id-';
const VERIFY_PREFIX_STATIC_SUFFIX_HEX = '01';

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string') {
      if (!value || value === 'null' || value === 'undefined') continue;
      return value;
    }
    return value;
  }
  return null;
}

function sanitizeLiveCredential(value) {
  if (value == null) return null;
  const text = String(value);
  if (!text || text === 'null' || text === 'undefined') return null;
  if (text.includes('probe-security-token') || text.includes('probe-certify-id')) {
    return null;
  }
  return text;
}

function getSnapshotPreviewValue(snapshot, ...keys) {
  const preview = snapshot?.preview;
  if (!preview || typeof preview !== 'object') return null;
  for (const key of keys) {
    const value = preview?.[key]?.value;
    const sanitized = sanitizeLiveCredential(value);
    if (sanitized) return sanitized;
  }
  return null;
}

function collectStage2CredentialCandidates(result) {
  const groups = [
    result?.stage2OffsetLogs?.initState,
    result?.stage2OffsetLogs?.dnFlow,
    result?.stage2OffsetLogs?.callbackFlow,
    result?.stage2OffsetLogs?.localFallback,
  ];
  const certifyIds = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const row of group) {
      if (!row || typeof row !== 'object') continue;
      const candidates = [
        row.certifyId,
        row.configCertifyId,
        row.userCertifyId,
        row.erCertifyId,
        row.cId,
        row.limitedFlowToken,
      ];
      for (const candidate of candidates) {
        const sanitized = sanitizeLiveCredential(candidate);
        if (sanitized) certifyIds.push(sanitized);
      }
    }
  }
  return {
    certifyId: certifyIds[0] || null,
    certifyIds,
  };
}

function collectPureLocalFlowIssues(seed) {
  const issues = [];
  if (!seed?.runtimeContext || typeof seed.runtimeContext !== 'object') {
    issues.push('runtimeContext');
    return issues;
  }
  if (!seed.runtimeContext.certifyId) issues.push('runtimeContext.certifyId');
  if (!seed.runtimeContext.nO) issues.push('runtimeContext.nO');
  if (!seed.verifyDataPrefixHex) issues.push('verifyDataPrefixHex');
  if (!seed.verifyDataPayload) issues.push('verifyDataPayload');
  if (!seed.sceneId) issues.push('sceneId');
  return issues;
}

function extractReplaySeedFromSolverResult(result) {
  const liveCheckChainState = result?.liveCheckChainState || null;
  const instanceState = liveCheckChainState?.instanceState || null;
  const runtimeState = instanceState?.runtimeState || null;
  const initState = instanceState?.initState || null;
  const preview = result?.feilinReSnapshot?.preview || {};
  const deviceCfg = preview?.deviceConfig?.value || {};
  const deviceData = preview?.deviceData?.value || {};
  const initStatePreview = initState?.preview || {};
  const initStateDeviceCfg = initStatePreview?.deviceConfig?.value || {};
  const initStateDeviceTokenBase64 = initStatePreview?.DeviceToken?.value || null;
  const verifyInspection = result?.verifyParamInspection || null;
  const initReq =
    result?.liveInitRequest?.params ||
    result?.initRequest?.params ||
    {};
  const verifyReq =
    result?.liveVerifyRequest?.params ||
    result?.verifyRequest?.params ||
    {};
  const exact = result?.localPreidExactRuntimeIv || null;
  const iv = exact?.rebuilt?.iv || null;
  const parsedTT = (() => {
    const tTFull = exact?.context?.tTFull || (Array.isArray(result?.preidHRealLogs) ? result.preidHRealLogs[0]?.tTFull : null);
    if (typeof tTFull !== 'string' || !tTFull) return null;
    try {
      return derivePreidTTContextFromTT(tTFull);
    } catch {
      return null;
    }
  })();
  const finalTimestamp = exact?.context?.finalTimestamp || parsedTT?.finalTimestamp || null;
  const securityToken = sanitizeLiveCredential(firstNonEmpty(
    result?.synthesizedFromLiveVerify?.decoded?.securityToken,
    result?.liveVerify?.bodyJson?.Result?.securityToken,
    liveCheckChainState?.securityToken,
    result?.synthesizedFromSecurityToken?.decoded?.securityToken,
  ));
  const verifyParamDecoded =
    liveCheckChainState?.verifyParamDecoded ||
    verifyInspection ||
    null;
  const runtimeInitCfg = runtimeState?.initConfig || null;
  const runtimeInstanceCfg = runtimeState?.instanceConfig || null;
  const nO = firstNonEmpty(
    exact?.context?.nO,
    runtimeInstanceCfg?.deviceConfig?.sessionId,
    runtimeInitCfg?.deviceConfig?.sessionId,
    initStateDeviceCfg.sessionId,
    deviceCfg.sessionId,
  );
  const existingPreidPlain = (() => {
    const candidates = [
      liveCheckChainState?.verifyParam,
      result?.liveVerifyRequest?.params?.CaptchaVerifyParam,
      result?.verifyRequest?.params?.CaptchaVerifyParam,
    ];
    for (const raw of candidates) {
      if (typeof raw !== 'string' || !raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.deviceToken !== 'string' || !parsed.deviceToken) continue;
        return Buffer.from(parsed.deviceToken, 'base64').toString('utf8');
      } catch {
        continue;
      }
    }
    return null;
  })();
  const existingPreidPrefixBase64 = (() => {
    const runtimeH =
      (typeof existingPreidPlain === 'string' && existingPreidPlain ? existingPreidPlain.split('#')[2] : null) ||
      exact?.context?.runtimeH ||
      null;
    if (typeof runtimeH !== 'string' || !runtimeH) return null;
    try {
      return splitPreidH(runtimeH).prefix.toString('base64');
    } catch {
      return null;
    }
  })();
  const bestRuntimeContext = result?.localGeneratedRuntimeContextSeed || null;
  const initStateSnapshot = result?.aliyunInitStateSnapshot || null;
  const initStateSnapshotCertifyId = getSnapshotPreviewValue(
    initStateSnapshot,
    'CertifyId',
    'certifyId',
    'cId',
    'UserCertifyId',
    'LimitedFlowToken',
  );
  const stage2Credentials = collectStage2CredentialCandidates(result);
  const liveInitCertifyId = sanitizeLiveCredential(firstNonEmpty(
    result?.liveInit?.bodyJson?.CertifyId,
    result?.liveInit?.CertifyId,
    result?.liveInit?.certifyId,
    result?.replayLiveInit?.bodyJson?.CertifyId,
    result?.replayLiveInit?.CertifyId,
    result?.replayLiveInit?.certifyId,
  ));
  const externalLiveVerifyCertifyId = sanitizeLiveCredential(firstNonEmpty(
    result?.externalLiveVerify?.bodyJson?.Result?.certifyId,
    result?.externalLiveVerify?.bodyJson?.Result?.CertifyId,
    result?.externalLiveVerify?.certifyId,
    result?.externalLiveVerify?.CertifyId,
  ));
  const liveVerifyCertifyId = sanitizeLiveCredential(firstNonEmpty(
    result?.liveVerify?.bodyJson?.Result?.certifyId,
    result?.liveVerify?.bodyJson?.Result?.CertifyId,
    result?.liveVerify?.certifyId,
    result?.liveVerify?.CertifyId,
  ));
  const requestLevelCertifyId = sanitizeLiveCredential(firstNonEmpty(
    result?.liveVerifyRequest?.params?.CertifyId,
    result?.verifyRequest?.params?.CertifyId,
    result?.liveVerifyRequest?.certifyId,
    result?.verifyRequest?.certifyId,
    verifyReq.CertifyId,
  ));
  const runtimeConfigCertifyId = sanitizeLiveCredential(firstNonEmpty(
    liveCheckChainState?.runtimeConfigCertifyIds?.instanceConfig,
    liveCheckChainState?.runtimeConfigCertifyIds?.captchaConfig,
    liveCheckChainState?.runtimeConfigCertifyIds?.logInfoCId,
    runtimeInstanceCfg?.certifyId,
    runtimeInitCfg?.certifyId,
    runtimeInstanceCfg?.logInfo?.cId,
    runtimeInitCfg?.logInfo?.cId,
  ));
  return {
    runtimeContext: {
      prefix:
        firstNonEmpty(
          runtimeInstanceCfg?.prefix,
          runtimeInitCfg?.prefix,
          initStatePreview?.prefix?.value,
          bestRuntimeContext?.prefix,
          preview?.prefix?.value,
        ) ||
        initStatePreview?.prefix?.value ||
        DEFAULTS.prefix,
      region:
        firstNonEmpty(
          runtimeInstanceCfg?.region,
          runtimeInitCfg?.region,
          initStatePreview?.region?.value,
          bestRuntimeContext?.region,
          preview?.region?.value,
        ) ||
        initStatePreview?.region?.value ||
        DEFAULTS.region,
      appName:
        firstNonEmpty(
          runtimeInstanceCfg?.appName,
          runtimeInitCfg?.appName,
          initStatePreview?.appName?.value,
          bestRuntimeContext?.appName,
          parsedTT?.appName,
          preview?.appName?.value,
        ) ||
        DEFAULTS.appName,
      appKey:
        firstNonEmpty(
          runtimeInstanceCfg?.appKey,
          runtimeInitCfg?.appKey,
          initStatePreview?.appKey?.value,
          bestRuntimeContext?.appKey,
          preview?.appKey?.value,
          (typeof nO === 'string' && nO ? nO.split('-h-')[0] : null),
        ) ||
        DEFAULTS.appKey,
      nO,
      sessionTimestamp:
        firstNonEmpty(
          runtimeInstanceCfg?.deviceConfig?.timestamp,
          runtimeInitCfg?.deviceConfig?.timestamp,
          initStateDeviceCfg.timestamp,
          initStatePreview?.timestamp?.value,
          bestRuntimeContext?.sessionTimestamp,
          parsedTT?.ttSessionTimestamp,
          deviceCfg.timestamp,
          preview?.timestamp?.value,
        ),
      initTime:
        firstNonEmpty(
          runtimeInstanceCfg?.initTime,
          runtimeInitCfg?.initTime,
          initStatePreview?.initTime?.value,
          bestRuntimeContext?.initTime,
          parsedTT?.initTime,
          preview?.initTime?.value,
        ),
      finalTimestamp,
      token71: firstNonEmpty(
        exact?.context?.token71,
        parsedTT?.token71,
        bestRuntimeContext?.token71,
        deviceData.asf65445,
      ),
      certifyId:
        sanitizeLiveCredential(firstNonEmpty(
          result?.verifyPayload?.certifyId,
          result?.successPayload?.decoded?.certifyId,
          externalLiveVerifyCertifyId,
          liveInitCertifyId,
          stage2Credentials.certifyId,
          liveCheckChainState?.certifyId,
          liveVerifyCertifyId,
          initStateSnapshotCertifyId,
          verifyParamDecoded?.certifyId,
          requestLevelCertifyId,
          runtimeConfigCertifyId,
          bestRuntimeContext?.certifyId,
          bestRuntimeContext?.ttCertifyId,
          verifyInspection?.certifyId,
        )),
      fontsNum:
        firstNonEmpty(
          runtimeInstanceCfg?.fontsNum,
          runtimeInitCfg?.fontsNum,
          bestRuntimeContext?.fontsNum,
          parsedTT?.fontsNum,
          initStatePreview?.preCollectData?.value?.fontsNum,
          preview?.preCollectData?.value?.fontsNum,
        ),
      browserName: firstNonEmpty(runtimeInstanceCfg?.browserName, runtimeInitCfg?.browserName, bestRuntimeContext?.browserName, parsedTT?.browserName, deviceData.sdfg433),
      browserVersion: firstNonEmpty(runtimeInstanceCfg?.browserVersion, runtimeInitCfg?.browserVersion, bestRuntimeContext?.browserVersion, parsedTT?.browserVersion, deviceData.sdfgsf4),
      osName: firstNonEmpty(runtimeInstanceCfg?.osName, runtimeInitCfg?.osName, bestRuntimeContext?.osName, parsedTT?.osName, deviceData.dfghfg64),
      osArch: firstNonEmpty(runtimeInstanceCfg?.osArch, runtimeInitCfg?.osArch, bestRuntimeContext?.osArch, parsedTT?.osArch, deviceData.lk4n6ll),
      ip:
        firstNonEmpty(
          runtimeInstanceCfg?.deviceConfig?.ip,
          runtimeInitCfg?.deviceConfig?.ip,
          initStateDeviceCfg.ip,
          bestRuntimeContext?.ttIp,
          parsedTT?.ttIp,
          deviceData.fghjfghe,
        ),
      ttIp: firstNonEmpty(bestRuntimeContext?.ttIp, parsedTT?.ttIp, ''),
      pageUrl: firstNonEmpty(runtimeInstanceCfg?.pageUrl, runtimeInitCfg?.pageUrl, bestRuntimeContext?.pageUrl, parsedTT?.pageUrl, deviceData.dfghfgdh6),
      fullUserAgent: firstNonEmpty(runtimeInstanceCfg?.fullUserAgent, runtimeInitCfg?.fullUserAgent, bestRuntimeContext?.fullUserAgent, parsedTT?.fullUserAgent, deviceData.wertdxfgs),
      shortUserAgent: firstNonEmpty(runtimeInstanceCfg?.shortUserAgent, runtimeInitCfg?.shortUserAgent, bestRuntimeContext?.shortUserAgent, parsedTT?.shortUserAgent, deviceData.rewtq2354),
      deviceClass: firstNonEmpty(runtimeInstanceCfg?.deviceClass, runtimeInitCfg?.deviceClass, bestRuntimeContext?.deviceClass, parsedTT?.deviceClass, deviceData.fvcb343),
      brands: firstNonEmpty(runtimeInstanceCfg?.brands, runtimeInitCfg?.brands, bestRuntimeContext?.brands, parsedTT?.ttBrands, deviceData.gs8d67g9),
      ttBrands: firstNonEmpty(bestRuntimeContext?.ttBrands, parsedTT?.ttBrands, null),
      ttCertifyId: sanitizeLiveCredential(firstNonEmpty(bestRuntimeContext?.ttCertifyId, parsedTT?.ttCertifyId, '')) || '',
      ttSessionTimestamp: firstNonEmpty(bestRuntimeContext?.ttSessionTimestamp, parsedTT?.ttSessionTimestamp, '') || '',
    },
    preidIvHex: Buffer.isBuffer(iv) ? iv.toString('hex') : null,
    verifyDataPrefixHex: result?.verifyDataReverse?.seedPrefix || null,
    verifyDataPayload: result?.verifyDataReverse?.seedJsonParsed || null,
    sceneId:
      firstNonEmpty(
        liveCheckChainState?.verifyParamDecoded?.sceneId,
        verifyParamDecoded?.sceneId,
        verifyReq.SceneId,
        initReq.SceneId,
        verifyInspection?.sceneId,
      ),
    initRequest: {
      timestamp: initReq.Timestamp || null,
      nonce: initReq.SignatureNonce || null,
      language: initReq.Language || null,
      mode: initReq.Mode || null,
      url: firstNonEmpty(result?.liveInitRequest?.url, result?.initRequest?.url, liveCheckChainState?.initRequest?.url),
      deviceTokenPlain:
        firstNonEmpty(
          runtimeInitCfg?.deviceTokenPreview,
          runtimeInstanceCfg?.deviceTokenPreview,
          result?.browserLikeInitDeviceTokenPreview,
          result?.initDeviceTokenPreview,
        ),
      deviceTokenBase64: initReq.DeviceToken || initStateDeviceTokenBase64 || null,
    },
    verifyRequest: {
      timestamp: verifyReq.Timestamp || null,
      nonce: verifyReq.SignatureNonce || null,
      url: firstNonEmpty(result?.liveVerifyRequest?.url, result?.verifyRequest?.url, liveCheckChainState?.verifyRequest?.url),
    },
    securityToken,
    preidHPrefixBase64: existingPreidPrefixBase64,
  };
}

function buildPureLocalFlowFromSeed(seed) {
  const issues = collectPureLocalFlowIssues(seed);
  if (issues.length > 0) {
    throw new Error(`seed missing ${issues.join(' / ')}`);
  }
  const initRequestSeed = seed.initRequest || {};
  const verifyRequestSeed = seed.verifyRequest || {};
  const iv = seed.preidIvHex ? Buffer.from(seed.preidIvHex, 'hex') : undefined;
  const prefix = seed.preidHPrefixBase64 ? Buffer.from(seed.preidHPrefixBase64, 'base64') : undefined;
  const preid = computePreidFromRuntimeContext(seed.runtimeContext, prefix ? { iv, prefix } : { iv });
  const captchaVerifyParam = buildCaptchaVerifyParamFromParts({
    certifyId: seed.runtimeContext.certifyId,
    sceneId: seed.sceneId,
    preidPlain: preid.preidPlain,
    verifyDataPrefixHex: seed.verifyDataPrefixHex,
    verifyDataPayload: seed.verifyDataPayload,
  });
  const initRequest = buildInitCaptchaV3Request({
    timestamp: initRequestSeed.timestamp,
    nonce: initRequestSeed.nonce,
    sceneId: seed.sceneId,
    deviceSecondSegment: preid.context.nO,
    deviceTokenPlain: initRequestSeed.deviceTokenPlain,
    deviceTokenBase64: initRequestSeed.deviceTokenBase64,
    language: initRequestSeed.language,
    mode: initRequestSeed.mode,
    url: initRequestSeed.url,
  });
  const verifyRequest = buildVerifyCaptchaV3Request({
    timestamp: verifyRequestSeed.timestamp,
    nonce: verifyRequestSeed.nonce,
    sceneId: seed.sceneId,
    certifyId: seed.runtimeContext.certifyId,
    captchaVerifyParam,
    url: verifyRequestSeed.url,
  });
  const finalCaptchaVerifyParam = seed.securityToken
    ? {
      captcha_verify_param: encodeFinalCaptchaVerifyParam({
        certifyId: seed.runtimeContext.certifyId,
        sceneId: seed.sceneId,
        securityToken: seed.securityToken,
      }),
      decoded: {
        certifyId: seed.runtimeContext.certifyId,
        sceneId: seed.sceneId,
        isSign: true,
        securityToken: seed.securityToken,
      },
    }
    : null;
  return {
    seed,
    preid,
    captchaVerifyParam,
    initRequest,
    verifyRequest,
    finalCaptchaVerifyParam,
  };
}

function normalizeForStableCompare(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableCompare(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizeForStableCompare(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(normalizeForStableCompare(value));
}

function compareReplaySeeds(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function normalizeVerifyDataPayloadForLive(payload) {
  const trackList = payload?.TrackList || {};
  const out = {
    ...normalizeVerifyArgForLive(payload?.arg),
  };
  const extraTrack = Object.fromEntries(
    Object.entries(trackList).filter(([key, value]) => key !== 'startTime' && value !== ''),
  );
  if (Object.keys(extraTrack).length > 0) {
    out.xt = extraTrack;
  }
  const topExtras = Object.fromEntries(
    Object.entries(payload || {}).filter(([key]) => !['TrackList', 'TrackStartTime', 'VerifyTime', 'arg'].includes(key)),
  );
  if (Object.keys(topExtras).length > 0) {
    out.x = topExtras;
  }
  return out;
}

function normalizeVerifyArgForLive(arg) {
  if (typeof arg !== 'string' || !arg) {
    return { arg: null };
  }
  try {
    const decoded = Buffer.from(arg, 'base64');
    const staticPrefix = Buffer.from(VERIFY_ARG_STATIC_PREFIX_HEX, 'hex');
    if (decoded.length >= staticPrefix.length && decoded.subarray(0, staticPrefix.length).equals(staticPrefix)) {
      return {
        at: decoded.subarray(staticPrefix.length).toString('hex'),
      };
    }
  } catch {
    // ignore and fallback
  }
  return { arg };
}

function expandVerifyArgFromLive(compactPayload) {
  if (typeof compactPayload?.arg === 'string' && compactPayload.arg) {
    return compactPayload.arg;
  }
  if (typeof compactPayload?.at === 'string' && compactPayload.at) {
    const staticPrefix = Buffer.from(VERIFY_ARG_STATIC_PREFIX_HEX, 'hex');
    const tail = Buffer.from(compactPayload.at, 'hex');
    return Buffer.concat([staticPrefix, tail]).toString('base64');
  }
  return null;
}

function randomVerifyArgTailHex() {
  return crypto.randomBytes(8).toString('hex');
}

function buildRandomVerifyArg() {
  return expandVerifyArgFromLive({ at: randomVerifyArgTailHex() });
}

function normalizeVerifyPrefixForLive(prefixHex) {
  if (typeof prefixHex !== 'string' || !prefixHex) {
    return { vpx: null };
  }
  if (prefixHex.endsWith(VERIFY_PREFIX_STATIC_SUFFIX_HEX)) {
    return { vpt: prefixHex.slice(0, -VERIFY_PREFIX_STATIC_SUFFIX_HEX.length) };
  }
  return { vpx: prefixHex };
}

function expandVerifyPrefixFromLive(liveSeed) {
  if (typeof liveSeed?.vpx === 'string' && liveSeed.vpx) {
    return liveSeed.vpx;
  }
  if (typeof liveSeed?.vpt === 'string' && liveSeed.vpt) {
    return `${liveSeed.vpt}${VERIFY_PREFIX_STATIC_SUFFIX_HEX}`;
  }
  return null;
}

function randomVerifyPrefixTailHex() {
  return crypto.randomBytes(15).toString('hex');
}

function buildRandomVerifyPrefixHex() {
  return `${randomVerifyPrefixTailHex()}${VERIFY_PREFIX_STATIC_SUFFIX_HEX}`;
}

function normalizeCertifyIdForLive(certifyId) {
  if (typeof certifyId !== 'string' || !certifyId) {
    return { cid: null };
  }
  if (certifyId.startsWith(CERTIFY_ID_STATIC_PREFIX)) {
    return { cs: certifyId.slice(CERTIFY_ID_STATIC_PREFIX.length) };
  }
  return { cid: certifyId };
}

function expandCertifyIdFromLive(liveSeed) {
  if (typeof liveSeed?.cid === 'string' && liveSeed.cid) {
    return liveSeed.cid;
  }
  if (typeof liveSeed?.cs === 'string' && liveSeed.cs) {
    return `${CERTIFY_ID_STATIC_PREFIX}${liveSeed.cs}`;
  }
  return null;
}

function normalizeNOForLive(seed) {
  const nO = seed?.runtimeContext?.nO;
  const appKey = seed?.runtimeContext?.appKey || DEFAULTS.appKey;
  if (typeof nO !== 'string' || !nO) {
    return { nO: null };
  }
  const match = nO.match(/^(.*)-h-(\d+)-([0-9a-f]{32})$/i);
  if (!match) {
    return { nO };
  }
  const [, parsedAppKey, sessionBase, sessionNonceHex] = match;
  return {
    nsb: sessionBase,
    nn: sessionNonceHex,
    ...(parsedAppKey !== DEFAULTS.appKey ? { ak: parsedAppKey } : {}),
  };
}

function expandNOFromLive(liveSeed) {
  if (typeof liveSeed?.nO === 'string' && liveSeed.nO) {
    return liveSeed.nO;
  }
  if (typeof liveSeed?.nsb === 'string' && typeof liveSeed?.nn === 'string') {
    return buildSecondSegment({
      appKey: liveSeed.ak || DEFAULTS.appKey,
      sessionTimestamp: liveSeed.nsb,
      sessionNonceHex: liveSeed.nn,
    });
  }
  return null;
}

function parseSessionTimestampFromNO(nO) {
  if (typeof nO !== 'string' || !nO) return null;
  const match = nO.match(/-h-(\d+)-[0-9a-f]{32}$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function encodeLiveTimingProfile(seed) {
  const stExact = Number(seed?.runtimeContext?.sessionTimestamp);
  const stFromNO = parseSessionTimestampFromNO(seed?.runtimeContext?.nO);
  const stBase = Number.isFinite(stFromNO) ? stFromNO : stExact;
  const stSkew = Number.isFinite(stExact) && Number.isFinite(stBase) ? stExact - stBase : 0;
  const stResolved = Number.isFinite(stExact) ? stExact : stBase;
  const it = Number(seed?.runtimeContext?.initTime);
  const ft = Number(seed?.runtimeContext?.finalTimestamp);
  const trackStart = Number(seed?.verifyDataPayload?.TrackStartTime ?? seed?.verifyDataPayload?.TrackList?.startTime);
  const verifyTime = Number(seed?.verifyDataPayload?.VerifyTime);
  return {
    ...(stSkew !== 0 ? { ss: stSkew } : {}),
    ...(Number.isFinite(it) && Number.isFinite(stResolved) ? { id: it - stResolved } : {}),
    ...(Number.isFinite(trackStart) && Number.isFinite(it) ? { td: trackStart - it } : {}),
    ...(Number.isFinite(verifyTime) && Number.isFinite(trackStart) ? { vd: verifyTime - trackStart } : {}),
    ...(Number.isFinite(ft) && Number.isFinite(verifyTime) ? { fd: ft - verifyTime } : {}),
  };
}

function applyLiveTimingProfile(seed, timing = {}) {
  const base = parseSessionTimestampFromNO(seed?.runtimeContext?.nO) ??
    Number(seed?.runtimeContext?.sessionTimestamp) ??
    Date.now();
  const sessionTimestamp = base + Number(timing.ss || 0);
  const initTime = sessionTimestamp + Number(timing.id || 0);
  const trackStartTime = initTime + Number(timing.td || 0);
  const verifyTime = trackStartTime + Number(timing.vd || 0);
  const finalTimestamp = verifyTime + Number(timing.fd || 0);
  return {
    ...seed,
    runtimeContext: {
      ...(seed.runtimeContext || {}),
      sessionTimestamp: String(sessionTimestamp),
      initTime,
      finalTimestamp: String(finalTimestamp),
    },
    verifyDataPayload: {
      ...(seed.verifyDataPayload || {}),
      TrackList: {
        ...((seed.verifyDataPayload || {}).TrackList || {}),
        startTime: trackStartTime,
      },
      TrackStartTime: trackStartTime,
      VerifyTime: verifyTime,
    },
  };
}

function expandVerifyDataPayloadFromLive(compactPayload) {
  if (!compactPayload || typeof compactPayload !== 'object') {
    throw new Error('live verifyData payload must be an object');
  }
  return {
    ...(compactPayload.x || {}),
    TrackList: {
      mc: '',
      tc: '',
      mu: '',
      te: '',
      mp: '',
      tmv: '',
      ks: '',
      fi: '',
      ...(compactPayload.xt || {}),
      startTime: null,
    },
    TrackStartTime: null,
    VerifyTime: null,
    arg: expandVerifyArgFromLive(compactPayload),
  };
}

function toCompactReplaySeed(seed) {
  const ctx = seed?.runtimeContext || {};
  return {
    nO: ctx.nO || null,
    st: ctx.sessionTimestamp || null,
    it: ctx.initTime ?? null,
    ft: ctx.finalTimestamp || null,
    t71: ctx.token71 || null,
    cid: ctx.certifyId || null,
    iv: seed?.preidIvHex || null,
    vpx: seed?.verifyDataPrefixHex || null,
    vpp: seed?.verifyDataPayload || null,
    sid: seed?.sceneId || null,
    initTs: seed?.initRequest?.timestamp || null,
    initNonce: seed?.initRequest?.nonce || null,
    idp: seed?.initRequest?.deviceTokenPlain || null,
    idb: seed?.initRequest?.deviceTokenBase64 || null,
    verifyTs: seed?.verifyRequest?.timestamp || null,
    verifyNonce: seed?.verifyRequest?.nonce || null,
    sec: seed?.securityToken || null,
    ...(ctx.prefix && ctx.prefix !== DEFAULTS.prefix ? { prefix: ctx.prefix } : {}),
    ...(ctx.region && ctx.region !== DEFAULTS.region ? { region: ctx.region } : {}),
    ...(ctx.appName && ctx.appName !== DEFAULTS.appName ? { appName: ctx.appName } : {}),
    ...(ctx.appKey && ctx.appKey !== DEFAULTS.appKey ? { appKey: ctx.appKey } : {}),
    ...(ctx.browserName && ctx.browserName !== DEFAULTS.browserName ? { browserName: ctx.browserName } : {}),
    ...(ctx.browserVersion && ctx.browserVersion !== DEFAULTS.browserVersion ? { browserVersion: ctx.browserVersion } : {}),
    ...(ctx.osName && ctx.osName !== DEFAULTS.osName ? { osName: ctx.osName } : {}),
    ...(ctx.osArch && ctx.osArch !== DEFAULTS.osArch ? { osArch: ctx.osArch } : {}),
    ...(ctx.ip && ctx.ip !== DEFAULTS.ip ? { ip: ctx.ip } : {}),
    ...(ctx.pageUrl && ctx.pageUrl !== DEFAULTS.pageUrl ? { pageUrl: ctx.pageUrl } : {}),
    ...(ctx.fullUserAgent && ctx.fullUserAgent !== DEFAULTS.fullUserAgent ? { fullUserAgent: ctx.fullUserAgent } : {}),
    ...(ctx.shortUserAgent && ctx.shortUserAgent !== DEFAULTS.shortUserAgent ? { shortUserAgent: ctx.shortUserAgent } : {}),
    ...((ctx.fontsNum ?? DEFAULTS.fontsNum) !== DEFAULTS.fontsNum ? { fontsNum: ctx.fontsNum } : {}),
    ...(ctx.deviceClass && ctx.deviceClass !== DEFAULTS.deviceClass ? { deviceClass: ctx.deviceClass } : {}),
    ...(Array.isArray(ctx.brands) && ctx.brands.join(',') !== 'Chromium,Google Chrome' ? { brands: ctx.brands } : {}),
    ...(seed?.initRequest?.language && seed.initRequest.language !== DEFAULT_LANGUAGE ? { initLanguage: seed.initRequest.language } : {}),
    ...(seed?.initRequest?.mode && seed.initRequest.mode !== DEFAULT_MODE ? { initMode: seed.initRequest.mode } : {}),
    ...(seed?.initRequest?.url && seed.initRequest.url !== DEFAULT_VERIFY_ENDPOINT ? { initUrl: seed.initRequest.url } : {}),
    ...(seed?.verifyRequest?.url && seed.verifyRequest.url !== DEFAULT_VERIFY_ENDPOINT ? { verifyUrl: seed.verifyRequest.url } : {}),
  };
}

function expandCompactReplaySeed(compact) {
  if (!compact || typeof compact !== 'object') {
    throw new Error('compact replay seed must be an object');
  }
  return {
    runtimeContext: {
      prefix: compact.prefix || DEFAULTS.prefix,
      region: compact.region || DEFAULTS.region,
      appName: compact.appName || DEFAULTS.appName,
      appKey: compact.appKey || DEFAULTS.appKey,
      nO: compact.nO,
      sessionTimestamp: compact.st,
      initTime: compact.it,
      finalTimestamp: compact.ft,
      token71: compact.t71,
      certifyId: compact.cid,
      fontsNum: compact.fontsNum ?? DEFAULTS.fontsNum,
      browserName: compact.browserName || DEFAULTS.browserName,
      browserVersion: compact.browserVersion || DEFAULTS.browserVersion,
      osName: compact.osName || DEFAULTS.osName,
      osArch: compact.osArch || DEFAULTS.osArch,
      ip: compact.ip || DEFAULTS.ip,
      pageUrl: compact.pageUrl || DEFAULTS.pageUrl,
      fullUserAgent: compact.fullUserAgent || DEFAULTS.fullUserAgent,
      shortUserAgent: compact.shortUserAgent || DEFAULTS.shortUserAgent,
      deviceClass: compact.deviceClass || DEFAULTS.deviceClass,
      brands: compact.brands || ['Chromium', 'Google Chrome'],
    },
    preidIvHex: compact.iv || null,
    verifyDataPrefixHex: compact.vpx || null,
    verifyDataPayload: compact.vpp || null,
    sceneId: compact.sid || null,
    initRequest: {
      timestamp: compact.initTs || null,
      nonce: compact.initNonce || null,
      deviceTokenPlain: compact.idp || null,
      deviceTokenBase64: compact.idb || null,
      language: compact.initLanguage || DEFAULT_LANGUAGE,
      mode: compact.initMode || DEFAULT_MODE,
      url: compact.initUrl || DEFAULT_VERIFY_ENDPOINT,
    },
    verifyRequest: {
      timestamp: compact.verifyTs || null,
      nonce: compact.verifyNonce || null,
      url: compact.verifyUrl || DEFAULT_VERIFY_ENDPOINT,
    },
    securityToken: compact.sec || null,
  };
}

function toLiveReplaySeed(seed) {
  const compact = toCompactReplaySeed(seed);
  return Object.fromEntries(
    Object.entries({
      ...compact,
      ...normalizeVerifyPrefixForLive(seed?.verifyDataPrefixHex),
      ...normalizeNOForLive(seed),
      ...normalizeCertifyIdForLive(seed?.runtimeContext?.certifyId),
      nO: undefined,
      cid: undefined,
      vpx: undefined,
      st: undefined,
      it: undefined,
      ft: undefined,
      vpp: undefined,
      initTs: undefined,
      initNonce: undefined,
      verifyTs: undefined,
      verifyNonce: undefined,
      sec: undefined,
      vd: normalizeVerifyDataPayloadForLive(seed?.verifyDataPayload || {}),
      tp: encodeLiveTimingProfile(seed),
    }).filter(([, value]) => value !== undefined),
  );
}

function expandLiveReplaySeed(liveSeed, options = {}) {
  if (!liveSeed || typeof liveSeed !== 'object') {
    throw new Error('live replay seed must be an object');
  }
  const initTimestamp = options.initTimestamp || null;
  const initNonce = options.initNonce || null;
  const verifyTimestamp = options.verifyTimestamp || null;
  const verifyNonce = options.verifyNonce || null;
  const expanded = expandCompactReplaySeed({
    ...liveSeed,
    nO: expandNOFromLive(liveSeed),
    cid: expandCertifyIdFromLive(liveSeed),
    vpx: expandVerifyPrefixFromLive(liveSeed),
    vpp: expandVerifyDataPayloadFromLive(liveSeed.vd),
    initTs: initTimestamp,
    initNonce,
    verifyTs: verifyTimestamp,
    verifyNonce,
    sec: null,
  });
  return applyLiveTimingProfile(expanded, liveSeed.tp || {});
}

function toMinimalLiveReplaySeed(seed) {
  const liveSeed = toLiveReplaySeed(seed);
  return Object.fromEntries(
    Object.entries({
      ...liveSeed,
      t71: undefined,
    }).filter(([, value]) => value !== undefined),
  );
}

function expandMinimalLiveReplaySeed(minimalSeed, options = {}) {
  return expandLiveReplaySeed({
    ...minimalSeed,
    t71: options.token71 || generateBase62(40),
    iv: options.ivHex || minimalSeed.iv || randomHex(16),
    vpt: options.verifyPrefixTailHex || minimalSeed.vpt || randomVerifyPrefixTailHex(),
    vd: {
      ...(minimalSeed.vd || {}),
      at: options.verifyArgTailHex || minimalSeed?.vd?.at || randomVerifyArgTailHex(),
    },
  }, options);
}

function toUltraMinimalLiveReplaySeed(seed) {
  const minimalSeed = toMinimalLiveReplaySeed(seed);
  return Object.fromEntries(
    Object.entries({
      ...minimalSeed,
      iv: undefined,
      vpt: undefined,
      vd: undefined,
    }).filter(([, value]) => value !== undefined),
  );
}

function expandUltraMinimalLiveReplaySeed(ultraSeed, options = {}) {
  return expandMinimalLiveReplaySeed({
    ...ultraSeed,
  }, {
    ...options,
    token71: options.token71 || generateBase62(40),
    ivHex: options.ivHex || randomHex(16),
    verifyPrefixTailHex: options.verifyPrefixTailHex || randomVerifyPrefixTailHex(),
    verifyArgTailHex: options.verifyArgTailHex || randomVerifyArgTailHex(),
  });
}

if (require.main === module) {
  try {
    const seed = JSON.parse(process.argv[2] || '{}');
    console.log(JSON.stringify(buildPureLocalFlowFromSeed(seed), null, 2));
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exit(1);
  }
} else {
  module.exports = {
    extractReplaySeedFromSolverResult,
    collectPureLocalFlowIssues,
    buildPureLocalFlowFromSeed,
    compareReplaySeeds,
    normalizeVerifyDataPayloadForLive,
    parseSessionTimestampFromNO,
    encodeLiveTimingProfile,
    applyLiveTimingProfile,
    expandVerifyDataPayloadFromLive,
    normalizeVerifyArgForLive,
    expandVerifyArgFromLive,
    normalizeVerifyPrefixForLive,
    expandVerifyPrefixFromLive,
    randomVerifyArgTailHex,
    buildRandomVerifyArg,
    randomVerifyPrefixTailHex,
    buildRandomVerifyPrefixHex,
    normalizeCertifyIdForLive,
    expandCertifyIdFromLive,
    normalizeNOForLive,
    expandNOFromLive,
    toCompactReplaySeed,
    expandCompactReplaySeed,
    toLiveReplaySeed,
    expandLiveReplaySeed,
    toMinimalLiveReplaySeed,
    expandMinimalLiveReplaySeed,
    toUltraMinimalLiveReplaySeed,
    expandUltraMinimalLiveReplaySeed,
  };
}
