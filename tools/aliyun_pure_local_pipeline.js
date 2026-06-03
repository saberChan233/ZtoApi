#!/usr/bin/env node

const { encodeFinalCaptchaVerifyParam } = require('./probe_feilin_runtime');
const { computePreidFromSnapshot, computePreidFromTT } = require('./aliyun_preid_full_local');
const { splitPreidH } = require('./aliyun_preid_h_local');

function pickFallbackCertifyId(result) {
  if (!result || typeof result !== 'object') return null;
  const candidates = [
    result?.verifyRequest?.params?.CertifyId,
    result?.liveVerifyRequest?.params?.CertifyId,
    result?.liveVerifyRequestFromVmXhr?.params?.CertifyId,
    result?.vmVerifyRequest?.params?.CertifyId,
    result?.liveInit?.bodyJson?.CertifyId,
    result?.replayLiveInit?.bodyJson?.CertifyId,
    result?.liveCheckChainState?.certifyId,
    result?.liveCheckChainState?.verifyParamDecoded?.certifyId,
    result?.liveCheckChainState?.instanceState?.runtimeState?.initConfig?.certifyId,
    result?.liveCheckChainState?.instanceState?.runtimeState?.instanceConfig?.certifyId,
    result?.liveCheckChainState?.instanceState?.runtimeState?.captchaConfig?.certifyId,
    result?.aliyunInitStateSnapshot?.certifyId,
    result?.localGeneratedRuntimeContextSeed?.certifyId,
  ];
  for (const groupName of ['initState', 'callbackFlow', 'localFallback', 'dnFlow']) {
    const group = result?.stage2OffsetLogs?.[groupName];
    if (Array.isArray(group)) {
      for (const row of group) {
        candidates.push(
          row?.certifyId,
          row?.configCertifyId,
          row?.userCertifyId,
          row?.erCertifyId,
          row?.cId,
        );
      }
    }
  }
  if (Array.isArray(result?.jsonStringifyLogs)) {
    for (const row of result.jsonStringifyLogs) {
      const runtimeState = row?.runtimeState;
      const groups = [
        runtimeState?.initConfig,
        runtimeState?.instanceConfig,
        runtimeState?.captchaConfig,
      ];
      for (const source of groups) {
        candidates.push(
          source?.certifyId,
          source?.CertifyId,
          source?.UserCertifyId,
          source?.logInfo?.cId,
        );
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const text = String(candidate).trim();
    if (!text || text === 'null' || text === 'undefined') continue;
    if (text.includes('probe-certify-id')) continue;
    return text;
  }
  return null;
}

function extractPayloadForSynthesis(result) {
  const fallbackCertifyId = pickFallbackCertifyId(result);
  if (result?.verifyPayload && typeof result.verifyPayload === 'object') {
    return {
      ...result.verifyPayload,
      certifyId: result.verifyPayload.certifyId || fallbackCertifyId || null,
    };
  }
  const raw = result?.verifyRequest?.params?.CaptchaVerifyParam;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...parsed,
      certifyId: parsed.certifyId || fallbackCertifyId || null,
    };
  } catch {
    return null;
  }
}

function extractLocalPreidContext(result) {
  const snapshotPreview = result?.feilinReSnapshot?.preview || null;
  const join = Array.isArray(result?.verifyGCallsiteLogs)
    ? result.verifyGCallsiteLogs.find((item) => item?.stage === 'join') || null
    : null;
  const hReal = Array.isArray(result?.preidHRealLogs) ? result.preidHRealLogs[0] || null : null;
  const nO = join?.namedParts?.nO || null;
  const runtimeH = join?.namedParts?.H || null;
  const runtimeNg = join?.namedParts?.ng || null;
  const tTFull = hReal?.tTFull || null;
  const finalTimestamp = typeof tTFull === 'string' ? tTFull.split('#')[74] || null : null;
  return {
    snapshotPreview,
    nO,
    runtimeH,
    runtimeNg,
    tTFull,
    finalTimestamp,
  };
}

function rebuildPreidFromSolverResult(result, options = {}) {
  const ctx = extractLocalPreidContext(result);
  if (!ctx.nO || !ctx.finalTimestamp) {
    return {
      ok: false,
      error: 'missing nO / finalTimestamp',
      context: ctx,
    };
  }
  try {
    let rebuilt = null;
    if (ctx.snapshotPreview && Object.keys(ctx.snapshotPreview).length) {
      rebuilt = computePreidFromSnapshot(ctx.snapshotPreview, {
        nO: ctx.nO,
        finalTimestamp: ctx.finalTimestamp,
        ...(options.iv ? { iv: options.iv } : {}),
      });
    } else if (typeof ctx.tTFull === 'string' && ctx.tTFull) {
      rebuilt = computePreidFromTT(ctx.tTFull, {
        nO: ctx.nO,
        finalTimestamp: ctx.finalTimestamp,
        ...(options.iv ? { iv: options.iv } : {}),
      });
    } else {
      throw new Error('missing snapshotPreview and tTFull');
    }
    return {
      ok: true,
      context: ctx,
      rebuilt,
      runtimeMatches: {
        H: typeof ctx.runtimeH === 'string' ? rebuilt.H === ctx.runtimeH : null,
        ng: typeof ctx.runtimeNg === 'string' ? rebuilt.ng === ctx.runtimeNg : null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.stack || error),
      context: ctx,
    };
  }
}

function rebuildPreidUsingRuntimeIvFromSolverResult(result) {
  const ctx = extractLocalPreidContext(result);
  if (typeof ctx.runtimeH !== 'string' || !ctx.runtimeH) {
    return {
      ok: false,
      error: 'missing runtime H',
      context: ctx,
    };
  }
  try {
    const { tail } = splitPreidH(ctx.runtimeH);
    const iv = tail.subarray(0, 16);
    return rebuildPreidFromSolverResult(result, { iv });
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.stack || error),
      context: ctx,
    };
  }
}

function synthesizeCaptchaVerifyParamFromSolverResult(result, securityToken) {
  const payload = extractPayloadForSynthesis(result);
  if (!payload?.certifyId || !payload?.sceneId || !securityToken) {
    return null;
  }
  return {
    captcha_verify_param: encodeFinalCaptchaVerifyParam({
      certifyId: payload.certifyId,
      sceneId: payload.sceneId,
      securityToken,
    }),
    decoded: {
      certifyId: payload.certifyId,
      sceneId: payload.sceneId,
      isSign: true,
      securityToken,
    },
  };
}

if (require.main === module) {
  try {
    const result = JSON.parse(process.argv[2] || '');
    const securityToken = process.argv[3] || '';
    console.log(JSON.stringify({
      payloadForSynthesis: extractPayloadForSynthesis(result),
      localPreid: rebuildPreidFromSolverResult(result),
      synthesized: securityToken ? synthesizeCaptchaVerifyParamFromSolverResult(result, securityToken) : null,
    }, null, 2));
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exit(1);
  }
} else {
  module.exports = {
    extractPayloadForSynthesis,
    extractLocalPreidContext,
    rebuildPreidFromSolverResult,
    rebuildPreidUsingRuntimeIvFromSolverResult,
    synthesizeCaptchaVerifyParamFromSolverResult,
  };
}
