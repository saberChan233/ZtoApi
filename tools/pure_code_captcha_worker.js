#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');
const { solveCaptcha, buildLatestBrowserProfile } = require('./browserless_aliyun_captcha_solver');
const { resolveBundleConfig } = require('./aliyun_bundle_bootstrap');
const { encodeFinalCaptchaVerifyParam, runProbe } = require('./probe_feilin_runtime');
const {
  buildPureLocalFlowFromSeed,
  expandLiveReplaySeed,
  expandMinimalLiveReplaySeed,
  expandUltraMinimalLiveReplaySeed,
  expandCompactReplaySeed,
} = require('./aliyun_pure_local_full_flow');
const { signCaptchaParams, parseDeviceConfigToken } = require('./aliyun_local_reverse');

const FAILURE_SNAPSHOT_DIR = path.resolve(process.cwd(), '.codex', 'captcha-failures');

const NATIVE_FETCH = typeof globalThis.fetch === 'function'
  ? globalThis.fetch.bind(globalThis)
  : null;

function readCommandStdout(command, args) {
  try {
    return String(execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim();
  } catch {
    return '';
  }
}

function detectSystemProxyUrl() {
  try {
    const mode = readCommandStdout('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);
    if (!mode.includes('manual')) {
      return null;
    }
    const httpHost = readCommandStdout('gsettings', ['get', 'org.gnome.system.proxy.http', 'host'])
      .replaceAll("'", '')
      .trim();
    const httpPort = readCommandStdout('gsettings', ['get', 'org.gnome.system.proxy.http', 'port']).trim();
    if (httpHost && httpPort && httpPort !== '0') {
      return `http://${httpHost}:${httpPort}`;
    }
    const socksHost = readCommandStdout('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host'])
      .replaceAll("'", '')
      .trim();
    const socksPort = readCommandStdout('gsettings', ['get', 'org.gnome.system.proxy.socks', 'port']).trim();
    if (socksHost && socksPort && socksPort !== '0') {
      return `socks5h://${socksHost}:${socksPort}`;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveWorkerProxyUrl() {
  const explicit = String(process.env.UPSTREAM_PROXY_URL || '').trim();
  if (explicit) return explicit;
  const systemProxy = detectSystemProxyUrl();
  if (systemProxy) return systemProxy;
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    ''
  ).trim() || null;
}

function parseHostResolveOverrides(spec) {
  const out = {};
  for (const part of String(spec || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean)) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const host = part.slice(0, idx).trim().toLowerCase();
    const ip = part.slice(idx + 1).trim();
    if (host && ip) {
      out[host] = ip;
    }
  }
  return out;
}

const WORKER_PROXY_URL = resolveWorkerProxyUrl();
const WORKER_HOST_RESOLVE_OVERRIDES = parseHostResolveOverrides(
  process.env.UPSTREAM_HOST_RESOLVE_OVERRIDES || '',
);

function getCurlResolveArgsForUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.trim().toLowerCase();
    const ip = WORKER_HOST_RESOLVE_OVERRIDES[host];
    if (!ip) return [];
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return ['--resolve', `${parsed.hostname}:${port}:${ip}`];
  } catch {
    return [];
  }
}

function toBuffer(body) {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), 'utf8');
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  return Buffer.from(String(body), 'utf8');
}

function parseHeadersFromRawBlock(raw) {
  const headers = new Headers();
  const lines = String(raw || '').split(/\r?\n/).slice(1);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    headers.append(key, value);
  }
  return headers;
}

function extractLastHttpHeaderBlock(raw) {
  const blocks = String(raw || '')
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].startsWith('HTTP/')) {
      return blocks[i];
    }
  }
  return blocks[blocks.length - 1] || '';
}

async function fetchViaCurl(input, init = {}) {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input && input.url || '');
  if (!url) {
    throw new Error('missing fetch url');
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztoapi-worker-fetch-'));
  const headerPath = path.join(tempDir, 'headers.txt');
  const bodyPath = path.join(tempDir, 'body.bin');
  try {
    const method = String(init.method || 'GET').toUpperCase();
    const args = [
      '-sS',
      '-L',
      '--compressed',
      '-D', headerPath,
      '-o', bodyPath,
      '-X', method,
      ...getCurlResolveArgsForUrl(url),
    ];
    if (WORKER_PROXY_URL) {
      args.push('--proxy', WORKER_PROXY_URL);
    }

    const headers = new Headers(init.headers || {});
    for (const [key, value] of headers.entries()) {
      args.push('-H', `${key}: ${value}`);
    }

    const bodyBuffer = toBuffer(init.body);
    if (bodyBuffer != null) {
      args.push('--data-binary', '@-');
    }
    args.push(url);

    const out = spawnSync('curl', args, {
      input: bodyBuffer == null ? undefined : bodyBuffer,
      encoding: null,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (out.status !== 0) {
      const stderrText = out.stderr ? Buffer.from(out.stderr).toString('utf8') : '';
      throw new Error(`curl fetch failed (${out.status}): ${stderrText}`);
    }

    const rawHeaders = fs.existsSync(headerPath) ? fs.readFileSync(headerPath, 'utf8') : '';
    const lastHeaderBlock = extractLastHttpHeaderBlock(rawHeaders);
    const statusLine = lastHeaderBlock.split(/\r?\n/, 1)[0] || '';
    const statusMatch = statusLine.match(/^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/i);
    const status = statusMatch ? Number(statusMatch[1]) : 200;
    const statusText = statusMatch && statusMatch[2] ? statusMatch[2].trim() : '';
    const responseHeaders = parseHeadersFromRawBlock(lastHeaderBlock);
    const responseBody = fs.existsSync(bodyPath) ? fs.readFileSync(bodyPath) : Buffer.alloc(0);
    return new Response(responseBody, {
      status,
      statusText,
      headers: responseHeaders,
    });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

if (NATIVE_FETCH) {
  globalThis.fetch = async function workerFetch(input, init = undefined) {
    const url = typeof input === 'string' || input instanceof URL
      ? String(input)
      : String(input && input.url || '');
    if (/^https?:\/\//i.test(url) && (WORKER_PROXY_URL || getCurlResolveArgsForUrl(url).length > 0)) {
      return await fetchViaCurl(input, init || {});
    }
    return await NATIVE_FETCH(input, init);
  };
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function previewString(value, limit = 240) {
  if (value == null) return null;
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function safeJsonParse(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function summarizeCaptchaActionParams(params) {
  if (!params || typeof params !== 'object') return null;
  return {
    action: params.Action || null,
    sceneId: params.SceneId || null,
    certifyId: params.CertifyId || null,
    language: params.Language || null,
    mode: params.Mode || null,
    upLang: params.UpLang ?? null,
    timestamp: params.Timestamp || null,
    nonce: params.SignatureNonce || null,
    hasDeviceData: typeof params.DeviceData === 'string' && params.DeviceData.length > 0,
    deviceDataLength: typeof params.DeviceData === 'string' ? params.DeviceData.length : null,
    deviceDataPreview: typeof params.DeviceData === 'string' ? params.DeviceData.slice(0, 200) : null,
    hasDeviceToken: typeof params.DeviceToken === 'string' && params.DeviceToken.length > 0,
    deviceTokenLength: typeof params.DeviceToken === 'string' ? params.DeviceToken.length : null,
    deviceTokenPreview: typeof params.DeviceToken === 'string' ? params.DeviceToken.slice(0, 200) : null,
    hasCaptchaVerifyParam: typeof params.CaptchaVerifyParam === 'string' && params.CaptchaVerifyParam.length > 0,
    captchaVerifyParamLength: typeof params.CaptchaVerifyParam === 'string' ? params.CaptchaVerifyParam.length : null,
    accessKeyId: params.AccessKeyId || null,
  };
}

function summarizeRequestHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const pick = (name) => {
    const variants = [
      name,
      name.toLowerCase(),
      name.toUpperCase(),
    ];
    for (const key of variants) {
      if (Object.prototype.hasOwnProperty.call(headers, key)) {
        return headers[key];
      }
    }
    const foundKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    return foundKey ? headers[foundKey] : null;
  };
  const cookie = pick('Cookie');
  return {
    contentType: pick('Content-Type') || null,
    accept: pick('Accept') || null,
    acceptLanguage: pick('Accept-Language') || null,
    origin: pick('Origin') || null,
    referer: pick('Referer') ?? null,
    userAgent: pick('User-Agent') || null,
    secFetchDest: pick('Sec-Fetch-Dest') || null,
    secFetchMode: pick('Sec-Fetch-Mode') || null,
    secFetchSite: pick('Sec-Fetch-Site') || null,
    secChUa: pick('Sec-Ch-Ua') || null,
    secChUaMobile: pick('Sec-Ch-Ua-Mobile') || null,
    secChUaPlatform: pick('Sec-Ch-Ua-Platform') || null,
    hasCookie: typeof cookie === 'string' ? cookie.length > 0 : !!cookie,
    cookieLength: typeof cookie === 'string' ? cookie.length : null,
  };
}

function summarizeVerifyRequestLike(request) {
  if (!request || typeof request !== 'object') return null;
  const params = request.params && typeof request.params === 'object'
    ? request.params
    : null;
  const parsedCaptchaVerifyParam = typeof params?.CaptchaVerifyParam === 'string'
    ? safeJsonParse(params.CaptchaVerifyParam)
    : null;
  return {
    url: request.url || null,
    action: params?.Action || params?.action || null,
    certifyId: params?.CertifyId || params?.certifyId || null,
    sceneId: params?.SceneId || params?.sceneId || null,
    hasDeviceToken: typeof params?.DeviceToken === 'string' && params.DeviceToken.length > 0,
    deviceTokenLength: typeof params?.DeviceToken === 'string' ? params.DeviceToken.length : null,
    deviceTokenPreview: typeof params?.DeviceToken === 'string' ? params.DeviceToken.slice(0, 200) : null,
    hasCaptchaVerifyParam: typeof params?.CaptchaVerifyParam === 'string' && params.CaptchaVerifyParam.length > 0,
    captchaVerifyParamLength: typeof params?.CaptchaVerifyParam === 'string'
      ? params.CaptchaVerifyParam.length
      : null,
    captchaVerifyParamPreview: typeof params?.CaptchaVerifyParam === 'string'
      ? params.CaptchaVerifyParam.slice(0, 200)
      : null,
    captchaVerifyParamDecoded: parsedCaptchaVerifyParam,
    headers: summarizeRequestHeaders(request.headers || request.requestHeaders || null),
  };
}

function summarizeVerifyResponseLike(response) {
  if (!response || typeof response !== 'object') return null;
  const bodyJson = response.bodyJson && typeof response.bodyJson === 'object'
    ? response.bodyJson
    : (response.responseJson && typeof response.responseJson === 'object' ? response.responseJson : null);
  const result = bodyJson?.Result && typeof bodyJson.Result === 'object'
    ? bodyJson.Result
    : null;
  return {
    status: response.status ?? response.responseStatus ?? null,
    ok: response.ok === true,
    code: bodyJson?.Code || null,
    requestId: bodyJson?.RequestId || null,
    verifyCode: result?.VerifyCode || null,
    verifyResult: result?.VerifyResult === true,
    certifyId: result?.CertifyId || result?.certifyId || bodyJson?.CertifyId || null,
    securityTokenPresent: typeof result?.securityToken === 'string' && result.securityToken.length > 0,
    securityTokenPreview: typeof result?.securityToken === 'string' ? result.securityToken.slice(0, 120) : null,
  };
}

function summarizeLiveCheckChainState(state) {
  if (!state || typeof state !== 'object') return null;
  const runtimeState = state?.instanceState?.runtimeState || null;
  const initCfg = runtimeState?.initConfig || null;
  const instanceCfg = runtimeState?.instanceConfig || null;
  const captchaCfg = runtimeState?.captchaConfig || null;
  const verifyParamDecoded = state?.verifyParamDecoded && typeof state.verifyParamDecoded === 'object'
    ? state.verifyParamDecoded
    : null;
  return {
    canonicalSource: state.canonicalSource || null,
    certifyId: state.certifyId || null,
    securityTokenPresent: typeof state.securityToken === 'string' && state.securityToken.length > 0,
    verifyParamDecoded: verifyParamDecoded
      ? {
        certifyId: verifyParamDecoded.certifyId || null,
        sceneId: verifyParamDecoded.sceneId || null,
        hasDeviceToken: typeof verifyParamDecoded.deviceToken === 'string' && verifyParamDecoded.deviceToken.length > 0,
        dataLength: typeof verifyParamDecoded.data === 'string' ? verifyParamDecoded.data.length : null,
      }
      : null,
    runtimeConfigCertifyIds: {
      initConfig: initCfg?.certifyId || initCfg?.CertifyId || initCfg?.UserCertifyId || initCfg?.logInfo?.cId || null,
      instanceConfig: instanceCfg?.certifyId || instanceCfg?.CertifyId || instanceCfg?.UserCertifyId || instanceCfg?.logInfo?.cId || null,
      captchaConfig: captchaCfg?.certifyId || captchaCfg?.CertifyId || captchaCfg?.UserCertifyId || captchaCfg?.logInfo?.cId || null,
      logInfoCId: captchaCfg?.logInfo?.cId || instanceCfg?.logInfo?.cId || initCfg?.logInfo?.cId || null,
    },
  };
}

function summarizeFailureDebugFields(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    liveVerifyCandidateRequests: Array.isArray(result.liveVerifyCandidateRequests)
      ? result.liveVerifyCandidateRequests
      : null,
    liveVerifyCandidateResponses: Array.isArray(result.liveVerifyCandidateResponses)
      ? result.liveVerifyCandidateResponses
      : null,
    externalLiveVerify: summarizeVerifyResponseLike(result.externalLiveVerify),
    liveVerifyRequest: summarizeVerifyRequestLike(result.liveVerifyRequest),
    diagnosticRebuiltLiveVerifyRequest: summarizeVerifyRequestLike(result.diagnosticRebuiltLiveVerifyRequest),
    liveVerifyRebuiltFromDeviceConfig: result.liveVerifyRebuiltFromDeviceConfig
      ? {
        runtimeContext: result.liveVerifyRebuiltFromDeviceConfig.runtimeContext
          ? {
            certifyId: result.liveVerifyRebuiltFromDeviceConfig.runtimeContext.certifyId || null,
            nO: result.liveVerifyRebuiltFromDeviceConfig.runtimeContext.nO || null,
            sessionTimestamp: result.liveVerifyRebuiltFromDeviceConfig.runtimeContext.sessionTimestamp || null,
          }
          : null,
        verifyRequest: summarizeVerifyRequestLike(result.liveVerifyRebuiltFromDeviceConfig.verifyRequest),
      }
      : null,
    liveCheckChainState: summarizeLiveCheckChainState(result.liveCheckChainState),
  };
}

function collectReplaySeedIssues(seed) {
  const issues = [];
  if (!seed || typeof seed !== 'object') {
    issues.push('seed');
    return issues;
  }
  if (!seed.runtimeContext || typeof seed.runtimeContext !== 'object') {
    issues.push('runtimeContext');
  } else {
    if (!seed.runtimeContext.certifyId) issues.push('runtimeContext.certifyId');
    if (!seed.runtimeContext.nO) issues.push('runtimeContext.nO');
  }
  if (!seed.verifyDataPrefixHex) issues.push('verifyDataPrefixHex');
  if (!seed.verifyDataPayload || typeof seed.verifyDataPayload !== 'object') {
    issues.push('verifyDataPayload');
  }
  if (!seed.sceneId) issues.push('sceneId');
  return issues;
}

function pickFallbackCertifyIdFromResult(result) {
  if (!result || typeof result !== 'object') return null;
  const candidates = [
    result?.verifyPayload?.certifyId,
    result?.successPayload?.decoded?.certifyId,
    result?.externalLiveVerify?.bodyJson?.Result?.certifyId,
    result?.liveInit?.bodyJson?.CertifyId,
    result?.replayLiveInit?.bodyJson?.CertifyId,
    result?.liveVerify?.bodyJson?.Result?.certifyId,
    result?.liveCheckChainState?.certifyId,
    result?.liveCheckChainState?.verifyParamDecoded?.certifyId,
    result?.liveCheckChainState?.instanceState?.runtimeState?.initConfig?.certifyId,
    result?.liveCheckChainState?.instanceState?.runtimeState?.instanceConfig?.certifyId,
    result?.liveCheckChainState?.instanceState?.runtimeState?.captchaConfig?.certifyId,
    result?.liveCheckChainState?.instanceState?.runtimeState?.initConfig?.logInfo?.cId,
    result?.liveCheckChainState?.instanceState?.runtimeState?.instanceConfig?.logInfo?.cId,
    result?.liveCheckChainState?.instanceState?.runtimeState?.captchaConfig?.logInfo?.cId,
    result?.verifyParamInspection?.certifyId,
  ];
  for (const groupName of ['initState', 'callbackFlow', 'localFallback']) {
    const group = result?.stage2OffsetLogs?.[groupName];
    if (Array.isArray(group)) {
      for (const row of group) {
        candidates.push(
          row?.certifyId,
          row?.configCertifyId,
          row?.userCertifyId,
          row?.cId,
          row?.limitedFlowToken,
        );
      }
    }
  }
  const runtimeSources = [
    result?.aliyunInitStateSnapshot,
    result?.liveCheckChainState?.instanceState?.runtimeState?.initConfig,
    result?.liveCheckChainState?.instanceState?.runtimeState?.instanceConfig,
    result?.liveCheckChainState?.instanceState?.runtimeState?.captchaConfig,
  ];
  for (const source of runtimeSources) {
    candidates.push(
      source?.certifyId,
      source?.CertifyId,
      source?.UserCertifyId,
      source?.logInfo?.cId,
    );
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

function backfillReplaySeedCertifyId(seed, certifyId) {
  if (!seed || typeof seed !== 'object' || !certifyId) {
    return seed;
  }
  if (seed?.runtimeContext?.certifyId) {
    return seed;
  }
  return {
    ...seed,
    runtimeContext: {
      ...(seed.runtimeContext && typeof seed.runtimeContext === 'object' ? seed.runtimeContext : {}),
      certifyId,
    },
  };
}

function summarizeReplaySeed(seed) {
  if (!seed || typeof seed !== 'object') return null;
  return {
    sceneId: seed.sceneId || null,
    hasRuntimeContext: !!seed.runtimeContext,
    runtimeContext: seed.runtimeContext
      ? {
        certifyId: seed.runtimeContext.certifyId || null,
        nO: seed.runtimeContext.nO || null,
        appKey: seed.runtimeContext.appKey || null,
        sessionTimestamp: seed.runtimeContext.sessionTimestamp || null,
      }
      : null,
    hasVerifyDataPrefixHex: !!seed.verifyDataPrefixHex,
    verifyDataPrefixHexPreview: previewString(seed.verifyDataPrefixHex, 80),
    hasVerifyDataPayload: !!seed.verifyDataPayload,
    verifyDataPayloadKeys: seed.verifyDataPayload && typeof seed.verifyDataPayload === 'object'
      ? Object.keys(seed.verifyDataPayload).sort()
      : [],
    initRequest: seed.initRequest
      ? {
        timestamp: seed.initRequest.timestamp || null,
        nonce: seed.initRequest.nonce || null,
        language: seed.initRequest.language || null,
        mode: seed.initRequest.mode || null,
      }
      : null,
    verifyRequest: seed.verifyRequest
      ? {
        timestamp: seed.verifyRequest.timestamp || null,
        nonce: seed.verifyRequest.nonce || null,
      }
      : null,
  };
}

function summarizeSourceResultForFailure(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    localReplaySeedPresence: {
      compact: !!result.localReplayCompactSeed,
      live: !!result.localReplayLiveSeed,
      minimal: !!result.localReplayMinimalLiveSeed,
      ultraMinimal: !!result.localReplayUltraMinimalLiveSeed,
    },
    localReplaySeedIssues: Array.isArray(result.localReplaySeedIssues) ? result.localReplaySeedIssues : null,
    localReplayCompactSeedIssues: Array.isArray(result.localReplayCompactSeedIssues) ? result.localReplayCompactSeedIssues : null,
    localReplayFullFlowSkipped: result.localReplayFullFlowSkipped || null,
    localReplayCompactFullFlowSkipped: result.localReplayCompactFullFlowSkipped || null,
    verifyPayload: result.verifyPayload
      ? {
        certifyId: result.verifyPayload.certifyId || null,
        sceneId: result.verifyPayload.sceneId || null,
        failover: result.verifyPayload.failover || null,
      }
      : null,
    successPayloadDecoded: result.successPayload?.decoded
      ? {
        certifyId: result.successPayload.decoded.certifyId || null,
        sceneId: result.successPayload.decoded.sceneId || null,
        securityTokenPresent: !!result.successPayload.decoded.securityToken,
      }
      : null,
    stage2OffsetLogs: result.stage2OffsetLogs
      ? {
        initState: Array.isArray(result.stage2OffsetLogs.initState)
          ? result.stage2OffsetLogs.initState.slice(0, 3).map((row) => ({
            stage: row?.stage || null,
            certifyId: row?.certifyId || null,
            configCertifyId: row?.configCertifyId || null,
            userCertifyId: row?.userCertifyId || null,
            limitedFlowToken: row?.limitedFlowToken || null,
            success: typeof row?.success === 'boolean' ? row.success : null,
            responseKeys: Array.isArray(row?.responseKeys) ? row.responseKeys.slice(0, 16) : null,
            stackTop: typeof row?.stack === 'string' ? row.stack.split('\n').slice(0, 5) : null,
          }))
          : null,
        callbackFlow: Array.isArray(result.stage2OffsetLogs.callbackFlow)
          ? result.stage2OffsetLogs.callbackFlow.slice(0, 3).map((row) => ({
            stage: row?.stage || null,
            certifyId: row?.certifyId || null,
            sceneId: row?.sceneId || null,
          }))
          : null,
        localFallback: Array.isArray(result.stage2OffsetLogs.localFallback)
          ? result.stage2OffsetLogs.localFallback.slice(0, 3).map((row) => ({
            stage: row?.stage || null,
            certifyId: row?.certifyId || null,
            code: row?.code || null,
          }))
          : null,
        dnFlow: Array.isArray(result.stage2OffsetLogs.dnFlow)
          ? result.stage2OffsetLogs.dnFlow.slice(0, 4).map((row) => ({
            stage: row?.stage || null,
            sceneId: row?.sceneId || null,
            erCertifyId: row?.erCertifyId || null,
            erDeviceToken: row?.erDeviceToken || null,
            inputKeys: Array.isArray(row?.inputKeys) ? row.inputKeys.slice(0, 12) : null,
          }))
          : null,
        peBizSuccess: Array.isArray(result.stage2OffsetLogs.peBizSuccess)
          ? result.stage2OffsetLogs.peBizSuccess.slice(0, 3).map((row) => ({
            stage: row?.stage || null,
            certifyId: row?.certifyId || null,
            sceneId: row?.sceneId || null,
            securityToken: row?.securityToken || null,
          }))
          : null,
      }
      : null,
    aliyunRuntimeCredentialLogs: Array.isArray(result.aliyunRuntimeCredentialLogs)
      ? result.aliyunRuntimeCredentialLogs.slice(0, 8).map((row) => ({
        stage: row?.stage || null,
        path: row?.path || null,
        prop: row?.prop || null,
        before: row?.before ?? null,
        after: row?.after ?? null,
        targetPath: row?.targetPath || null,
        targetKeys: Array.isArray(row?.targetKeys) ? row.targetKeys.slice(0, 16) : null,
        stackTop: typeof row?.stack === "string" ? row.stack.split("\n").slice(0, 6) : null,
        stackSourceSnippets: Array.isArray(row?.stackSourceSnippets)
          ? row.stackSourceSnippets.slice(0, 2)
          : null,
      }))
      : null,
    aliyunExtendAssignLogs: Array.isArray(result.aliyunExtendAssignLogs)
      ? result.aliyunExtendAssignLogs.slice(0, 12).map((row) => ({
        stage: row?.stage || null,
        key: row?.key || null,
        keys: Array.isArray(row?.keys) ? row.keys.slice(0, 16) : null,
        value: row?.value ?? null,
        preview: row?.preview ?? null,
        stackTop: typeof row?.stack === "string" ? row.stack.split("\n").slice(0, 6) : null,
      }))
      : null,
    jsonStringifyLogs: Array.isArray(result.jsonStringifyLogs)
      ? result.jsonStringifyLogs.slice(0, 4).map((row) => ({
        keys: Array.isArray(row?.keys) ? row.keys.slice(0, 12) : null,
        outputPreview: row?.outputPreview || null,
        runtimeCertifyId:
          row?.runtimeState?.instanceConfig?.certifyId ||
          row?.runtimeState?.captchaConfig?.certifyId ||
          row?.runtimeState?.initConfig?.certifyId ||
          null,
        stackTop: typeof row?.stack === "string" ? row.stack.split("\n").slice(0, 6) : null,
        stackSourceSnippets: Array.isArray(row?.stackSourceSnippets)
          ? row.stackSourceSnippets.slice(0, 3)
          : null,
      }))
      : null,
    liveCheckChainState: result.liveCheckChainState
      ? {
        canonicalSource: result.liveCheckChainState.canonicalSource || null,
        certifyId: result.liveCheckChainState.certifyId || null,
        sceneId: result.liveCheckChainState.verifyParamDecoded?.sceneId || null,
        hasInstanceState: !!result.liveCheckChainState.instanceState,
        initRequestHeaders: result.liveCheckChainState.initRequestHeaders || null,
        verifyRequestHeaders: result.liveCheckChainState.verifyRequestHeaders || null,
        initRequestResponseStatus: result.liveCheckChainState.initRequest?.responseStatus || null,
        verifyRequestResponseStatus: result.liveCheckChainState.verifyRequest?.responseStatus || null,
        runtimeConfigCertifyIds: result.liveCheckChainState.instanceState
          ? {
            initConfig: result.liveCheckChainState.instanceState.runtimeState?.initConfig?.certifyId || null,
            instanceConfig: result.liveCheckChainState.instanceState.runtimeState?.instanceConfig?.certifyId || null,
            captchaConfig: result.liveCheckChainState.instanceState.runtimeState?.captchaConfig?.certifyId || null,
            logInfoCId:
              result.liveCheckChainState.instanceState.runtimeState?.instanceConfig?.logInfo?.cId ||
              result.liveCheckChainState.instanceState.runtimeState?.captchaConfig?.logInfo?.cId ||
              result.liveCheckChainState.instanceState.runtimeState?.initConfig?.logInfo?.cId ||
              null,
          }
          : null,
      }
      : null,
    aliyunInitStateSnapshot: result.aliyunInitStateSnapshot?.preview
      ? {
        certifyId: result.aliyunInitStateSnapshot.preview.CertifyId?.value || null,
        certifiyIdLower: result.aliyunInitStateSnapshot.preview.certifyId?.value || null,
        cId: result.aliyunInitStateSnapshot.preview.cId?.value || null,
        userCertifyId: result.aliyunInitStateSnapshot.preview.UserCertifyId?.value || null,
        keys: Array.isArray(result.aliyunInitStateSnapshot.keys)
          ? result.aliyunInitStateSnapshot.keys.slice(0, 20)
          : [],
      }
      : null,
    initRequest: result.initRequest
      ? {
        url: result.initRequest.url || null,
        params: summarizeCaptchaActionParams(result.initRequest.params),
        headers: summarizeRequestHeaders(result.initRequest.headers),
      }
      : null,
    liveInitRequest: result.liveInitRequest
      ? {
        url: result.liveInitRequest.url || null,
        params: summarizeCaptchaActionParams(result.liveInitRequest.params),
        headers: summarizeRequestHeaders(result.liveInitRequest.headers),
      }
      : null,
    liveInit: result.liveInit?.bodyJson
      ? {
        requestId: result.liveInit.bodyJson.RequestId || null,
        code: result.liveInit.bodyJson.Code || null,
        success: typeof result.liveInit.bodyJson.Success === 'boolean' ? result.liveInit.bodyJson.Success : null,
        certifyId: result.liveInit.bodyJson.CertifyId || null,
        limitFlow: typeof result.liveInit.bodyJson.LimitFlow === 'boolean' ? result.liveInit.bodyJson.LimitFlow : null,
        limitedFlowToken: result.liveInit.bodyJson.LimitedFlowToken || null,
        responseKeys: result.liveInit.bodyJson && typeof result.liveInit.bodyJson === 'object'
          ? Object.keys(result.liveInit.bodyJson).slice(0, 20)
          : null,
      }
      : null,
    verifyRequest: (result.liveVerifyRequest || result.verifyRequest)
      ? {
        url: (result.liveVerifyRequest || result.verifyRequest).url || null,
        certifyId: (result.liveVerifyRequest || result.verifyRequest).params?.CertifyId || null,
        sceneId: (result.liveVerifyRequest || result.verifyRequest).params?.SceneId || null,
        hasCaptchaVerifyParam: !!(result.liveVerifyRequest || result.verifyRequest).params?.CaptchaVerifyParam,
        headers: summarizeRequestHeaders((result.liveVerifyRequest || result.verifyRequest).headers),
      }
      : null,
    liveVerify: result.liveVerify?.bodyJson?.Result
      ? {
        verifyResult: result.liveVerify.bodyJson.Result.VerifyResult ?? null,
        verifyCode: result.liveVerify.bodyJson.Result.VerifyCode || null,
        certifyId: result.liveVerify.bodyJson.Result.certifyId || null,
        securityTokenPresent: !!result.liveVerify.bodyJson.Result.securityToken,
      }
      : null,
    liveVerifyCertifyIdChoice: result.liveVerifyCertifyIdChoice || null,
    liveVerifyNormalizeSkipped: result.liveVerifyNormalizeSkipped || null,
    verifyDataReverse: result.verifyDataReverse
      ? {
        seedPrefixPresent: !!result.verifyDataReverse.seedPrefix,
        seedJsonKeys: result.verifyDataReverse.seedJsonParsed && typeof result.verifyDataReverse.seedJsonParsed === 'object'
          ? Object.keys(result.verifyDataReverse.seedJsonParsed).sort()
          : [],
      }
      : null,
  };
}

function summarizeSolverOptions(options) {
  if (!options || typeof options !== 'object') return null;
  return {
    executeLive: !!options.executeLive,
    executeLiveInVm: !!options.executeLiveInVm,
    stage2OffsetPreset: !!options.stage2OffsetPreset,
    executeLiveInit: options.executeLiveInit !== false,
    failSyntheticInit: !!options.failSyntheticInit,
    useMinimalLiveSeed: !!options.useMinimalLiveSeed,
    useUltraMinimalLiveSeed: !!options.useUltraMinimalLiveSeed,
    hasDocumentCookie: !!options.documentCookie,
    hasRequestHeaders: !!options.requestHeaders,
    locationHref: options.locationHref || null,
    referrer: options.referrer || null,
    fileCount: Array.isArray(options.files) ? options.files.length : 0,
    loaderPath: options.loaderPath || null,
  };
}

function toBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return raw === '1' || raw === 'true';
}

function parseJsonEnv(name, fallback = null) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return JSON.parse(raw);
}

function pickExistingFile(candidates) {
  const fs = require('fs');
  for (const candidate of candidates || []) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates?.[0] || null;
}

function resolvePreferredBundleConfig() {
  const envFeilin = process.env.AUTO_CAPTCHA_PURE_CODE_FEILIN || null;
  const envDynamic = process.env.AUTO_CAPTCHA_PURE_CODE_DYNAMIC || null;
  const envLoader = process.env.AUTO_CAPTCHA_PURE_CODE_LOADER || null;
  const preferred = resolveBundleConfig({
    feilinPath: envFeilin || pickExistingFile(['/tmp/feilin052.js', '/tmp/feilin.js']),
    dynamicPath: envDynamic || pickExistingFile(['/tmp/aliyun-pe-088.js', '/tmp/aliyun-pe.js']),
    loaderPath: envLoader || pickExistingFile(['/tmp/AliyunCaptcha.js']),
  });
  return {
    ...preferred,
    preferredFeilin: preferred.feilinPath,
    preferredDynamic: preferred.dynamicPath,
    preferredLoader: preferred.loaderPath,
  };
}

function buildSolverOptions() {
  const bundle = resolvePreferredBundleConfig();
  const syntheticEventsRaw = process.env.AUTO_CAPTCHA_PURE_CODE_SYNTHETIC_EVENTS || '';
  const envInitialAliyunCaptchaConfig = parseJsonEnv(
    'AUTO_CAPTCHA_PURE_CODE_INITIAL_ALIYUN_CAPTCHA_CONFIG',
  );
  const browserLikeDefaults = buildLatestBrowserProfile({
    initialAliyunCaptchaConfig: {
      region: 'sgp',
      prefix: 'no8xfe',
    },
    autoInitLanguage: 'en',
    autoInitConfig: {
      language: 'en',
      upLang: true,
    },
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
      'Sec-Ch-Ua': '"Chromium";v="147", "Not.A/Brand";v="8"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Linux"',
    },
    requestUrlRewriteMap: {
      'https://no8xfe.captcha-open.aliyuncs.com/': 'https://no8xfe.captcha-open-southeast.aliyuncs.com/',
      'https://upload.captcha-open.aliyuncs.com/': 'https://upload.captcha-open-southeast.aliyuncs.com/',
      'https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com/': 'https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com/',
      'https://cn-shanghai.device.saf.aliyuncs.com/': 'https://ap-southeast-1.device.saf.aliyuncs.com/',
      'https://cloudauth-device-pre.aliyuncs.com/': 'https://cloudauth-device-pre.ap-southeast-1.aliyuncs.com/',
      'https://pre-cn-shanghai.device.saf.aliyuncs.com/': 'https://pre-ap-southeast-1.device.saf.aliyuncs.com/',
    },
  });
  const loaderOnly = toBoolEnv('AUTO_CAPTCHA_PURE_CODE_LOADER_ONLY', true);
  return {
    files: loaderOnly ? [bundle.loaderPath] : [bundle.feilinPath, bundle.dynamicPath, bundle.loaderPath],
    loaderPath: bundle.loaderPath,
    loaderOnly,
    scriptFetchMode: process.env.AUTO_CAPTCHA_PURE_CODE_SCRIPT_FETCH_MODE || 'auto',
    scriptFetchCacheDir: process.env.AUTO_CAPTCHA_PURE_CODE_SCRIPT_FETCH_CACHE_DIR || '/tmp/aliyun-script-cache',
    scriptMappings: loaderOnly ? [] : undefined,
    executeLive: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_EXECUTE_LIVE', true),
    executeLiveInVm: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_EXECUTE_LIVE_IN_VM', true),
    useMinimalLiveSeed: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_EXPERIMENTAL_MINIMAL_SEED', false),
    useUltraMinimalLiveSeed: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_EXPERIMENTAL_ULTRA_MINIMAL_SEED', false),
    normalizeVerifyToken: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_NORMALIZE_VERIFY_TOKEN', false),
    syntheticEvents: syntheticEventsRaw ? JSON.parse(syntheticEventsRaw) : null,
    forceCallbackMode: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_FORCE_CALLBACK_MODE', false),
    documentCookie: process.env.AUTO_CAPTCHA_PURE_CODE_DOCUMENT_COOKIE || null,
    locationHref:
      process.env.AUTO_CAPTCHA_PURE_CODE_LOCATION_HREF || browserLikeDefaults.locationHref || null,
    referrer:
      process.env.AUTO_CAPTCHA_PURE_CODE_REFERRER || browserLikeDefaults.referrer || null,
    localStorageSeed: parseJsonEnv('AUTO_CAPTCHA_PURE_CODE_LOCAL_STORAGE_SEED'),
    sessionStorageSeed: parseJsonEnv('AUTO_CAPTCHA_PURE_CODE_SESSION_STORAGE_SEED'),
    cookieSeed: parseJsonEnv('AUTO_CAPTCHA_PURE_CODE_COOKIE_SEED'),
    navigatorOverrides:
      parseJsonEnv('AUTO_CAPTCHA_PURE_CODE_NAVIGATOR_OVERRIDES') ||
      browserLikeDefaults.navigatorOverrides ||
      null,
    screenOverrides:
      parseJsonEnv('AUTO_CAPTCHA_PURE_CODE_SCREEN_OVERRIDES') ||
      browserLikeDefaults.screenOverrides ||
      null,
    navigatorLanguages:
      parseJsonEnv('AUTO_CAPTCHA_PURE_CODE_NAVIGATOR_LANGUAGES') ||
      browserLikeDefaults.navigatorLanguages ||
      null,
    windowOverrides:
      parseJsonEnv('AUTO_CAPTCHA_PURE_CODE_WINDOW_OVERRIDES') ||
      browserLikeDefaults.windowOverrides ||
      null,
    autoInitLanguage:
      process.env.AUTO_CAPTCHA_PURE_CODE_AUTO_INIT_LANGUAGE ||
      browserLikeDefaults.autoInitLanguage ||
      null,
    autoInitConfig:
      parseJsonEnv('AUTO_CAPTCHA_PURE_CODE_AUTO_INIT_CONFIG') ||
      browserLikeDefaults.autoInitConfig ||
      null,
    requestHeaders:
      parseJsonEnv('AUTO_CAPTCHA_PURE_CODE_REQUEST_HEADERS') ||
      browserLikeDefaults.requestHeaders ||
      null,
    requestUrlRewriteMap:
      parseJsonEnv('AUTO_CAPTCHA_PURE_CODE_REQUEST_URL_REWRITE_MAP') ||
      browserLikeDefaults.requestUrlRewriteMap ||
      null,
    initialAliyunCaptchaConfig:
      envInitialAliyunCaptchaConfig ||
      browserLikeDefaults.initialAliyunCaptchaConfig ||
      { region: 'sgp', prefix: 'no8xfe' },
    slimOutput: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_SLIM_OUTPUT', true),
    setGlobalConfig: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_SET_GLOBAL_CONFIG', true),
    stage2OffsetPreset: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_STAGE2_OFFSET_PRESET', true),
    executeLiveInit: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_EXECUTE_LIVE_INIT', true),
    failSyntheticInit: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_FAIL_SYNTHETIC_INIT', false),
    ioMutationExperiment: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_IO_MUTATION_EXPERIMENT', false),
    iuMutationExperiment: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_IU_MUTATION_EXPERIMENT', false),
    manualTokenExperiment: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_MANUAL_TOKEN_EXPERIMENT', false),
    extendTableExperiment: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_EXTEND_TABLE_EXPERIMENT', false),
    reMutationExperiment: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_RE_MUTATION_EXPERIMENT', false),
    sessionIdBlobExperiment: toBoolEnv('AUTO_CAPTCHA_PURE_CODE_SESSIONID_BLOB_EXPERIMENT', false),
    customSessionIdBlobBase64: process.env.AUTO_CAPTCHA_PURE_CODE_CUSTOM_SESSIONID_BLOB_BASE64 || null,
    syntheticLog1DeviceConfig: process.env.AUTO_CAPTCHA_PURE_CODE_DISABLE_SYNTHETIC_LOG1_DEVICE_CONFIG === 'true'
      ? null
      : undefined,
  };
}

function serializeForm(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    body.set(key, value == null ? '' : String(value));
  }
  return body.toString();
}

function mergeSetCookieIntoSession(sessionContext, setCookieHeader) {
  if (!sessionContext || !setCookieHeader) return;
  const cookies = [];
  if (sessionContext.cookie) {
    cookies.push(...sessionContext.cookie.split(';').map((c) => c.trim()).filter(Boolean));
  }
  const newCookies = String(setCookieHeader)
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const rawCookie of newCookies) {
    const match = rawCookie.match(/^([^;]+)/);
    if (!match) continue;
    const pair = match[1].trim();
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.substring(0, eqIdx).trim();
    const filtered = cookies.filter((c) => !c.startsWith(`${key}=`));
    filtered.push(pair);
    cookies.length = 0;
    cookies.push(...filtered);
  }
  sessionContext.cookie = cookies.join('; ');
}

async function executeFormRequest(url, params, sessionContext = null) {
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
  if (sessionContext?.cookie) {
    headers.Cookie = sessionContext.cookie;
  }
  const body = serializeForm(params);
  const requestHeaders = { ...headers };
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });
  const bodyText = await response.text();
  let bodyJson = null;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = null;
  }
  mergeSetCookieIntoSession(sessionContext, response.headers.get('set-cookie'));
  return {
    requestUrl: url,
    requestHeaders,
    requestBody: body,
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    bodyText,
    bodyJson,
  };
}

function isoTimestampNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoTimestampFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
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

function buildFreshReplaySeedFromCompact(compactSeed) {
  const seed = expandCompactReplaySeed(compactSeed);
  const now = Date.now();
  const initTimestamp = isoTimestampFromMs(now);
  const verifyTimestamp = isoTimestampFromMs(now + 1000);
  return {
    ...seed,
    initRequest: {
      ...(seed.initRequest || {}),
      timestamp: initTimestamp,
      nonce: crypto.randomUUID(),
    },
    verifyRequest: {
      ...(seed.verifyRequest || {}),
      timestamp: verifyTimestamp,
      nonce: crypto.randomUUID(),
    },
  };
}

function buildFreshReplaySeedFromLive(liveSeed) {
  const now = Date.now();
  return expandLiveReplaySeed(liveSeed, {
    initTimestamp: isoTimestampFromMs(now),
    initNonce: crypto.randomUUID(),
    verifyTimestamp: isoTimestampFromMs(now + 1000),
    verifyNonce: crypto.randomUUID(),
  });
}

function buildFreshReplaySeedFromMinimal(minimalSeed) {
  const now = Date.now();
  return expandMinimalLiveReplaySeed(minimalSeed, {
    initTimestamp: isoTimestampFromMs(now),
    initNonce: crypto.randomUUID(),
    verifyTimestamp: isoTimestampFromMs(now + 1000),
    verifyNonce: crypto.randomUUID(),
  });
}

function buildFreshReplaySeedFromUltraMinimal(ultraSeed) {
  const now = Date.now();
  return expandUltraMinimalLiveReplaySeed(ultraSeed, {
    initTimestamp: isoTimestampFromMs(now),
    initNonce: crypto.randomUUID(),
    verifyTimestamp: isoTimestampFromMs(now + 1000),
    verifyNonce: crypto.randomUUID(),
  });
}

function applyLiveDeviceConfigToSeed(seed, liveDeviceConfig, certifyId) {
  if (!seed?.runtimeContext || !liveDeviceConfig?.sessionId) {
    return seed;
  }
  return {
    ...seed,
    runtimeContext: {
      ...seed.runtimeContext,
      nO: liveDeviceConfig.sessionId,
      sessionTimestamp: liveDeviceConfig.timestamp || seed.runtimeContext.sessionTimestamp,
      ip: liveDeviceConfig.ip || seed.runtimeContext.ip,
      certifyId: certifyId || seed.runtimeContext.certifyId,
    },
  };
}

function rewriteVerifyRequestCertifyId(verifyRequest, certifyId) {
  if (!verifyRequest?.params || !certifyId) {
    return verifyRequest;
  }
  const nextParams = { ...verifyRequest.params, CertifyId: certifyId };
  if (nextParams.CaptchaVerifyParam) {
    const parsed = JSON.parse(nextParams.CaptchaVerifyParam);
    parsed.certifyId = certifyId;
    nextParams.CaptchaVerifyParam = JSON.stringify(parsed);
  }
  nextParams.Signature = signCaptchaParams(nextParams);
  return {
    url: verifyRequest.url,
    params: nextParams,
  };
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

async function replaySupplementalCaptchaActions(result, baseSessionContext = null, explicitCertifyId = null) {
  const xhrLog = Array.isArray(result?.xhrLog) ? result.xhrLog : [];
  if (!xhrLog.length) {
    return [];
  }
  const certifyId = explicitCertifyId
    || result?.liveVerify?.bodyJson?.Result?.certifyId
    || result?.verifyRequest?.params?.CertifyId
    || null;
  const byAction = new Map();
  for (const entry of xhrLog) {
    const action = entry?.params?.Action;
    if (typeof action === 'string' && !byAction.has(action)) {
      byAction.set(action, entry);
    }
  }
  const order = ['Log1', 'UploadLog', 'Log2', 'Log3'];
  const sessionContext = {
    cookie: baseSessionContext?.cookie || '',
    requestHeaders: baseSessionContext?.requestHeaders
      ? { ...baseSessionContext.requestHeaders }
      : null,
  };
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
      });
    } catch (error) {
      responses.push({
        action,
        ok: false,
        error: String(error && error.stack || error),
      });
    }
  }
  return responses;
}

function buildPayloadFromSolverResult(seedToken, result) {
  const liveVerifyPayload = result?.synthesizedFromLiveVerify?.captcha_verify_param;
  const decoded = result?.synthesizedFromLiveVerify?.decoded || null;
  const hasProbeCredential = typeof decoded?.securityToken === 'string' && decoded.securityToken.includes('probe-security-token')
    || typeof decoded?.certifyId === 'string' && decoded.certifyId.includes('probe-certify-id')
    || typeof liveVerifyPayload === 'string' && (liveVerifyPayload.includes('probe-security-token') || liveVerifyPayload.includes('probe-certify-id'));
  if (typeof liveVerifyPayload === 'string' && liveVerifyPayload && !hasProbeCredential) {
    return {
      token: seedToken,
      captcha_verify_param: liveVerifyPayload,
      source: 'pure-code-worker-live-verify',
    };
  }

  return null;
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

async function solveViaLoaderOnlyLiveProbe(effectiveOptions) {
  const report = await runProbe([effectiveOptions.loaderPath || '/tmp/AliyunCaptcha.js'], {
    executeLive: true,
    liveXhrWaitTimeoutMs: 6000,
    scriptFetchMode: effectiveOptions.scriptFetchMode || 'auto',
    scriptFetchCacheDir: effectiveOptions.scriptFetchCacheDir || '/tmp/aliyun-script-cache',
    scriptMappings: [],
    failSyntheticInit: effectiveOptions.failSyntheticInit === true,
    captureXhrStacks: true,
    setGlobalAliyunCaptchaConfig: effectiveOptions.setGlobalConfig !== false,
    initialAliyunCaptchaConfig: effectiveOptions.initialAliyunCaptchaConfig || { region: 'sgp', prefix: 'no8xfe' },
    documentCookie: effectiveOptions.documentCookie || null,
    locationHref: effectiveOptions.locationHref || 'https://chat.z.ai/c/live-probe',
    referrer: effectiveOptions.referrer || '',
    localStorageSeed: effectiveOptions.localStorageSeed || null,
    sessionStorageSeed: effectiveOptions.sessionStorageSeed || null,
    cookieSeed: effectiveOptions.cookieSeed || null,
    navigatorOverrides: effectiveOptions.navigatorOverrides || null,
    screenOverrides: effectiveOptions.screenOverrides || null,
    navigatorLanguages: effectiveOptions.navigatorLanguages || null,
    windowOverrides: effectiveOptions.windowOverrides || null,
    requestHeaders: effectiveOptions.requestHeaders || null,
    autoInitLanguage: effectiveOptions.autoInitLanguage || 'en',
    autoInitConfig: effectiveOptions.autoInitConfig || { language: 'en', upLang: true },
  });

  const verifyEntry = Array.isArray(report?.xhrLog)
    ? report.xhrLog.find((entry) => entry?.params?.Action === 'VerifyCaptchaV3') || null
    : null;
  const verifyResult = verifyEntry?.responseJson?.Result || null;
  const certifyId = verifyResult?.certifyId || verifyEntry?.params?.CertifyId || null;
  const sceneId = verifyEntry?.params?.SceneId
    || report?.liveCheckChainState?.verifyParamDecoded?.sceneId
    || report?.liveCheckChainState?.initRequest?.params?.SceneId
    || 'didk33e0';
  const securityToken = verifyResult?.securityToken || null;
  const synthesizedFromLiveVerify = (verifyResult?.VerifyResult === true && securityToken && certifyId && sceneId)
    ? {
        captcha_verify_param: encodeFinalCaptchaVerifyParam({
          certifyId,
          sceneId,
          securityToken,
        }),
        decoded: {
          certifyId,
          sceneId,
          isSign: true,
          securityToken,
        },
      }
    : null;

  return {
    evalOk: report?.evalOk === true,
    autoInit: report?.autoInit || [],
    xhrActions: Array.isArray(report?.xhrLog) ? report.xhrLog.map((entry) => entry?.params?.Action).filter(Boolean) : [],
    xhrLog: Array.isArray(report?.xhrLog) ? report.xhrLog : [],
    asyncErrors: report?.asyncErrors || [],
    liveCheckChainState: report?.liveCheckChainState || null,
    scriptLoadLogs: report?.scriptLoadLogs || [],
    liveVerify: verifyEntry?.responseJson
      ? {
          status: verifyResult?.VerifyResult === true ? 200 : 400,
          ok: verifyResult?.VerifyResult === true,
          headers: verifyEntry?.responseHeaders || {},
          bodyText: verifyEntry?.response || null,
          bodyJson: verifyEntry.responseJson,
        }
      : null,
    synthesizedFromLiveVerify,
    loaderOnlyLiveProbe: {
      verifyCode: verifyResult?.VerifyCode || null,
      verifyResult: verifyResult?.VerifyResult ?? null,
      certifyId,
      sceneId,
      scriptLoadCount: Array.isArray(report?.scriptLoadLogs) ? report.scriptLoadLogs.length : 0,
    },
  };
}

async function solveViaExternalLoaderProbe() {
  const out = spawnSync(process.execPath, ['--max-old-space-size=512', 'tools/aliyun_loader_family_probe.js'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
    env: {
      ...process.env,
    },
  });
  if (out.status !== 0) {
    throw new Error(`external loader probe failed: status=${out.status} stderr=${(out.stderr || '').slice(0, 2000)}`);
  }
  const parsed = JSON.parse(String(out.stdout || '').trim() || '{}');
  const securityToken = typeof parsed.securityToken === 'string' ? parsed.securityToken : null;
  const certifyId = typeof parsed.certifyId === 'string' ? parsed.certifyId : null;
  const sceneId = typeof parsed.sceneId === 'string' ? parsed.sceneId : 'didk33e0';
  const synthesizedFromLiveVerify = (parsed.verifyResult === true && securityToken && certifyId && sceneId)
    ? {
        captcha_verify_param: encodeFinalCaptchaVerifyParam({
          certifyId,
          sceneId,
          securityToken,
        }),
        decoded: {
          certifyId,
          sceneId,
          isSign: true,
          securityToken,
        },
      }
    : null;
  return {
    liveVerify: {
      bodyJson: {
        Result: {
          VerifyCode: parsed.verifyCode || null,
          VerifyResult: parsed.verifyResult ?? null,
          securityToken,
          certifyId,
        },
      },
    },
    synthesizedFromLiveVerify,
    loaderOnlyLiveProbe: parsed,
  };
}

function summarizeDecodedToken(value) {
  const raw = value ? String(value) : '';
  const parts = raw ? raw.split('#') : [];
  return {
    preview: raw ? raw.slice(0, 220) : null,
    partsCount: parts.length,
    prefix: parts[0] || null,
    secondPreview: parts[1] ? parts[1].slice(0, 140) : null,
    thirdPreview: parts[2] ? parts[2].slice(0, 220) : null,
    thirdLen: parts[2] ? parts[2].length : 0,
    fourth: parts[3] || null,
    fifth: parts[4] || null,
  };
}

function buildProbeFromSolverResult(result) {
  if (!result || typeof result !== 'object') return null;
  const sessionDerive = Array.isArray(result.feilinSessionDeriveLogs) ? result.feilinSessionDeriveLogs[0] || null : null;
  const verifyResult = result.liveVerify?.bodyJson?.Result || null;
  const firstVLog = Array.isArray(result.n0PartLogs)
    ? result.n0PartLogs.find((entry) => entry?.name === 'v') || null
    : null;
  return {
    canonicalLiveSource: result.liveCheckChainState?.canonicalSource || null,
    verifyCode: verifyResult?.VerifyCode || null,
    verifyResult: verifyResult?.VerifyResult ?? null,
    securityTokenPresent: !!verifyResult?.securityToken,
    replayVerifyCode: result.replayLiveVerify?.bodyJson?.Result?.VerifyCode || null,
    replayVerifyResult: result.replayLiveVerify?.bodyJson?.Result?.VerifyResult ?? null,
    initDeviceToken: summarizeDecodedToken(result.initDeviceTokenPreview),
    browserLikeInitDeviceToken: summarizeDecodedToken(result.browserLikeInitDeviceTokenPreview),
    um: summarizeDecodedToken(result.umTokenPreview),
    zUm: summarizeDecodedToken(result.zUmTokenPreview),
    postAutoInitUm: summarizeDecodedToken(result.postAutoInitUmTokenPreview),
    postAutoInitZUm: summarizeDecodedToken(result.postAutoInitZUmTokenPreview),
    postAutoInitUmWithCertifyId: summarizeDecodedToken(result.postAutoInitUmTokenWithCertifyIdPreview),
    postAutoInitZUmWithCertifyId: summarizeDecodedToken(result.postAutoInitZUmTokenWithCertifyIdPreview),
    sessionDerive: sessionDerive
      ? {
        reSecretPreview: sessionDerive.reSecretPreview || null,
        reSessionPreview: sessionDerive.reSessionPreview || null,
        wSecretPreview: sessionDerive.wSecretPreview || null,
        wSessionPreview: sessionDerive.wSessionPreview || null,
      }
      : null,
    deriveHelperCalls: Array.isArray(result.feilinDeriveHelperCalls)
      ? result.feilinDeriveHelperCalls.slice(0, 24).map((row) => ({
        helper: row?.helper || null,
        stage: row?.stage || null,
        argc: row?.argc ?? null,
        outputPreview: row?.output?.preview ?? null,
        outputDecodedUtf8: row?.output?.decodedUtf8 ?? null,
      }))
      : [],
    localStorageKeys: Object.keys(result.localStorageSnapshot || {}).sort(),
    sessionStorageKeys: Object.keys(result.sessionStorageSnapshot || {}).sort(),
    localStorageArmsSession: result.localStorageSnapshot?._arms_session || null,
    documentCookiePreview: result.documentCookie ? String(result.documentCookie).slice(0, 240) : null,
    runtimeDeviceConfigSessionId:
      result.feilinReSnapshot?.preview?.deviceConfig?.value?.sessionId || null,
    runtimeHref:
      result.feilinReSnapshot?.preview?.deviceData?.value?.dfghfgdh6 || null,
    feilinReKeys: Array.isArray(result.feilinReSnapshot?.keys) ? result.feilinReSnapshot.keys : [],
    deviceCvsKeys: Array.isArray(result.aliyunDeviceCvsSnapshot?.keys) ? result.aliyunDeviceCvsSnapshot.keys : [],
    deviceIfrKeys: Array.isArray(result.aliyunDeviceIfrSnapshot?.keys) ? result.aliyunDeviceIfrSnapshot.keys : [],
    deviceDataEntries: Array.isArray(result.feilinDeviceDataEntries) ? result.feilinDeviceDataEntries.slice(0, 260) : [],
    deviceDataOverrideExperiment: result.deviceDataOverrideExperiment || null,
    deviceObjectOverrideExperiment: result.deviceObjectOverrideExperiment || null,
    rsExperiment: Array.isArray(result.rsExperiment)
      ? result.rsExperiment.map((row) => ({
        label: row?.label || null,
        outputType: row?.outputType || null,
        outputString: typeof row?.outputString === 'string' ? row.outputString.slice(0, 400) : row?.outputString ?? null,
        outputStringLength: typeof row?.outputStringLength === 'number' ? row.outputStringLength : null,
        outputDecodedPreview: typeof row?.outputDecodedPreview === 'string' ? row.outputDecodedPreview.slice(0, 220) : row?.outputDecodedPreview ?? null,
        error: row?.error || null,
      }))
      : result.rsExperiment || null,
    rsAidReplayExperiment: result.rsAidReplayExperiment
      ? {
        successSample: result.rsAidReplayExperiment?.successSample || null,
        nullSample: result.rsAidReplayExperiment?.nullSample || null,
        rows: Array.isArray(result.rsAidReplayExperiment?.rows)
          ? result.rsAidReplayExperiment.rows.map((row) => ({
            label: row?.label || null,
            aid: row?.aid ?? null,
            argsMode: row?.argsMode || null,
            outputType: row?.outputType || null,
            outputString: typeof row?.outputString === 'string' ? row.outputString.slice(0, 400) : row?.outputString ?? null,
            outputDecodedPreview: typeof row?.outputDecodedPreview === 'string' ? row.outputDecodedPreview.slice(0, 220) : row?.outputDecodedPreview ?? null,
            error: row?.error || null,
          }))
          : result.rsAidReplayExperiment?.rows || null,
      }
      : null,
    directRxSessionResult: result.directRxSessionResult || null,
    feilinUySummary: Array.isArray(result.feilinUyLogs)
      ? result.feilinUyLogs.slice(0, 24).map((row) => ({
        stage: row?.stage || null,
        ubKey: row?.ubKey || null,
        callKey: row?.callKey || null,
        nType: row?.nType || null,
        callableType: row?.callableType || null,
        value: typeof row?.value === 'string' ? row.value.slice(0, 220) : row?.value ?? null,
      }))
      : result.feilinUyLogs || null,
    feilinUbSummary: Array.isArray(result.feilinUbLogs)
      ? result.feilinUbLogs
        .filter((row) => typeof row?.arg0 === 'number')
        .slice(0, 40)
        .map((row) => ({
          stage: row?.stage || null,
          arg0: row?.arg0 ?? null,
          arg1: typeof row?.arg1 === 'string' ? row.arg1.slice(0, 220) : row?.arg1 ?? null,
          returnType: row?.returnType || null,
          returnValue: typeof row?.returnValue === 'string' ? row.returnValue.slice(0, 220) : row?.returnValue ?? null,
          stackPreview: typeof row?.stack === 'string' ? row.stack.split('\n').slice(0, 4) : null,
        }))
      : result.feilinUbLogs || null,
    customSessionIdBlobResult: result.customSessionIdBlobResult || null,
    sessionIdBlobExperimentSummary: result.sessionIdBlobExperiment
      ? {
        secretKeyBytes: result.sessionIdBlobExperiment.secretKeyBytes || null,
        sessionIdBytes: result.sessionIdBlobExperiment.sessionIdBytes || null,
        sharedPrefixBytes: result.sessionIdBlobExperiment.sharedPrefixBytes || null,
        baseline: result.sessionIdBlobExperiment.baseline
          ? {
            uyReturn: result.sessionIdBlobExperiment.baseline?.intermediates?.uyReturn || null,
            second: result.sessionIdBlobExperiment.baseline?.parsed?.second || null,
            thirdLen: result.sessionIdBlobExperiment.baseline?.parsed?.third
              ? String(result.sessionIdBlobExperiment.baseline.parsed.third).length
              : 0,
            fifth: result.sessionIdBlobExperiment.baseline?.parsed?.fifth || null,
            error: result.sessionIdBlobExperiment.baseline?.error || null,
          }
          : null,
        rows: Array.isArray(result.sessionIdBlobExperiment.rows)
          ? result.sessionIdBlobExperiment.rows.map((row) => ({
            label: row?.label || null,
            sharedPrefixWithSecret: row?.sharedPrefixWithSecret ?? null,
            uyReturn: row?.intermediates?.uyReturn || null,
            second: row?.parsed?.second || null,
            thirdLen: row?.parsed?.third ? String(row.parsed.third).length : 0,
            fifth: row?.parsed?.fifth || null,
            error: row?.error || null,
          }))
          : [],
      }
      : null,
    rkMutationApplied: result.rkMutationApplied || null,
    feilinRkSnapshotAfterMutation: result.feilinRkSnapshotAfterMutation || null,
    tokenVector: result.tokenVector
      ? {
        candidateIndex: result.tokenVector.candidateIndex ?? null,
        second: result.tokenVector.second || null,
        trPreview: result.tokenVector.trPreview || null,
        xPrefix: result.tokenVector.xPrefix || null,
        uy: result.tokenVector.uy || null,
        ce: result.tokenVector.ce || null,
        ceTimestamp: result.tokenVector.ceTimestamp || null,
        ci: result.tokenVector.ci || null,
        ciTimestamp: result.tokenVector.ciTimestamp || null,
        o6: result.tokenVector.o6 || null,
        secondTimestamp: result.tokenVector.secondTimestamp || null,
        mHex: result.tokenVector.mHex || null,
        BHex: result.tokenVector.BHex || null,
        lLength: result.tokenVector.lLength || null,
      }
      : null,
    bestVectorThirdRuntimeCandidate: result.bestVectorThirdRuntimeCandidate
      ? {
        arg1Length: result.bestVectorThirdRuntimeCandidate.arg1Length ?? null,
        arg1ExactMatchToBestVector: !!result.bestVectorThirdRuntimeCandidate.arg1ExactMatchToBestVector,
        outputStringLength: result.bestVectorThirdRuntimeCandidate.outputStringLength ?? null,
        outputPreview: result.bestVectorThirdRuntimeCandidate.outputPreview || null,
        innerStages: result.bestVectorThirdRuntimeCandidate.innerStages || [],
      }
      : null,
    firstVLog: firstVLog
      ? {
        valuePreview: typeof firstVLog.value === 'string' ? firstVLog.value.slice(0, 220) : firstVLog.value,
        xPreview: typeof firstVLog.xPreview === 'string' ? firstVLog.xPreview.slice(0, 140) : firstVLog.xPreview,
        lPreview: typeof firstVLog.lPreview === 'string' ? firstVLog.lPreview.slice(0, 2200) : firstVLog.lPreview,
        lLength: typeof firstVLog.lLength === 'number' ? firstVLog.lLength : null,
      }
      : null,
    liveCheckChainState: result.liveCheckChainState || null,
    replayLiveCheckChainState: result.replayLiveCheckChainState || null,
  };
}

function mergeSolverOptions(baseOptions, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ...baseOptions };
  }
  const merged = { ...baseOptions };
  const directKeys = [
    'executeLive',
    'executeLiveInVm',
    'useMinimalLiveSeed',
    'useUltraMinimalLiveSeed',
    'normalizeVerifyToken',
    'syntheticEvents',
    'forceCallbackMode',
    'documentCookie',
    'locationHref',
    'referrer',
    'localStorageSeed',
    'sessionStorageSeed',
    'cookieSeed',
    'navigatorOverrides',
    'screenOverrides',
    'navigatorLanguages',
    'windowOverrides',
    'initialAliyunCaptchaConfig',
    'slimOutput',
    'autoInitLanguage',
    'autoInitConfig',
    'requestHeaders',
    'requestUrlRewriteMap',
    'setGlobalConfig',
    'executeLiveInit',
    'failSyntheticInit',
    'ioMutationExperiment',
    'iuMutationExperiment',
    'manualTokenExperiment',
    'extendTableExperiment',
    'reMutationExperiment',
    'sessionIdBlobExperiment',
    'customSessionIdBlobBase64',
    'syntheticLog1DeviceConfig',
    'deviceDataOverrideExperimentInputs',
    'deviceObjectOverrideExperimentInputs',
    'reMutationExperimentInputs',
    'rkMutationExperimentInputs',
    'rsExperimentInputs',
    'rsAidReplayExperiment',
    'directRxSessionIdBase64',
    'directRxTr',
    'cryptoTraceTargets',
    'raTraceTargets',
    'stringOpTargets',
    'stringCharOpTargets',
    'stringSliceTargets',
    'literalSnippetPatches',
    'offsetSnippetPatches',
    'mutateInitAliyunCaptchaConfig',
    'fallbackCertifyId',
  ];
  for (const key of directKeys) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      merged[key] = overrides[key];
    }
  }
  if (Array.isArray(overrides.files) && overrides.files.length) {
    merged.files = overrides.files.map((item) => String(item));
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'loaderPath')) {
    merged.loaderPath = overrides.loaderPath ? String(overrides.loaderPath) : null;
  }
  return merged;
}

class PureCodeCaptchaWorker {
  constructor() {
    this.baseOptions = buildSolverOptions();
    this.requestCount = 0;
    this.lastWarmAt = null;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.lastCompactReplaySeed = null;
    this.lastLiveReplaySeed = null;
    this.lastMinimalLiveReplaySeed = null;
    this.lastUltraMinimalLiveReplaySeed = null;
    this.lastCompactReplaySeedBytes = 0;
    this.lastLiveReplaySeedBytes = 0;
    this.lastMinimalLiveReplaySeedBytes = 0;
    this.lastUltraMinimalLiveReplaySeedBytes = 0;
    this.lastReplaySource = null;
    this.cachedReplayUseCount = 0;
    this.lastFailureSnapshotPath = null;
    this.lastFallbackCertifyId = null;
  }

  snapshot() {
    return {
      requestCount: this.requestCount,
      files: this.baseOptions.files,
      executeLive: !!this.baseOptions.executeLive,
      executeLiveInVm: !!this.baseOptions.executeLiveInVm,
      stage2OffsetPreset: !!this.baseOptions.stage2OffsetPreset,
      useMinimalLiveSeed: !!this.baseOptions.useMinimalLiveSeed,
      useUltraMinimalLiveSeed: !!this.baseOptions.useUltraMinimalLiveSeed,
      failSyntheticInit: !!this.baseOptions.failSyntheticInit,
      normalizeVerifyToken: !!this.baseOptions.normalizeVerifyToken,
      slimOutput: !!this.baseOptions.slimOutput,
      hasSyntheticEvents: !!this.baseOptions.syntheticEvents,
      forceCallbackMode: !!this.baseOptions.forceCallbackMode,
      hasDocumentCookie: !!this.baseOptions.documentCookie,
      hasLocationHref: !!this.baseOptions.locationHref,
      hasReferrer: !!this.baseOptions.referrer,
      hasLocalStorageSeed: !!this.baseOptions.localStorageSeed,
      hasSessionStorageSeed: !!this.baseOptions.sessionStorageSeed,
      hasCookieSeed: !!this.baseOptions.cookieSeed,
      hasNavigatorOverrides: !!this.baseOptions.navigatorOverrides,
      hasScreenOverrides: !!this.baseOptions.screenOverrides,
      hasWindowOverrides: !!this.baseOptions.windowOverrides,
      setGlobalConfig: this.baseOptions.setGlobalConfig !== false,
      executeLiveInit: this.baseOptions.executeLiveInit !== false,
      ioMutationExperiment: !!this.baseOptions.ioMutationExperiment,
      iuMutationExperiment: !!this.baseOptions.iuMutationExperiment,
      manualTokenExperiment: !!this.baseOptions.manualTokenExperiment,
      extendTableExperiment: !!this.baseOptions.extendTableExperiment,
      reMutationExperiment: !!this.baseOptions.reMutationExperiment,
      sessionIdBlobExperiment: !!this.baseOptions.sessionIdBlobExperiment,
      hasCustomSessionIdBlobBase64: !!this.baseOptions.customSessionIdBlobBase64,
      lastWarmAt: this.lastWarmAt,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      hasCompactReplaySeed: !!this.lastCompactReplaySeed,
      compactReplaySeedBytes: this.lastCompactReplaySeedBytes,
      hasLiveReplaySeed: !!this.lastLiveReplaySeed,
      liveReplaySeedBytes: this.lastLiveReplaySeedBytes,
      hasMinimalLiveReplaySeed: !!this.lastMinimalLiveReplaySeed,
      minimalLiveReplaySeedBytes: this.lastMinimalLiveReplaySeedBytes,
      hasUltraMinimalLiveReplaySeed: !!this.lastUltraMinimalLiveReplaySeed,
      ultraMinimalLiveReplaySeedBytes: this.lastUltraMinimalLiveReplaySeedBytes,
      lastReplaySource: this.lastReplaySource,
      cachedReplayUseCount: this.cachedReplayUseCount,
      lastFailureSnapshotPath: this.lastFailureSnapshotPath,
      lastFallbackCertifyId: this.lastFallbackCertifyId,
    };
  }

  writeFailureSnapshot(kind, payload) {
    try {
      ensureDirSync(FAILURE_SNAPSHOT_DIR);
      const filePath = path.join(
        FAILURE_SNAPSHOT_DIR,
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}.json`,
      );
      fs.writeFileSync(filePath, JSON.stringify({
        createdAt: new Date().toISOString(),
        kind,
        worker: this.snapshot(),
        ...payload,
      }, null, 2));
      this.lastFailureSnapshotPath = filePath;
      return filePath;
    } catch (error) {
      this.lastFailureSnapshotPath = `write-failed:${String(error && error.message || error)}`;
      return null;
    }
  }

  buildReplaySeedCandidate() {
    const candidates = [];
    if (this.baseOptions.useUltraMinimalLiveSeed && this.lastUltraMinimalLiveReplaySeed) {
      const seed = backfillReplaySeedCertifyId(
        buildFreshReplaySeedFromUltraMinimal(this.lastUltraMinimalLiveReplaySeed),
        this.lastFallbackCertifyId,
      );
      candidates.push({
        source: 'ultra-minimal-live-seed',
        seed,
        missing: collectReplaySeedIssues(seed),
      });
    }
    if (this.baseOptions.useMinimalLiveSeed && this.lastMinimalLiveReplaySeed) {
      const seed = backfillReplaySeedCertifyId(
        buildFreshReplaySeedFromMinimal(this.lastMinimalLiveReplaySeed),
        this.lastFallbackCertifyId,
      );
      candidates.push({
        source: 'minimal-live-seed',
        seed,
        missing: collectReplaySeedIssues(seed),
      });
    }
    if (this.lastLiveReplaySeed) {
      const seed = backfillReplaySeedCertifyId(
        buildFreshReplaySeedFromLive(this.lastLiveReplaySeed),
        this.lastFallbackCertifyId,
      );
      candidates.push({
        source: 'live-seed',
        seed,
        missing: collectReplaySeedIssues(seed),
      });
    }
    if (this.lastCompactReplaySeed) {
      const seed = backfillReplaySeedCertifyId(
        buildFreshReplaySeedFromCompact(this.lastCompactReplaySeed),
        this.lastFallbackCertifyId,
      );
      candidates.push({
        source: 'compact-seed',
        seed,
        missing: collectReplaySeedIssues(seed),
      });
    }
    if (!candidates.length) {
      return {
        source: 'none',
        seed: null,
        missing: ['seed'],
        alternatives: [],
      };
    }
    candidates.sort((a, b) => a.missing.length - b.missing.length);
    return {
      ...candidates[0],
      alternatives: candidates.map((candidate) => ({
        source: candidate.source,
        missing: candidate.missing,
      })),
    };
  }

  validateReplaySeed(seed, meta = {}) {
    const missing = collectReplaySeedIssues(seed);
    if (!missing.length) {
      return { ok: true, missing: [] };
    }
    const reason = `replay seed incomplete: ${missing.join(', ')}`;
    this.lastError = reason;
    this.writeFailureSnapshot('replay-seed-incomplete', {
      reason,
      missing,
      replaySource: meta.replaySource || null,
      replayAlternatives: Array.isArray(meta.replayAlternatives) ? meta.replayAlternatives : null,
      seedSummary: summarizeReplaySeed(seed),
      sourceResultSummary: summarizeSourceResultForFailure(meta.sourceResult),
      sourceResultDebug: summarizeFailureDebugFields(meta.sourceResult),
    });
    return { ok: false, missing, reason };
  }

  async warm() {
    this.lastWarmAt = Date.now();
    for (const file of this.baseOptions.files) {
      if (!require('fs').existsSync(file)) {
        throw new Error(`missing solver file: ${file}`);
      }
    }
    return {
      ok: true,
      warmed: true,
      worker: this.snapshot(),
    };
  }

  async fetchCaptcha(seedToken) {
    return this.fetchCaptchaWithOptions(seedToken, null);
  }

  updateReplaySeedsFromResult(result) {
    const fallbackCertifyId = pickFallbackCertifyIdFromResult(result);
    if (fallbackCertifyId) {
      this.lastFallbackCertifyId = fallbackCertifyId;
    }
    this.lastCompactReplaySeed = result?.localReplayCompactSeed || null;
    this.lastLiveReplaySeed = result?.localReplayLiveSeed || null;
    this.lastMinimalLiveReplaySeed = result?.localReplayMinimalLiveSeed || null;
    this.lastUltraMinimalLiveReplaySeed = result?.localReplayUltraMinimalLiveSeed || null;
    this.lastCompactReplaySeedBytes = this.lastCompactReplaySeed
      ? Buffer.byteLength(JSON.stringify(this.lastCompactReplaySeed), 'utf8')
      : 0;
    this.lastLiveReplaySeedBytes = this.lastLiveReplaySeed
      ? Buffer.byteLength(JSON.stringify(this.lastLiveReplaySeed), 'utf8')
      : 0;
    this.lastMinimalLiveReplaySeedBytes = this.lastMinimalLiveReplaySeed
      ? Buffer.byteLength(JSON.stringify(this.lastMinimalLiveReplaySeed), 'utf8')
      : 0;
    this.lastUltraMinimalLiveReplaySeedBytes = this.lastUltraMinimalLiveReplaySeed
      ? Buffer.byteLength(JSON.stringify(this.lastUltraMinimalLiveReplaySeed), 'utf8')
      : 0;
    this.lastReplaySource = result?.localReplayLiveSeed
      ? 'live-seed'
      : result?.localReplayCompactSeed
      ? 'compact-seed'
      : null;
  }

  async fetchCaptchaWithOptions(seedToken, optionOverrides) {
    this.requestCount += 1;
    this.lastRunAt = Date.now();
    const effectiveOptions = mergeSolverOptions(this.baseOptions, optionOverrides);
    const overrideFallbackCertifyId = typeof effectiveOptions.fallbackCertifyId === 'string'
      ? effectiveOptions.fallbackCertifyId.trim()
      : '';
    if (
      overrideFallbackCertifyId &&
      overrideFallbackCertifyId !== 'null' &&
      overrideFallbackCertifyId !== 'undefined'
    ) {
      this.lastFallbackCertifyId = overrideFallbackCertifyId;
    }
    if (effectiveOptions.executeLive && !optionOverrides &&
      (this.lastUltraMinimalLiveReplaySeed || this.lastMinimalLiveReplaySeed || this.lastLiveReplaySeed)) {
      const replayCandidate = this.buildReplaySeedCandidate();
      const replayValidation = this.validateReplaySeed(replayCandidate.seed, {
        replaySource: replayCandidate.source,
        replayAlternatives: replayCandidate.alternatives,
      });
      if (replayValidation.ok) {
        try {
          const replayResult = await this.fetchCaptchaFromCachedReplay(
            seedToken,
            effectiveOptions,
            null,
            replayCandidate,
          );
          if (replayResult && replayResult.payload && replayResult.payload.captcha_verify_param) {
            this.lastSuccessAt = Date.now();
            this.lastError = null;
            this.lastReplaySource = 'compact-live-replay';
            this.cachedReplayUseCount += 1;
            return replayResult;
          } else {
            this.lastError = `cached replay returned empty payload, falling back to full solve`;
          }
        } catch (error) {
          this.lastError = `cached replay failed: ${String(error && error.stack || error)}`;
          this.writeFailureSnapshot('cached-replay-error', {
            reason: this.lastError,
            replaySource: replayCandidate.source,
            replayAlternatives: replayCandidate.alternatives,
            seedSummary: summarizeReplaySeed(replayCandidate.seed),
          });
        }
      }
    }
    let result = null;
    if (effectiveOptions.executeLive) {
      try {
        const externalLoaderProbeResult = await solveViaExternalLoaderProbe();
        if (externalLoaderProbeResult?.synthesizedFromLiveVerify?.captcha_verify_param) {
          this.lastSuccessAt = Date.now();
          this.lastError = null;
          this.lastReplaySource = 'external-loader-live-probe';
          return {
            payload: buildPayloadFromSolverResult(seedToken, externalLoaderProbeResult),
            raw: externalLoaderProbeResult,
          };
        }
        this.writeFailureSnapshot('external-loader-live-probe-empty', {
          verifyCode: externalLoaderProbeResult?.loaderOnlyLiveProbe?.verifyCode || null,
          verifyResult: externalLoaderProbeResult?.loaderOnlyLiveProbe?.verifyResult ?? null,
          certifyId: externalLoaderProbeResult?.loaderOnlyLiveProbe?.certifyId || null,
          sceneId: externalLoaderProbeResult?.loaderOnlyLiveProbe?.sceneId || null,
          securityTokenPresent: typeof externalLoaderProbeResult?.loaderOnlyLiveProbe?.securityToken === 'string',
        });
        result = externalLoaderProbeResult;
      } catch (error) {
        this.lastError = `external loader probe failed: ${String(error && error.stack || error)}`;
        this.writeFailureSnapshot('external-loader-live-probe-error', {
          reason: this.lastError,
        });
      }

      try {
        const loaderProbeResult = await solveViaLoaderOnlyLiveProbe(effectiveOptions);
        if (loaderProbeResult?.synthesizedFromLiveVerify?.captcha_verify_param) {
          this.lastSuccessAt = Date.now();
          this.lastError = null;
          this.lastReplaySource = 'loader-only-live-probe';
          this.updateReplaySeedsFromResult(loaderProbeResult);
          return {
            payload: buildPayloadFromSolverResult(seedToken, loaderProbeResult),
            raw: loaderProbeResult,
          };
        }
        this.writeFailureSnapshot('loader-only-live-probe-empty', {
          verifyCode: loaderProbeResult?.loaderOnlyLiveProbe?.verifyCode || null,
          verifyResult: loaderProbeResult?.loaderOnlyLiveProbe?.verifyResult ?? null,
          certifyId: loaderProbeResult?.loaderOnlyLiveProbe?.certifyId || null,
          sceneId: loaderProbeResult?.loaderOnlyLiveProbe?.sceneId || null,
          xhrActions: loaderProbeResult?.xhrActions || [],
          asyncErrors: loaderProbeResult?.asyncErrors || [],
          scriptLoadLogs: loaderProbeResult?.scriptLoadLogs || [],
        });
        result = loaderProbeResult;
      } catch (error) {
        this.lastError = `loader-only live probe failed: ${String(error && error.stack || error)}`;
        this.writeFailureSnapshot('loader-only-live-probe-error', {
          reason: this.lastError,
          solverOptions: summarizeSolverOptions(effectiveOptions),
        });
      }

      let seedOnlyResult = null;
      try {
        seedOnlyResult = await solveCaptcha({
          ...effectiveOptions,
          executeLive: false,
          executeLiveInVm: false,
        });
      } catch (error) {
        this.lastError = `seed-only solve failed: ${String(error && error.stack || error)}`;
        this.writeFailureSnapshot('seed-only-solve-error', {
          reason: this.lastError,
          solverOptions: summarizeSolverOptions({
            ...effectiveOptions,
            executeLive: false,
            executeLiveInVm: false,
          }),
        });
        throw error;
      }
      this.updateReplaySeedsFromResult(seedOnlyResult);
      if (this.lastCompactReplaySeed || this.lastLiveReplaySeed) {
        const replayCandidate = this.buildReplaySeedCandidate();
        const replayValidation = this.validateReplaySeed(replayCandidate.seed, {
          replaySource: replayCandidate.source,
          replayAlternatives: replayCandidate.alternatives,
          sourceResult: seedOnlyResult,
        });
        if (replayValidation.ok) {
          const replayResult = await this.fetchCaptchaFromCachedReplay(
            seedToken,
            effectiveOptions,
            seedOnlyResult,
            replayCandidate,
          );
          if (replayResult?.raw) {
            replayResult.raw.seedOnlyResult = seedOnlyResult;
          }
          if (replayResult?.payload?.captcha_verify_param) {
            this.lastSuccessAt = Date.now();
            this.lastError = null;
            this.lastReplaySource = 'compact-live-replay';
            this.cachedReplayUseCount += 1;
            return replayResult;
          }
          result = {
            ...seedOnlyResult,
            replayAttempt: replayResult?.raw || null,
            replayLiveInit: replayResult?.raw?.liveInit || null,
            replayLiveVerifyRequest: replayResult?.raw?.liveVerifyRequest || null,
            replayLiveVerify: replayResult?.raw?.liveVerify || null,
            replayLiveCheckChainState: replayResult?.raw?.liveCheckChainState || null,
            replaySynthesizedFromLiveVerify: replayResult?.raw?.synthesizedFromLiveVerify || null,
          };
        } else {
          result = {
            ...seedOnlyResult,
            replayAttemptSkipped: {
              reason: replayValidation.reason,
              missing: replayValidation.missing,
              replaySource: replayCandidate.source,
              replayAlternatives: replayCandidate.alternatives,
              seedSummary: summarizeReplaySeed(replayCandidate.seed),
            },
          };
        }
      } else {
        result = seedOnlyResult;
      }
      const needsDirectLiveSolve = !result?.synthesizedFromLiveVerify?.captcha_verify_param;
      if (needsDirectLiveSolve) {
        try {
          const liveSolveResult = await solveCaptcha(effectiveOptions);
          result = result && typeof result === 'object'
            ? {
              ...result,
              directLiveSolveResult: {
                liveCheckChainState: liveSolveResult?.liveCheckChainState || null,
                liveInitRequest: liveSolveResult?.liveInitRequest || null,
                liveInit: liveSolveResult?.liveInit || null,
                liveVerifyRequest: liveSolveResult?.liveVerifyRequest || null,
                liveVerify: liveSolveResult?.liveVerify || null,
                synthesizedFromLiveVerify: liveSolveResult?.synthesizedFromLiveVerify || null,
              },
              ...liveSolveResult,
            }
            : liveSolveResult;
          this.updateReplaySeedsFromResult(result);
          const postLiveReplayCandidate = this.buildReplaySeedCandidate();
          const postLiveReplayValidation = this.validateReplaySeed(postLiveReplayCandidate.seed, {
            replaySource: postLiveReplayCandidate.source,
            replayAlternatives: postLiveReplayCandidate.alternatives,
            sourceResult: result,
          });
          if (postLiveReplayValidation.ok) {
            const postLiveReplayResult = await this.fetchCaptchaFromCachedReplay(
              seedToken,
              effectiveOptions,
              result,
              postLiveReplayCandidate,
            );
            if (postLiveReplayResult?.raw) {
              postLiveReplayResult.raw.liveSolveSourceResult = result;
            }
            if (postLiveReplayResult?.payload?.captcha_verify_param) {
              this.lastSuccessAt = Date.now();
              this.lastError = null;
              this.lastReplaySource = 'compact-live-replay';
              this.cachedReplayUseCount += 1;
              return postLiveReplayResult;
            }
            result = result && typeof result === 'object'
              ? {
                ...result,
                postLiveReplayAttempt: postLiveReplayResult?.raw || null,
                postLiveReplayLiveInit: postLiveReplayResult?.raw?.liveInit || null,
                postLiveReplayLiveVerifyRequest: postLiveReplayResult?.raw?.liveVerifyRequest || null,
                postLiveReplayLiveVerify: postLiveReplayResult?.raw?.liveVerify || null,
                postLiveReplayLiveCheckChainState: postLiveReplayResult?.raw?.liveCheckChainState || null,
                postLiveReplaySynthesizedFromLiveVerify: postLiveReplayResult?.raw?.synthesizedFromLiveVerify || null,
              }
              : result;
          }
        } catch (error) {
          this.lastError = `direct live solve failed after seed-only path: ${String(error && error.stack || error)}`;
          this.writeFailureSnapshot('direct-live-solve-after-seed-error', {
            reason: this.lastError,
            solverOptions: summarizeSolverOptions(effectiveOptions),
            sourceResultSummary: summarizeSourceResultForFailure(result),
          });
          throw error;
        }
      }
    } else {
      try {
        result = await solveCaptcha(effectiveOptions);
      } catch (error) {
        this.lastError = `direct solve failed: ${String(error && error.stack || error)}`;
        this.writeFailureSnapshot('direct-solve-error', {
          reason: this.lastError,
          solverOptions: summarizeSolverOptions(effectiveOptions),
        });
        throw error;
      }
    }
    result.supplementalReplay = await replaySupplementalCaptchaActions(result, {
      cookie: effectiveOptions.documentCookie || '',
      requestHeaders: effectiveOptions.requestHeaders
        ? { ...effectiveOptions.requestHeaders }
        : null,
    });
    const payload = buildPayloadFromSolverResult(seedToken, result);
    if (payload?.captcha_verify_param) {
      this.lastSuccessAt = Date.now();
      this.lastError = null;
    } else {
      const verifyCode =
        result?.liveVerify?.bodyJson?.Result?.VerifyCode ||
        result?.replayLiveVerify?.bodyJson?.Result?.VerifyCode ||
        'unknown';
      this.lastError = `full solve produced no live captcha payload (verifyCode=${verifyCode})`;
      this.writeFailureSnapshot('full-solve-empty-payload', {
        reason: this.lastError,
        verifyCode,
        sourceResultSummary: summarizeSourceResultForFailure(result),
        sourceResultDebug: summarizeFailureDebugFields(result),
      });
    }
    this.updateReplaySeedsFromResult(result);
    return {
      payload,
      raw: result,
    };
  }

  async probe(optionOverrides) {
    const result = await this.fetchCaptchaWithOptions('', optionOverrides);
    return {
      probe: buildProbeFromSolverResult(result.raw),
      raw: result.raw,
    };
  }

  async fetchCaptchaFromCachedReplay(seedToken, effectiveOptions = this.baseOptions, sourceResult = null, replayCandidate = null) {
    const effectiveReplayCandidate = replayCandidate || this.buildReplaySeedCandidate();
    const seed = effectiveReplayCandidate.seed;
    let flow = null;
    try {
      flow = buildPureLocalFlowFromSeed(seed);
    } catch (error) {
      this.lastError = `cached replay flow build failed: ${String(error && error.stack || error)}`;
      this.writeFailureSnapshot('cached-replay-flow-build-failed', {
        reason: this.lastError,
        replaySource: effectiveReplayCandidate.source,
        seedSummary: summarizeReplaySeed(seed),
        sourceResultSummary: summarizeSourceResultForFailure(sourceResult),
      });
      throw error;
    }
    const sessionContext = {
      cookie: effectiveOptions?.documentCookie || '',
      requestHeaders: effectiveOptions?.requestHeaders
        ? { ...effectiveOptions.requestHeaders }
        : null,
    };
    const liveInit = await executeFormRequest(flow.initRequest.url, flow.initRequest.params, sessionContext);
    const liveInitRequest = {
      url: liveInit?.requestUrl || flow.initRequest.url,
      params: flow.initRequest.params,
      headers: liveInit?.requestHeaders || null,
      body: liveInit?.requestBody || null,
    };
    const liveCertifyId = liveInit?.bodyJson?.CertifyId || null;
    let effectiveFlow = flow;
    let liveDeviceConfig = null;
    const liveDeviceConfigRaw = liveInit?.bodyJson?.DeviceConfig || null;
    if (liveDeviceConfigRaw) {
      try {
        liveDeviceConfig = parseDeviceConfigToken(liveDeviceConfigRaw);
        const adjustedSeed = applyLiveDeviceConfigToSeed(seed, liveDeviceConfig, liveCertifyId);
        effectiveFlow = buildPureLocalFlowFromSeed(adjustedSeed);
      } catch {
        liveDeviceConfig = null;
      }
    }
    const supplementalReplay = await replaySupplementalCaptchaActions(
      sourceResult,
      sessionContext,
      liveCertifyId || seed.runtimeContext.certifyId,
    );
    const liveVerifyRequest = rewriteVerifyRequestCertifyId(
      effectiveFlow.verifyRequest,
      liveCertifyId || seed.runtimeContext.certifyId,
    );
    const liveVerify = await executeFormRequest(liveVerifyRequest.url, liveVerifyRequest.params, sessionContext);
    const liveVerifyRequestWithHeaders = {
      url: liveVerify?.requestUrl || liveVerifyRequest.url,
      params: liveVerifyRequest.params,
      headers: liveVerify?.requestHeaders || null,
      body: liveVerify?.requestBody || null,
    };
    const verifyResult = liveVerify?.bodyJson?.Result?.VerifyResult === true;
    const securityToken = verifyResult ? (liveVerify?.bodyJson?.Result?.securityToken || null) : null;
    const effectiveCertifyId = liveCertifyId || seed.runtimeContext.certifyId;
    let verifyParamDecoded = null;
    if (typeof liveVerifyRequest?.params?.CaptchaVerifyParam === 'string' && liveVerifyRequest.params.CaptchaVerifyParam) {
      try {
        verifyParamDecoded = JSON.parse(liveVerifyRequest.params.CaptchaVerifyParam);
      } catch {
        verifyParamDecoded = null;
      }
    }
    const synthesizedFromLiveVerify = (verifyResult && securityToken)
      ? {
        captcha_verify_param: encodeFinalCaptchaVerifyParam({
          certifyId: effectiveCertifyId,
          sceneId: seed.sceneId,
          securityToken,
        }),
        decoded: {
          certifyId: effectiveCertifyId,
          sceneId: seed.sceneId,
          isSign: true,
          securityToken,
        },
      }
      : null;
    return {
      payload: synthesizedFromLiveVerify
        ? {
          token: seedToken,
          captcha_verify_param: synthesizedFromLiveVerify.captcha_verify_param,
          source: 'pure-code-worker-compact-live-replay',
        }
        : null,
      raw: {
        initRequest: flow.initRequest,
        verifyRequest: effectiveFlow.verifyRequest,
        liveInitRequest,
        sessionCookie: sessionContext.cookie,
        liveInit,
        liveVerifyRequest: liveVerifyRequestWithHeaders,
        liveVerify,
        liveCheckChainState: {
          certifyId: effectiveCertifyId,
          securityToken,
          verifyParam: liveVerifyRequest?.params?.CaptchaVerifyParam || null,
          verifyParamDecoded,
          initRequest: liveInitRequest,
          verifyRequest: liveVerifyRequestWithHeaders,
          vmInitResponse: sourceResult?.initRequest?.responseJson || null,
          vmVerifyResponse: sourceResult?.verifyRequest?.responseJson || null,
          vmFailPayload: Array.isArray(sourceResult?.autoInit)
            ? sourceResult.autoInit.find((item) => item?.type === 'fail')?.payload || null
            : null,
          supplementalReplay,
          instanceState: sourceResult?.liveCheckChainState?.instanceState || null,
        },
        localReplayCompactSeed: this.lastCompactReplaySeed,
        localReplayLiveSeed: this.lastLiveReplaySeed,
        localReplayMinimalLiveSeed: this.lastMinimalLiveReplaySeed,
        localReplayUltraMinimalLiveSeed: this.lastUltraMinimalLiveReplaySeed,
        localReplayFullFlow: effectiveFlow,
        liveDeviceConfig,
        supplementalReplay,
        synthesizedFromLiveVerify,
        replaySeedSource: effectiveReplayCandidate.source,
      },
    };
  }
}

async function main() {
  const worker = new PureCodeCaptchaWorker();
  emit({ ready: true, source: 'pure-code-worker', worker: worker.snapshot() });
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const lineRaw of rl) {
    const line = String(lineRaw || "").trim();
    if (!line) continue;
    let req = null;
    try {
      req = JSON.parse(line);
      const action = String(req?.action || 'captcha');
      const request_id = req?.request_id || null;
      if (action === 'ping') {
        emit({ ok: true, pong: true, request_id, worker: worker.snapshot() });
        continue;
      }
      if (action === 'warm') {
        const result = await worker.warm();
        emit({ ok: true, request_id, warmed: true, worker: result.worker });
        continue;
      }
      if (action === 'status') {
        emit({ ok: true, request_id, worker: worker.snapshot() });
        continue;
      }
      if (action === 'probe') {
        const result = await worker.probe(req?.options || null);
        emit({
          ok: true,
          request_id,
          probe: result.probe,
          result: req?.include_raw ? result.raw : undefined,
          worker: worker.snapshot(),
        });
        continue;
      }
      if (action === 'shutdown') {
        emit({ ok: true, shutdown: true, request_id, worker: worker.snapshot() });
        rl.close();
        break;
      }
      const token = String(req?.token || '').trim();
      const result = await worker.fetchCaptchaWithOptions(token, req?.options || null);
      emit({
        ok: true,
        request_id,
        payload: result.payload,
        result: req?.include_raw ? result.raw : undefined,
        worker: worker.snapshot(),
      });
    } catch (err) {
      worker.lastError = String(err && err.stack || err);
      emit({
        ok: false,
        request_id: req?.request_id || null,
        error: String(err && err.stack || err),
        worker: worker.snapshot(),
      });
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
