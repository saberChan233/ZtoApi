#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { solveCaptcha, buildLatestBrowserProfile } = require('./browserless_aliyun_captcha_solver');
const { signCaptchaParams } = require('./aliyun_local_reverse');
const { normalizeToBrowserLikeInitToken, parseTokenPlain } = require('./feilin_local_token');

const DEFAULT_FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];
const DEFAULT_BROWSER_CAPTURE_PATH = path.resolve(process.cwd(), 'browser_capture_verify.json');
const DEFAULT_VERIFY_URL = 'https://no8xfe.captcha-open-southeast.aliyuncs.com/';

function readCommandStdout(command, args) {
  try {
    return String(spawnSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    }).stdout || '').trim();
  } catch {
    return '';
  }
}

function detectSystemProxyUrl() {
  try {
    const mode = readCommandStdout('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);
    if (!mode.includes('manual')) return null;
    const httpHost = readCommandStdout('gsettings', ['get', 'org.gnome.system.proxy.http', 'host']).replaceAll("'", '').trim();
    const httpPort = readCommandStdout('gsettings', ['get', 'org.gnome.system.proxy.http', 'port']).trim();
    if (httpHost && httpPort && httpPort !== '0') return `http://${httpHost}:${httpPort}`;
    const socksHost = readCommandStdout('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host']).replaceAll("'", '').trim();
    const socksPort = readCommandStdout('gsettings', ['get', 'org.gnome.system.proxy.socks', 'port']).trim();
    if (socksHost && socksPort && socksPort !== '0') return `socks5h://${socksHost}:${socksPort}`;
  } catch {
    return null;
  }
  return null;
}

function parseHostResolveOverrides(spec) {
  const out = {};
  for (const part of String(spec || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean)) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const host = part.slice(0, idx).trim().toLowerCase();
    const ip = part.slice(idx + 1).trim();
    if (host && ip) out[host] = ip;
  }
  return out;
}

const WORKER_PROXY_URL = (
  process.env.UPSTREAM_PROXY_URL ||
  detectSystemProxyUrl() ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy ||
  ''
).trim() || null;

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

function serializeForm(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    body.set(key, value == null ? '' : String(value));
  }
  return body.toString();
}

function parseHeadersFromRawBlock(raw) {
  const headers = {};
  const lines = String(raw || '').split(/\r?\n/).slice(1);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    headers[key] = value;
  }
  return headers;
}

function extractLastHttpHeaderBlock(raw) {
  const blocks = String(raw || '').split(/\r?\n\r?\n/).map((block) => block.trim()).filter(Boolean);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].startsWith('HTTP/')) return blocks[i];
  }
  return blocks[blocks.length - 1] || '';
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
  const merged = new Map();
  for (const item of [...cookies, ...newCookies]) {
    const pair = item.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    merged.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  sessionContext.cookie = Array.from(merged.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function executeFormRequest(url, params, sessionContext = null) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztoapi-light-roll-'));
  const headerPath = path.join(tempDir, 'headers.txt');
  const bodyPath = path.join(tempDir, 'body.txt');
  try {
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
      'Sec-Fetch-Site': 'cross-site',
      ...(sessionContext?.requestHeaders || {}),
    };
    if (sessionContext?.cookie) {
      headers.Cookie = sessionContext.cookie;
    }
    const args = [
      '-sS',
      '-L',
      '--compressed',
      '-D',
      headerPath,
      '-o',
      bodyPath,
      '-X',
      'POST',
      ...getCurlResolveArgsForUrl(url),
    ];
    if (WORKER_PROXY_URL) {
      args.push('--proxy', WORKER_PROXY_URL);
    }
    for (const [key, value] of Object.entries(headers)) {
      args.push('-H', `${key}: ${value}`);
    }
    args.push('--data-binary', '@-');
    args.push(url);
    const body = serializeForm(params);
    const out = spawnSync('curl', args, {
      input: Buffer.from(body, 'utf8'),
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
    const headersObj = parseHeadersFromRawBlock(lastHeaderBlock);
    const bodyText = fs.existsSync(bodyPath) ? fs.readFileSync(bodyPath, 'utf8') : '';
    let bodyJson = null;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      bodyJson = null;
    }
    mergeSetCookieIntoSession(sessionContext, headersObj['set-cookie'] || null);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: headersObj,
      bodyText,
      bodyJson,
      request: { url, params, headers, body },
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function isoTimestampNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function refreshSignedCaptchaParams(params) {
  const nextParams = {
    ...(params || {}),
    Timestamp: isoTimestampNow(),
    SignatureNonce: crypto.randomUUID(),
  };
  nextParams.Signature = signCaptchaParams(nextParams);
  return nextParams;
}

function decodeCaptchaVerifyParam(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function decodeDeviceTokenPlainFromPayload(payload) {
  const token = payload?.deviceToken;
  if (typeof token !== 'string' || !token) return null;
  try {
    return Buffer.from(token, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function rewriteVerifyRequest(baseRequest, certifyId, { deviceTokenBase64 = null } = {}) {
  const params = { ...(baseRequest?.params || {}) };
  const payload = decodeCaptchaVerifyParam(params.CaptchaVerifyParam);
  if (!payload) {
    throw new Error('missing CaptchaVerifyParam payload');
  }
  payload.certifyId = certifyId;
  if (deviceTokenBase64) {
    payload.deviceToken = deviceTokenBase64;
  }
  params.CertifyId = certifyId;
  params.CaptchaVerifyParam = JSON.stringify(payload);
  return {
    url: baseRequest?.url || DEFAULT_VERIFY_URL,
    params: refreshSignedCaptchaParams(params),
    payload,
  };
}

function buildRollingInitRequest(baseInitParams, deviceTokenBase64) {
  const next = {
    AccessKeyId: baseInitParams.AccessKeyId,
    SignatureMethod: baseInitParams.SignatureMethod,
    SignatureVersion: baseInitParams.SignatureVersion,
    Format: baseInitParams.Format,
    Version: baseInitParams.Version,
    Action: 'InitCaptchaV3',
    SceneId: baseInitParams.SceneId,
    Language: baseInitParams.Language,
    Mode: baseInitParams.Mode,
    UpLang: baseInitParams.UpLang,
    DeviceToken: deviceTokenBase64,
  };
  return {
    url: DEFAULT_VERIFY_URL,
    params: refreshSignedCaptchaParams(next),
  };
}

function summarizeVerifyPayload(payload) {
  const tokenPlain = decodeDeviceTokenPlainFromPayload(payload);
  const token = parseTokenPlain(tokenPlain);
  return {
    certifyId: payload?.certifyId || null,
    sceneId: payload?.sceneId || null,
    dataLen: typeof payload?.data === 'string' ? payload.data.length : null,
    keys: payload && typeof payload === 'object' ? Object.keys(payload).sort() : [],
    token: token
      ? {
        prefix: token.prefix,
        secondLen: token.second ? token.second.length : null,
        thirdLen: token.third ? token.third.length : null,
        fourth: token.fourth,
      }
      : null,
  };
}

function summarizeResponse(response) {
  const result = response?.bodyJson?.Result || null;
  return {
    code: response?.bodyJson?.Code || null,
    success: response?.bodyJson?.Success ?? null,
    certifyId: response?.bodyJson?.CertifyId || result?.CertifyId || null,
    captchaType: result?.CaptchaType || response?.bodyJson?.CaptchaType || null,
    verifyCode: result?.VerifyCode || null,
    verifyResult: result?.VerifyResult ?? null,
  };
}

function loadBrowserCapture(filePath) {
  const resolved = path.resolve(filePath || DEFAULT_BROWSER_CAPTURE_PATH);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return {
    initRequest: {
      url: DEFAULT_VERIFY_URL,
      params: parsed.init_form,
    },
    verifyRequest: {
      url: DEFAULT_VERIFY_URL,
      params: parsed.verify_form,
    },
  };
}

async function buildRuntimeSeed(profile) {
  return await solveCaptcha({
    executeLive: false,
    executeLiveInVm: false,
    slimOutput: true,
    stage2OffsetPreset: false,
    files: DEFAULT_FILES,
    loaderPath: DEFAULT_FILES[2],
    setGlobalConfig: true,
    locationHref: profile.locationHref,
    referrer: profile.referrer,
    navigatorOverrides: profile.navigatorOverrides,
    navigatorLanguages: profile.navigatorLanguages,
    screenOverrides: profile.screenOverrides,
    autoInitLanguage: profile.autoInitLanguage,
    autoInitConfig: profile.autoInitConfig,
    requestHeaders: profile.requestHeaders,
    initialAliyunCaptchaConfig: { region: 'sgp', prefix: 'no8xfe' },
  });
}

async function runChain({ mode = 'runtime', rounds = 2, browserCapturePath = DEFAULT_BROWSER_CAPTURE_PATH } = {}) {
  const profile = buildLatestBrowserProfile();
  const seed = await buildRuntimeSeed(profile);
  const runtimeInitRequest = seed.initRequest;
  const runtimeVerifyRequest = seed.liveCheckChainState?.verifyRequest || seed.verifyRequest;
  if (!runtimeInitRequest?.params?.DeviceData || !runtimeVerifyRequest?.params?.CaptchaVerifyParam) {
    throw new Error('runtime seed missing init/verify templates');
  }

  const browserCapture = fs.existsSync(browserCapturePath) ? loadBrowserCapture(browserCapturePath) : null;
  const firstInitTemplate = mode === 'browser-capture' && browserCapture
    ? browserCapture.initRequest
    : runtimeInitRequest;
  const verifyTemplate = mode === 'browser-capture' && browserCapture
    ? browserCapture.verifyRequest
    : runtimeVerifyRequest;

  const sessionContext = {
    cookie: '',
    requestHeaders: profile.requestHeaders,
  };

  const chain = [];

  const round1InitParams = { ...firstInitTemplate.params };
  delete round1InitParams.DeviceToken;
  const round1Init = {
    url: firstInitTemplate.url,
    params: refreshSignedCaptchaParams(round1InitParams),
  };
  const round1InitResponse = await executeFormRequest(round1Init.url, round1Init.params, sessionContext);
  const round1CertifyId = round1InitResponse.bodyJson?.CertifyId || null;
  const round1Verify = rewriteVerifyRequest(verifyTemplate, round1CertifyId);
  const round1VerifyResponse = await executeFormRequest(round1Verify.url, round1Verify.params, sessionContext);
  chain.push({
    round: 1,
    mode,
    initRequest: {
      hasDeviceData: !!round1Init.params.DeviceData,
      hasDeviceToken: !!round1Init.params.DeviceToken,
      deviceDataLen: typeof round1Init.params.DeviceData === 'string' ? round1Init.params.DeviceData.length : null,
    },
    initResponse: summarizeResponse(round1InitResponse),
    verifyPayload: summarizeVerifyPayload(round1Verify.payload),
    verifyResponse: summarizeResponse(round1VerifyResponse),
  });

  let lastVerifyPayload = round1Verify.payload;
  for (let round = 2; round <= rounds; round += 1) {
    const priorPlain = decodeDeviceTokenPlainFromPayload(lastVerifyPayload);
    const normalized = normalizeToBrowserLikeInitToken(priorPlain || '');
    const rollingTokenBase64 = normalized?.ok
      ? Buffer.from(normalized.normalizedPlain, 'utf8').toString('base64')
      : lastVerifyPayload?.deviceToken || null;
    if (!rollingTokenBase64) break;
    const rollingInit = buildRollingInitRequest(firstInitTemplate.params, rollingTokenBase64);
    const rollingInitResponse = await executeFormRequest(rollingInit.url, rollingInit.params, sessionContext);
    const rollingCertifyId = rollingInitResponse.bodyJson?.CertifyId || null;
    const rollingVerify = rewriteVerifyRequest(verifyTemplate, rollingCertifyId, {
      deviceTokenBase64: lastVerifyPayload?.deviceToken || null,
    });
    const rollingVerifyResponse = await executeFormRequest(rollingVerify.url, rollingVerify.params, sessionContext);
    chain.push({
      round,
      mode,
      initRequest: {
        hasDeviceData: !!rollingInit.params.DeviceData,
        hasDeviceToken: !!rollingInit.params.DeviceToken,
        rollingInitToken: summarizeVerifyPayload({ deviceToken: rollingTokenBase64 }).token,
      },
      initResponse: summarizeResponse(rollingInitResponse),
      verifyPayload: summarizeVerifyPayload(rollingVerify.payload),
      verifyResponse: summarizeResponse(rollingVerifyResponse),
    });
    lastVerifyPayload = rollingVerify.payload;
  }

  return {
    mode,
    roundsRequested: rounds,
    proxyUrl: WORKER_PROXY_URL,
    hostResolveOverrides: WORKER_HOST_RESOLVE_OVERRIDES,
    runtimeSeed: {
      initHasDeviceData: !!runtimeInitRequest.params?.DeviceData,
      initHasDeviceToken: !!runtimeInitRequest.params?.DeviceToken,
      verifyPayload: summarizeVerifyPayload(decodeCaptchaVerifyParam(runtimeVerifyRequest.params?.CaptchaVerifyParam)),
    },
    chain,
  };
}

function parseArgs(argv) {
  const args = { mode: 'runtime', rounds: 2, browserCapturePath: DEFAULT_BROWSER_CAPTURE_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode' && argv[i + 1]) args.mode = argv[++i];
    else if (arg === '--rounds' && argv[i + 1]) args.rounds = Number(argv[++i]) || 2;
    else if (arg === '--browser' && argv[i + 1]) args.browserCapturePath = path.resolve(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runChain(args);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
} else {
  module.exports = {
    DEFAULT_BROWSER_CAPTURE_PATH,
    DEFAULT_FILES,
    DEFAULT_VERIFY_URL,
    buildRuntimeSeed,
    decodeCaptchaVerifyParam,
    decodeDeviceTokenPlainFromPayload,
    executeFormRequest,
    loadBrowserCapture,
    refreshSignedCaptchaParams,
    rewriteVerifyRequest,
    runChain,
    summarizeResponse,
    summarizeVerifyPayload,
  };
}
