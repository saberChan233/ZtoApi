#!/usr/bin/env node
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { buildTokenVectorFromReport, buildTokenLPreviewFromVector } = require('./aliyun_token_vector');

function makeRecorder(limit = 5000) {
  const events = [];
  return {
    push(type, path, detail) {
      if (events.length < limit) events.push({ type, path, detail });
    },
    all() {
      return events;
    },
  };
}

function downloadScriptToCacheSync(src, cacheDir = '/tmp/aliyun-script-cache') {
  if (typeof src !== 'string' || !/^https?:\/\//i.test(src)) return null;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch {}
  const url = new URL(src);
  const base = path.basename(url.pathname || 'script.js') || 'script.js';
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
  const filePath = path.join(cacheDir, `${hash}-${base}`);
  if (fs.existsSync(filePath)) return filePath;
  const out = spawnSync('curl', ['-L', '-sS', src, '-o', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (out.status !== 0 || !fs.existsSync(filePath)) {
    try { fs.rmSync(filePath, { force: true }); } catch {}
    return null;
  }
  return filePath;
}

function makeMagic(path, recorder) {
  const fn = function (...args) {
    recorder.push('call', path, { argc: args.length });
    return makeMagic(`${path}()`, recorder);
  };
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) {
        return (hint) => {
          recorder.push('coerce', path, { hint });
          if (hint === 'number') return 0;
          return '';
        };
      }
      if (prop === 'toString') return () => `[magic ${path}]`;
      if (prop === 'valueOf') return () => 0;
      if (prop === 'then') return undefined;
      const next = `${path}.${String(prop)}`;
      recorder.push('get', next, null);
      return makeMagic(next, recorder);
    },
    set(_target, prop, value) {
      recorder.push('set', `${path}.${String(prop)}`, { type: typeof value });
      return true;
    },
    apply(_target, _thisArg, args) {
      recorder.push('apply', path, { argc: args.length });
      return makeMagic(`${path}()`, recorder);
    },
    construct(_target, args) {
      recorder.push('construct', path, { argc: args.length });
      return makeMagic(`new ${path}`, recorder);
    },
    has() {
      return true;
    },
  });
}

function previewValue(value, limit = 400) {
  if (typeof value === 'string') return value.slice(0, limit);
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    try {
      return String(value).slice(0, limit);
    } catch {
      return '[unserializable]';
    }
  }
}

function sanitizeUpLangValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if ((value?.constructor && value.constructor !== Object)) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

const SG_ALIYUN_RUNTIME_ENDPOINTS = Object.freeze([
  'https://cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com',
  'https://ap-southeast-1.device.saf.aliyuncs.com',
]);

function cloneAliyunRuntimeEndpoints(_value) {
  return SG_ALIYUN_RUNTIME_ENDPOINTS.slice();
}

function applyAliyunSgRuntimeOverrides(target) {
  if (!target || typeof target !== 'object') return target;
  const endpoints = cloneAliyunRuntimeEndpoints(target.ENDPOINTS || target.endpoints);
  const looksLikeInitConfig = (
    Object.prototype.hasOwnProperty.call(target, 'SceneId') ||
    Object.prototype.hasOwnProperty.call(target, 'sceneId') ||
    Object.prototype.hasOwnProperty.call(target, 'element') ||
    Object.prototype.hasOwnProperty.call(target, 'button') ||
    Object.prototype.hasOwnProperty.call(target, 'getInstance') ||
    Object.prototype.hasOwnProperty.call(target, 'success') ||
    Object.prototype.hasOwnProperty.call(target, 'fail') ||
    Object.prototype.hasOwnProperty.call(target, 'onError')
  );
  target.region = looksLikeInitConfig ? 'sgp' : 'sg';
  target.prefix = typeof target.prefix === 'string' && target.prefix ? target.prefix : 'no8xfe';
  target.ENDPOINTS = endpoints.slice();
  target.endpoints = endpoints.slice();
  if (target.deviceConfig && typeof target.deviceConfig === 'object') {
    target.deviceConfig.region = 'sg';
    target.deviceConfig.ENDPOINTS = endpoints.slice();
    target.deviceConfig.endpoints = endpoints.slice();
  }
  if (target.deviceData && typeof target.deviceData === 'object') {
    target.deviceData.region = 'sg';
    if (typeof target.deviceData.dfghfgdh6 === 'string' && target.deviceData.dfghfgdh6) {
      target.deviceData.dfghfgdh6 = target.deviceData.dfghfgdh6
        .replaceAll('cloudauth-device-dualstack.cn-shanghai.aliyuncs.com', 'cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com')
        .replaceAll('cn-shanghai.device.saf.aliyuncs.com', 'ap-southeast-1.device.saf.aliyuncs.com')
        .replaceAll('cloudauth-device-pre.aliyuncs.com', 'cloudauth-device-pre.ap-southeast-1.aliyuncs.com')
        .replaceAll('pre-cn-shanghai.device.saf.aliyuncs.com', 'pre-ap-southeast-1.device.saf.aliyuncs.com');
    }
  }
  return target;
}

function pushInitAliyunCaptchaCall(window, entry) {
  window.__INIT_ALIYUN_CAPTCHA_CALLS__ = window.__INIT_ALIYUN_CAPTCHA_CALLS__ || [];
  window.__INIT_ALIYUN_CAPTCHA_CALLS__.push(entry);
  if (window.__INIT_ALIYUN_CAPTCHA_CALLS__.length > 60) {
    window.__INIT_ALIYUN_CAPTCHA_CALLS__ = window.__INIT_ALIYUN_CAPTCHA_CALLS__.slice(-60);
  }
}

function wrapInitAliyunCaptcha(window, candidate, options = {}) {
  if (typeof candidate !== 'function') return candidate;
  if (candidate.__ZTOAPI_INIT_HOOK_WRAPPED__) return candidate;
  function patchedInitAliyunCaptcha(initConfig, ...rest) {
    pushInitAliyunCaptchaCall(window, {
      stage: 'before',
      upLangType: initConfig?.upLang == null ? null : typeof initConfig.upLang,
      upLangValue: previewValue(initConfig?.upLang, 800),
      payload: snapshotObjectShape(initConfig, 40),
      windowUpLangType: window.UP_LANG == null ? null : typeof window.UP_LANG,
      windowUpLangValue: previewValue(window.UP_LANG, 800),
    });
    if (options.mutateInitConfig === true) {
      const sanitizedUpLang = sanitizeUpLangValue(initConfig?.upLang);
      if (initConfig && typeof initConfig === 'object') {
        if (sanitizedUpLang !== undefined) {
          initConfig.upLang = sanitizedUpLang;
        } else if ('upLang' in initConfig) {
          delete initConfig.upLang;
        }
      }
      applyAliyunSgRuntimeOverrides(initConfig);
      if (sanitizedUpLang !== undefined) {
        window.UP_LANG = sanitizedUpLang;
      } else if (window.UP_LANG != null && (typeof window.UP_LANG !== 'object' || Array.isArray(window.UP_LANG))) {
        try {
          delete window.UP_LANG;
        } catch {
          window.UP_LANG = undefined;
        }
      }
    }
    const result = candidate.call(window, initConfig, ...rest);
    pushInitAliyunCaptchaCall(window, {
      stage: 'after',
      upLangType: initConfig?.upLang == null ? null : typeof initConfig.upLang,
      upLangValue: previewValue(initConfig?.upLang, 800),
      payload: snapshotObjectShape(initConfig, 40),
      windowUpLangType: window.UP_LANG == null ? null : typeof window.UP_LANG,
      windowUpLangValue: previewValue(window.UP_LANG, 800),
    });
    return result;
  }
  Object.defineProperty(patchedInitAliyunCaptcha, '__ZTOAPI_INIT_HOOK_WRAPPED__', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return patchedInitAliyunCaptcha;
}

function previewFunctionSource(value, limit = 600) {
  if (typeof value !== 'function') return null;
  try {
    return String(value).slice(0, limit);
  } catch {
    return '[function source unavailable]';
  }
}

function decodeBase64Utf8(value, limit = 1200) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64').toString('utf8').slice(0, limit);
  } catch {
    return null;
  }
}

function decodeBase64Buffer(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

function ensureAliyunCaptchaScaffold(document) {
  if (!document?.body || typeof document.createElement !== 'function') return [];
  const created = [];
  const specs = [
    ['div', 'aliyuncaptcha-window-popup'],
    ['div', 'aliyuncaptcha-window-embed'],
    ['div', 'aliyuncaptcha-window-float'],
    ['div', 'aliyuncaptcha-captcha-wrapper'],
    ['div', 'aliyuncaptcha-float-wrapper'],
    ['img', 'aliyuncaptcha-mask'],
  ];
  for (const [tag, id] of specs) {
    if (typeof document.getElementById === 'function' && document.getElementById(id)) continue;
    const node = document.createElement(tag);
    node.id = id;
    if (tag === 'img') {
      node.hidden = true;
      node.alt = '';
    } else {
      node.style = node.style || {};
      node.style.display = 'none';
    }
    document.body.appendChild(node);
    created.push({ tag, id });
  }
  return created;
}

function hexPreview(buffer, limit = 64) {
  if (!Buffer.isBuffer(buffer)) return null;
  return buffer.toString('hex').slice(0, limit * 2);
}

function byteLikeHexPreview(value, limit = 96) {
  if (value == null) return null;
  try {
    if (Buffer.isBuffer(value)) return value.toString('hex').slice(0, limit * 2);
    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex').slice(0, limit * 2);
    }
    if (value instanceof ArrayBuffer) {
      return Buffer.from(value).toString('hex').slice(0, limit * 2);
    }
    if (Array.isArray(value)) {
      return Buffer.from(value).toString('hex').slice(0, limit * 2);
    }
    if (typeof value === 'string') {
      return Buffer.from(value, 'utf8').toString('hex').slice(0, limit * 2);
    }
  } catch {
    return null;
  }
  return null;
}

function wordArrayToHexPreview(value, limit = 64) {
  if (!value || typeof value !== 'object') return null;
  const words = Array.isArray(value.words) ? value.words : null;
  const sigBytes = Number.isFinite(value.sigBytes) ? value.sigBytes : null;
  if (!words || !sigBytes || sigBytes <= 0) return null;
  try {
    const out = [];
    for (let i = 0; i < sigBytes; i += 1) {
      const word = words[i >>> 2] | 0;
      const bite = (word >>> (24 - (i % 4) * 8)) & 0xff;
      out.push(bite.toString(16).padStart(2, '0'));
      if (out.length >= limit) break;
    }
    return out.join('');
  } catch {
    return null;
  }
}

function sharedPrefixLength(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right)) return 0;
  const size = Math.min(left.length, right.length);
  let idx = 0;
  while (idx < size && left[idx] === right[idx]) idx += 1;
  return idx;
}

function analyzeTokenPlain(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split('#');
  return {
    raw: value.slice(0, 400),
    partsLength: parts.length,
    prefix: parts[0] ?? null,
    second: parts[1] ?? null,
    third: parts[2] ?? null,
    fourth: parts[3] ?? null,
    fifth: parts[4] ?? null,
  };
}

function pickRecentBeOutput(logs, marker) {
  const entries = Array.isArray(logs) ? logs : [];
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    const item = entries[idx];
    if (typeof item?.calleeSource === 'string' && item.calleeSource.includes(marker)) {
      return previewValue(item.output, 400);
    }
  }
  return null;
}

function snapshotObjectShape(value, limit = 40) {
  if (!value || typeof value !== 'object') return null;
  let keys = [];
  try {
    keys = Reflect.ownKeys(value).map(String).slice(0, limit);
  } catch {
    keys = [];
  }
  const preview = {};
  for (const key of keys.slice(0, 20)) {
    try {
      const current = value[key];
      preview[key] = typeof current === 'function'
        ? { type: 'function', source: previewFunctionSource(current, 200) }
        : { type: typeof current, value: previewValue(current, 200) };
    } catch (err) {
      preview[key] = { error: String(err && err.stack || err) };
    }
  }
  return {
    keys,
    preview,
  };
}

function snapshotOrderedEntries(value, limit = 200) {
  if (!value || typeof value !== 'object') return [];
  let keys = [];
  try {
    keys = Reflect.ownKeys(value).map(String).slice(0, limit);
  } catch {
    keys = [];
  }
  return keys.map((key) => {
    let current;
    try {
      current = value[key];
    } catch (err) {
      return { key, error: String(err && err.stack || err) };
    }
    return {
      key,
      type: typeof current,
      value: previewValue(current, 300),
    };
  });
}

function sanitizeLogRows(rows, limit = 80, previewLimit = 400) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, limit).map((row) => previewValue(row, previewLimit));
}

function extractSourceSnippetAtOffset(filePath, offset, radius = 220) {
  if (typeof filePath !== 'string' || !filePath) return null;
  if (!Number.isFinite(offset) || offset < 0) return null;
  try {
    const source = fs.readFileSync(filePath, 'utf8');
    const start = Math.max(0, offset - radius);
    const end = Math.min(source.length, offset + radius);
    return {
      file: filePath,
      offset,
      start,
      end,
      snippet: source.slice(start, end),
    };
  } catch {
    return null;
  }
}

function extractStackSourceSnippets(stack, candidateFiles = [], radius = 220) {
  if (typeof stack !== 'string' || !stack) return [];
  const rows = String(stack).split('\n');
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const match = row.match(/\(([^)]+):(\d+):(\d+)\)$/) || row.match(/at\s+([^\s]+):(\d+):(\d+)$/);
    if (!match) continue;
    const rawFile = match[1];
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (!Number.isFinite(line) || !Number.isFinite(column) || line !== 1) continue;
    const filePath = candidateFiles.find((file) => String(file) === rawFile) || rawFile;
    const key = `${filePath}:${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = extractSourceSnippetAtOffset(filePath, column, radius);
    if (snippet) out.push(snippet);
    if (out.length >= 12) break;
  }
  return out;
}

function captureDeriveValueSnapshot(value) {
  return {
    preview: previewValue(value, 400),
    decodedUtf8: typeof value === 'string' ? decodeBase64Utf8(value, 400) : null,
    hexPreview: byteLikeHexPreview(value, 96),
    shape: snapshotObjectShape(value, 20),
  };
}

function wrapFeilinDeriveHelpers(window) {
  if (!window || window.__FEILIN_DERIVE_HELPERS_WRAPPED__) return;
  const logs = window.__FEILIN_DERIVE_HELPER_CALLS__ = window.__FEILIN_DERIVE_HELPER_CALLS__ || [];
  const pushLog = (entry) => {
    logs.push(entry);
    if (logs.length > 160) logs.shift();
  };
  const wrapNamedFunction = (name, fn) => {
    if (typeof fn !== 'function' || fn.__ztoapiProbeWrapped) return fn;
    function wrapped(...args) {
      try {
        const out = fn.apply(this, args);
        pushLog({
          helper: name,
          stage: 'return',
          argc: args.length,
          args: args.map((arg) => captureDeriveValueSnapshot(arg)),
          output: captureDeriveValueSnapshot(out),
          feilinRe: snapshotObjectShape(window.__FEILIN_RE__ || window.__FEILIN_EXPORT_RE__, 30),
          aliyunInitState: snapshotObjectShape(window.__ALIYUN_INIT_STATE__, 30),
          lastSessionDerive: snapshotObjectShape(window.__FEILIN_LAST_SESSION_DERIVE__, 20),
        });
        return out;
      } catch (error) {
        pushLog({
          helper: name,
          stage: 'throw',
          argc: args.length,
          args: args.map((arg) => captureDeriveValueSnapshot(arg)),
          error: String(error && error.message || error),
          feilinRe: snapshotObjectShape(window.__FEILIN_RE__ || window.__FEILIN_EXPORT_RE__, 30),
          aliyunInitState: snapshotObjectShape(window.__ALIYUN_INIT_STATE__, 30),
        });
        throw error;
      }
    }
    Object.defineProperty(wrapped, '__ztoapiProbeWrapped', {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    return wrapped;
  };

  if (typeof window.__FEILIN_DERIVE_SECRET_BLOB__ === 'function') {
    window.__FEILIN_DERIVE_SECRET_BLOB__ = wrapNamedFunction('derive-secret-blob', window.__FEILIN_DERIVE_SECRET_BLOB__);
  }
  if (typeof window.__FEILIN_DERIVE_SESSION_BLOB__ === 'function') {
    window.__FEILIN_DERIVE_SESSION_BLOB__ = wrapNamedFunction('derive-session-blob', window.__FEILIN_DERIVE_SESSION_BLOB__);
  }
  if (typeof window.__FEILIN_RS__ === 'function') {
    window.__FEILIN_RS__ = wrapNamedFunction('rs', window.__FEILIN_RS__);
  }
  if (typeof window.__FEILIN_RC__ === 'function') {
    window.__FEILIN_RC__ = wrapNamedFunction('rc', window.__FEILIN_RC__);
  }
  if (typeof window.__FEILIN_RG__ === 'function') {
    window.__FEILIN_RG__ = wrapNamedFunction('rg', window.__FEILIN_RG__);
  }
  window.__FEILIN_DERIVE_HELPERS_WRAPPED__ = true;
}

function summarizeCaptchaActionEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    url: entry.url || null,
    requestUrl: entry.requestUrl || entry.url || null,
    params: entry.params || null,
    requestHeaders: entry.requestHeaders || null,
    requestBodyPreview: typeof entry.body === 'string' ? entry.body.slice(0, 1200) : null,
    responseStatus: typeof entry.responseStatus === 'number' ? entry.responseStatus : null,
    responseHeaders: entry.responseHeaders || null,
    responseJson: entry.responseJson || null,
    responsePreview: typeof entry.response === 'string' ? entry.response.slice(0, 1200) : null,
  };
}

function isProbeCredentialValue(value) {
  if (typeof value !== 'string' || !value) return false;
  return value.includes('probe-security-token') || value.includes('probe-certify-id');
}

function sanitizeCredentialValue(value) {
  if (typeof value !== 'string' || !value || isProbeCredentialValue(value)) return null;
  return value;
}

function summarizeRequestHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const pick = (name) => {
    const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
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

function previewBase64Token(value, limit = 240) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64').toString('utf8').slice(0, limit);
  } catch {
    return value.slice(0, limit);
  }
}

function decodePossibleCaptchaPayload(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const base64Json = tryDecodeBase64Json(value);
    if (base64Json && typeof base64Json === 'object') {
      return base64Json;
    }
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? value : null;
}

function extractAliyunConfigRuntimeState(config) {
  if (!config || typeof config !== 'object') return null;
  const deviceConfig = config.deviceConfig && typeof config.deviceConfig === 'object'
    ? config.deviceConfig
    : null;
  const logInfo = config.logInfo && typeof config.logInfo === 'object'
    ? config.logInfo
    : null;
  return {
    sceneId: config.SceneId || config.sceneId || null,
    certifyId: sanitizeCredentialValue(
      config.CertifyId ||
      config.certifyId ||
      config.UserCertifyId ||
      logInfo?.cId ||
      null,
    ),
    securityToken: sanitizeCredentialValue(config.securityToken || null),
    verifyType: config.verifyType || null,
    language: config.language || null,
    mode: config.mode || null,
    deviceTokenPreview: previewBase64Token(config.DeviceToken),
    deviceConfigRawPreview: typeof config.DeviceConfig === 'string'
      ? config.DeviceConfig.slice(0, 240)
      : null,
    deviceConfig: deviceConfig
      ? {
        sessionId: deviceConfig.sessionId || null,
        timestamp: deviceConfig.timestamp || null,
        ip: deviceConfig.ip || null,
        key: deviceConfig.key || null,
        version: deviceConfig.version || null,
      }
      : null,
    logInfo: logInfo
      ? {
        cId: sanitizeCredentialValue(logInfo.cId || null),
        ip: logInfo.ip || null,
        t: logInfo.t || null,
      }
      : null,
  };
}

function extractAliyunRuntimeState(instanceRef, captchaRef, initState) {
  const instanceConfig = instanceRef?.config && typeof instanceRef.config === 'object'
    ? instanceRef.config
    : null;
  const captchaConfig =
    captchaRef?.config && typeof captchaRef.config === 'object'
      ? captchaRef.config
      : captchaRef?.AliyunCaptcha?.config && typeof captchaRef.AliyunCaptcha.config === 'object'
      ? captchaRef.AliyunCaptcha.config
      : null;
  const initConfig = initState && typeof initState === 'object' ? initState : null;
  return {
    initConfig: extractAliyunConfigRuntimeState(initConfig),
    instanceConfig: extractAliyunConfigRuntimeState(instanceConfig),
    captchaConfig: extractAliyunConfigRuntimeState(captchaConfig),
  };
}

function normalizeAliyunRuntimeState(instanceRef, captchaRef, initState) {
  applyAliyunSgRuntimeOverrides(initState);
  if (instanceRef?.config && typeof instanceRef.config === 'object') {
    applyAliyunSgRuntimeOverrides(instanceRef.config);
  }
  if (captchaRef?.config && typeof captchaRef.config === 'object') {
    applyAliyunSgRuntimeOverrides(captchaRef.config);
  }
  if (captchaRef?.AliyunCaptcha?.config && typeof captchaRef.AliyunCaptcha.config === 'object') {
    applyAliyunSgRuntimeOverrides(captchaRef.AliyunCaptcha.config);
  }
}

const ALIYUN_RUNTIME_TRACE_KEYS = new Set([
  'CertifyId',
  'certifyId',
  'UserCertifyId',
  'cId',
  'securityToken',
  'SecurityToken',
  'SceneId',
  'sceneId',
  'DeviceToken',
  'DeviceConfig',
  'logInfo',
  'config',
]);

function shouldTraceAliyunRuntimeKey(prop) {
  return ALIYUN_RUNTIME_TRACE_KEYS.has(String(prop));
}

function hasAliyunRuntimeTraceKeys(value) {
  if (!value || typeof value !== 'object') return false;
  try {
    return Reflect.ownKeys(value).some((key) => shouldTraceAliyunRuntimeKey(key));
  } catch {
    return false;
  }
}

function pushAliyunRuntimeCredentialLog(window, entry) {
  if (!window) return;
  window.__ALIYUN_RUNTIME_CREDENTIAL_LOGS__ = window.__ALIYUN_RUNTIME_CREDENTIAL_LOGS__ || [];
  window.__ALIYUN_RUNTIME_CREDENTIAL_LOGS__.push(entry);
  if (window.__ALIYUN_RUNTIME_CREDENTIAL_LOGS__.length > 240) {
    window.__ALIYUN_RUNTIME_CREDENTIAL_LOGS__.shift();
  }
}

function installAliyunRuntimeCredentialHooks(window, candidateSourceFiles = []) {
  if (!window || window.__ALIYUN_RUNTIME_CREDENTIAL_HOOKS_INSTALLED__) return;
  const proxyCache = new WeakMap();
  const proxiedSet = new WeakSet();
  const hiddenValues = new Map();

  const wrapValue = (value, rootPath) => {
    if (!value || typeof value !== 'object') return value;
    if (proxyCache.has(value)) return proxyCache.get(value);
    const proxy = new Proxy(value, {
      get(target, prop, receiver) {
        const current = Reflect.get(target, prop, receiver);
        if (current && typeof current === 'object') {
          return wrapValue(current, `${rootPath}.${String(prop)}`);
        }
        return current;
      },
      set(target, prop, nextValue, receiver) {
        const path = `${rootPath}.${String(prop)}`;
        const before = Reflect.get(target, prop, receiver);
        const result = Reflect.set(target, prop, nextValue, receiver);
        if (shouldTraceAliyunRuntimeKey(prop)) {
          pushAliyunRuntimeCredentialLog(window, {
            stage: 'proxy-set',
            path,
            prop: String(prop),
            before: previewValue(before, 400),
            after: previewValue(nextValue, 400),
            holderKeys: target && typeof target === 'object' ? Object.keys(target).slice(0, 24) : null,
            stack: String(new Error(`ALIYUN_RUNTIME_PROXY_SET:${path}`).stack || '').slice(0, 1200),
            stackSourceSnippets: extractStackSourceSnippets(
              String(new Error(`ALIYUN_RUNTIME_PROXY_SET:${path}`).stack || ''),
              candidateSourceFiles,
              260,
            ),
          });
        }
        return result;
      },
      defineProperty(target, prop, descriptor) {
        const result = Reflect.defineProperty(target, prop, descriptor);
        if (shouldTraceAliyunRuntimeKey(prop)) {
          pushAliyunRuntimeCredentialLog(window, {
            stage: 'proxy-defineProperty',
            path: `${rootPath}.${String(prop)}`,
            prop: String(prop),
            descriptor: snapshotObjectShape(descriptor, 12),
            stack: String(new Error(`ALIYUN_RUNTIME_DEFINE:${rootPath}.${String(prop)}`).stack || '').slice(0, 1200),
            stackSourceSnippets: extractStackSourceSnippets(
              String(new Error(`ALIYUN_RUNTIME_DEFINE:${rootPath}.${String(prop)}`).stack || ''),
              candidateSourceFiles,
              260,
            ),
          });
        }
        return result;
      },
    });
    Object.defineProperty(proxy, '__ztoapiAliyunRuntimeProxyPath__', {
      value: rootPath,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    proxyCache.set(value, proxy);
    proxiedSet.add(proxy);
    return proxy;
  };

  const installRoot = (prop) => {
    hiddenValues.set(prop, undefined);
    Object.defineProperty(window, prop, {
      configurable: true,
      enumerable: true,
      get() {
        return hiddenValues.get(prop);
      },
      set(nextValue) {
        const wrapped = wrapValue(nextValue, `window.${prop}`);
        hiddenValues.set(prop, wrapped);
        pushAliyunRuntimeCredentialLog(window, {
          stage: 'window-root-set',
          path: `window.${prop}`,
          valueShape: snapshotObjectShape(nextValue, 24),
          keys: nextValue && typeof nextValue === 'object' ? Reflect.ownKeys(nextValue).map(String).slice(0, 30) : [],
          stack: String(new Error(`ALIYUN_RUNTIME_ROOT_SET:${prop}`).stack || '').slice(0, 1200),
          stackSourceSnippets: extractStackSourceSnippets(
            String(new Error(`ALIYUN_RUNTIME_ROOT_SET:${prop}`).stack || ''),
            candidateSourceFiles,
            260,
          ),
        });
      },
    });
  };

  installRoot('__ALIYUN_INIT_STATE__');
  installRoot('__ALIYUN_LAST_INSTANCE__');
  installRoot('__ALIYUN_LAST_CAPTCHA_INSTANCE__');

  window.__ALIYUN_RUNTIME_CREDENTIAL_PROXY_WRAP__ = wrapValue;
  window.__ALIYUN_RUNTIME_CREDENTIAL_PROXY_SET__ = proxiedSet;
  window.__ALIYUN_RUNTIME_CREDENTIAL_HOOKS_INSTALLED__ = true;
}

function buildAutoInitRuntimeEvent(type, args, thisArg) {
  const payloads = Array.isArray(args)
    ? args.map((arg) => decodePossibleCaptchaPayload(arg)).filter((item) => item && typeof item === 'object')
    : [];
  const config = thisArg?.config && typeof thisArg.config === 'object' ? thisArg.config : thisArg;
  return {
    type,
    args: Array.isArray(args) ? args.map((x) => previewValue(x, 4000)) : [],
    payloads: payloads.length ? payloads : null,
    runtime: extractAliyunConfigRuntimeState(config),
  };
}

function buildLiveCheckChainState(windowRef, xhrLog, extra = {}) {
  const entries = Array.isArray(xhrLog) ? xhrLog : [];
  const initEntry = entries.find((item) => /^Init/.test(String(item?.params?.Action || ''))) || null;
  const verifyEntry = entries.find((item) => /^VerifyCaptcha/.test(String(item?.params?.Action || ''))) || null;
  const autoInitEvents = Array.isArray(extra.autoInitEvents) ? extra.autoInitEvents : [];
  const callbackEvent = autoInitEvents
    .find((item) => item?.type === 'captchaVerifyCallback') || null;
  const successEvent = autoInitEvents
    .find((item) => item?.type === 'success') || null;
  const failEvent = autoInitEvents
    .find((item) => item?.type === 'fail') || null;
  const instanceRef = windowRef?.__ALIYUN_LAST_INSTANCE__ || null;
  const captchaRef =
    instanceRef?.captcha?.AliyunCaptcha ||
    instanceRef?.captcha ||
    windowRef?.__ALIYUN_LAST_CAPTCHA_INSTANCE__ ||
    null;
  const initState = windowRef?.__ALIYUN_INIT_STATE__ || null;
  normalizeAliyunRuntimeState(instanceRef, captchaRef, initState);
  const runtimeState = extractAliyunRuntimeState(instanceRef, captchaRef, initState);
  const runtimeCandidates = [
    callbackEvent?.payload,
    successEvent?.decoded,
    failEvent?.payload,
    ...(Array.isArray(callbackEvent?.payloads) ? callbackEvent.payloads : []),
    ...(Array.isArray(successEvent?.payloads) ? successEvent.payloads : []),
    ...(Array.isArray(failEvent?.payloads) ? failEvent.payloads : []),
  ].filter((item) => item && typeof item === 'object');
  const hasRealVerifyRequest = !!verifyEntry;
  const successPayloadIsLocalFallback = !!(
    successEvent?.decoded &&
    typeof successEvent.decoded === 'object' &&
    successEvent.decoded.isSign === true &&
    !sanitizeCredentialValue(successEvent.decoded.securityToken) &&
    !hasRealVerifyRequest
  );
  const runtimeCredentialCandidates = successPayloadIsLocalFallback
    ? runtimeCandidates.filter((item) => item !== successEvent?.decoded)
    : runtimeCandidates;
  const certifyId =
    sanitizeCredentialValue(verifyEntry?.responseJson?.Result?.certifyId) ||
    sanitizeCredentialValue(verifyEntry?.params?.CertifyId) ||
    sanitizeCredentialValue(initEntry?.responseJson?.CertifyId) ||
    runtimeCredentialCandidates.map((item) => sanitizeCredentialValue(item.certifyId)).find(Boolean) ||
    runtimeState?.instanceConfig?.certifyId ||
    runtimeState?.captchaConfig?.certifyId ||
    runtimeState?.initConfig?.certifyId ||
    null;
  const securityToken =
    sanitizeCredentialValue(verifyEntry?.responseJson?.Result?.securityToken) ||
    runtimeCredentialCandidates.map((item) => sanitizeCredentialValue(item.securityToken)).find(Boolean) ||
    runtimeState?.instanceConfig?.securityToken ||
    runtimeState?.captchaConfig?.securityToken ||
    runtimeState?.initConfig?.securityToken ||
    null;
  const verifyParam =
    verifyEntry?.params?.CaptchaVerifyParam ||
    (!successPayloadIsLocalFallback ? successEvent?.payload : null) ||
    null;
  let verifyParamDecoded = null;
  if (typeof verifyParam === 'string' && verifyParam) {
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
    certifyId,
    securityToken,
    verifyParam,
    verifyParamDecoded,
    initRequest: summarizeCaptchaActionEntry(initEntry),
    verifyRequest: summarizeCaptchaActionEntry(verifyEntry),
    initRequestHeaders: summarizeRequestHeaders(initEntry?.requestHeaders),
    verifyRequestHeaders: summarizeRequestHeaders(verifyEntry?.requestHeaders),
    callbackPayload: callbackEvent?.payload || null,
    successPayload: successEvent?.payload || null,
    successPayloadDecoded: successEvent?.decoded || null,
    successPayloadIsLocalFallback,
    failPayload: failEvent?.payload || null,
    autoInitEvents: autoInitEvents
      .filter((item) => {
        const type = String(item?.type || '');
        return type.startsWith('proto.') ||
          type === 'instance.runtime' ||
          type === 'trigger' ||
          type === 'captchaVerifyCallback' ||
          type === 'success' ||
          type === 'fail';
      }),
    instanceState: {
      initState: snapshotObjectShape(initState),
      instance: snapshotObjectShape(instanceRef),
      instanceConfig: snapshotObjectShape(instanceRef?.config),
      captcha: snapshotObjectShape(captchaRef),
      captchaConfig: snapshotObjectShape(captchaRef?.config),
      runtimeState,
    },
  };
}

function safePreviewString(value, limit = 1200) {
  if (typeof value !== 'string') return value == null ? value : String(value).slice(0, limit);
  return value.slice(0, limit);
}

function safeCall(value, fn) {
  try {
    return fn(value);
  } catch {
    return null;
  }
}

function safeDecodeHexBuffer(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  try {
    return Buffer.from(value, 'hex');
  } catch {
    return null;
  }
}

function setPathValue(target, pathParts, value) {
  if (!target || typeof target !== 'object' || !Array.isArray(pathParts) || pathParts.length === 0) return false;
  let cursor = target;
  for (let i = 0; i < pathParts.length - 1; i += 1) {
    const key = String(pathParts[i]);
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[String(pathParts[pathParts.length - 1])] = value;
  return true;
}

function applyLiveDeviceConfigProbe(windowRef, probeConfig = {}) {
  const liveCfg = probeConfig?.deviceConfig && typeof probeConfig.deviceConfig === 'object'
    ? probeConfig.deviceConfig
    : null;
  const liveCfgRaw = typeof probeConfig?.deviceConfigRaw === 'string' ? probeConfig.deviceConfigRaw : null;
  const certifyId = typeof probeConfig?.certifyId === 'string' ? probeConfig.certifyId : null;
  const deviceToken = typeof probeConfig?.deviceToken === 'string' ? probeConfig.deviceToken : null;
  const sessionId = liveCfg?.sessionId || null;
  const timestamp = liveCfg?.timestamp || null;
  const ip = liveCfg?.ip || null;

  const applyToDeviceData = (deviceData) => {
    if (!deviceData || typeof deviceData !== 'object') return;
    if (certifyId) deviceData.xcvbrt454 = certifyId;
    if (ip) deviceData.fghjfghe = ip;
    if (timestamp) deviceData.h9w87s9 = String(timestamp);
  };

  const applyToContainer = (container) => {
    if (!container || typeof container !== 'object') return;
    if (certifyId) {
      container.CertifyId = certifyId;
      container.certifyId = certifyId;
      container.UserCertifyId = certifyId;
    }
    if (deviceToken) {
      container.DeviceToken = deviceToken;
      container.deviceToken = deviceToken;
    }
    if (liveCfgRaw) container.DeviceConfig = liveCfgRaw;
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
    applyToDeviceData(container.deviceData);
  };

  applyToContainer(windowRef?.__FEILIN_RE__ || windowRef?.__FEILIN_EXPORT_RE__);
  applyToContainer(windowRef?.__ALIYUN_INIT_STATE__);
  applyToContainer(windowRef?.__ALIYUN_LAST_INSTANCE__?.config);
  applyToContainer(windowRef?.__ALIYUN_LAST_CAPTCHA_INSTANCE__?.config);

  const logInfo = windowRef?.__ALIYUN_LAST_INSTANCE__?.config?.logInfo;
  if (logInfo && typeof logInfo === 'object') {
    if (certifyId) logInfo.cId = certifyId;
    if (ip) logInfo.ip = ip;
  }
}

function captureRsOutputDetails(value) {
  const tag = value && typeof value === 'object' ? Object.prototype.toString.call(value) : null;
  const ctor = value && typeof value === 'object' && value.constructor ? String(value.constructor.name || '') : null;
  const outputKeys = value && typeof value === 'object' ? safeCall(value, (x) => Object.keys(x).slice(0, 20)) : null;
  const bufferCandidate = safeCall(value, (x) => {
    if (!x || typeof x !== 'object') return null;
    if (Buffer.isBuffer(x.buffer)) return x.buffer;
    if (ArrayBuffer.isView(x.buffer)) return Buffer.from(x.buffer.buffer, x.buffer.byteOffset, x.buffer.byteLength);
    if (x.buffer instanceof ArrayBuffer) return Buffer.from(x.buffer);
    return null;
  });
  const ciphertextCandidate = safeCall(value, (x) => normalizeWordArray(x && typeof x === 'object' ? x.ciphertext : null));
  const wordArrayCandidate = safeCall(value, (x) => normalizeWordArray(x));
  const defaultToString = safeCall(value, (x) => typeof x === 'string' ? x : x && typeof x.toString === 'function' ? x.toString() : null);
  const base64ToString = safeCall(value, (x) => x && typeof x.toString === 'function' ? x.toString(cryptShim.enc.Base64) : null);
  const hexToString = safeCall(value, (x) => x && typeof x.toString === 'function' ? x.toString(cryptShim.enc.Hex) : null);
  const utf8ToString = safeCall(value, (x) => x && typeof x.toString === 'function' ? x.toString(cryptShim.enc.Utf8) : null);
  const defaultToStringDecoded = typeof defaultToString === 'string' ? decodeBase64Buffer(defaultToString) : null;
  const base64ToStringDecoded = typeof base64ToString === 'string' ? decodeBase64Buffer(base64ToString) : null;
  const hexToStringDecoded = typeof hexToString === 'string' ? safeDecodeHexBuffer(hexToString) : null;
  return {
    outputTag: tag,
    outputCtor: ctor,
    outputKeys,
    outputBufferBytes: Buffer.isBuffer(bufferCandidate) ? bufferCandidate.length : null,
    outputBufferHexPreview: Buffer.isBuffer(bufferCandidate) ? bufferCandidate.toString('hex').slice(0, 1200) : null,
    outputBufferBase64: Buffer.isBuffer(bufferCandidate) ? bufferCandidate.toString('base64') : null,
    outputCiphertextBytes: Buffer.isBuffer(ciphertextCandidate) ? ciphertextCandidate.length : null,
    outputCiphertextHexPreview: Buffer.isBuffer(ciphertextCandidate) ? ciphertextCandidate.toString('hex').slice(0, 1200) : null,
    outputCiphertextBase64: Buffer.isBuffer(ciphertextCandidate) ? ciphertextCandidate.toString('base64') : null,
    outputWordArrayBytes: Buffer.isBuffer(wordArrayCandidate) ? wordArrayCandidate.length : null,
    outputWordArrayHexPreview: Buffer.isBuffer(wordArrayCandidate) ? wordArrayCandidate.toString('hex').slice(0, 1200) : null,
    outputWordArrayBase64: Buffer.isBuffer(wordArrayCandidate) ? wordArrayCandidate.toString('base64') : null,
    outputSigBytes: value && typeof value === 'object' && Number.isFinite(value.sigBytes) ? value.sigBytes : null,
    outputWordsLength: value && typeof value === 'object' && Array.isArray(value.words) ? value.words.length : null,
    outputJsonPreview: value && typeof value === 'object' ? safeCall(value, (x) => JSON.stringify(x).slice(0, 1200)) : null,
    outputDefaultString: typeof defaultToString === 'string' ? safePreviewString(defaultToString) : null,
    outputDefaultStringLength: typeof defaultToString === 'string' ? defaultToString.length : null,
    outputDefaultDecodedBytes: Buffer.isBuffer(defaultToStringDecoded) ? defaultToStringDecoded.length : null,
    outputBase64String: typeof base64ToString === 'string' ? safePreviewString(base64ToString) : null,
    outputBase64StringLength: typeof base64ToString === 'string' ? base64ToString.length : null,
    outputBase64DecodedBytes: Buffer.isBuffer(base64ToStringDecoded) ? base64ToStringDecoded.length : null,
    outputHexString: typeof hexToString === 'string' ? safePreviewString(hexToString) : null,
    outputHexStringLength: typeof hexToString === 'string' ? hexToString.length : null,
    outputHexDecodedBytes: Buffer.isBuffer(hexToStringDecoded) ? hexToStringDecoded.length : null,
    outputUtf8String: typeof utf8ToString === 'string' ? safePreviewString(utf8ToString) : null,
    outputUtf8StringLength: typeof utf8ToString === 'string' ? utf8ToString.length : null,
  };
}

function simpleStringHash(value) {
  const text = String(value || '');
  let acc = 0;
  for (let i = 0; i < text.length; i += 1) {
    acc = (acc * 33 + text.charCodeAt(i)) >>> 0;
  }
  return acc >>> 0;
}

function pushWindowLog(windowOrKey, keyOrValue, valueOrLimit, maybeLimit = 120) {
  try {
    const useGlobalWindow = typeof windowOrKey === 'string';
    const window = useGlobalWindow ? globalWindowRef : windowOrKey;
    const key = useGlobalWindow ? windowOrKey : keyOrValue;
    const value = useGlobalWindow ? keyOrValue : valueOrLimit;
    const limit = useGlobalWindow ? (typeof valueOrLimit === 'number' ? valueOrLimit : 120) : maybeLimit;
    if (!window || !key) return;
    window[key] = window[key] || [];
    window[key].push(value);
    if (window[key].length > limit) window[key].shift();
  } catch {
    // ignore
  }
}

function installWindowObjectTracer(window, recorder, name) {
  const state = {
    name,
    assignCount: 0,
    lastAssignedRaw: undefined,
    lastAssignedProxy: undefined,
    events: [],
  };

  const push = (type, detail = {}) => {
    const entry = { type, detail: previewValue(detail, 400), ts: Date.now() };
    state.events.push(entry);
    if (state.events.length > 120) state.events.shift();
    recorder.push(`window-object-${type}`, `window.${name}`, entry.detail);
  };

  const wrapObject = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.__trace_proxy_wrapped__) return obj;
    const proxy = new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'getToken' && typeof value === 'function') {
          return function tracedGetToken(...args) {
            push('getToken.call', { argc: args.length, args: args.map((arg) => previewValue(arg, 200)) });
            try {
              const out = value.apply(this === proxy ? target : this, args);
              if (out && typeof out.then === 'function') {
                return Promise.resolve(out).then((resolved) => {
                  push('getToken.return', {
                    type: typeof resolved,
                    preview: previewValue(resolved, 400),
                    decoded: decodeBase64Utf8(resolved, 400),
                  });
                  return resolved;
                });
              }
              push('getToken.return', {
                type: typeof out,
                preview: previewValue(out, 400),
                decoded: decodeBase64Utf8(out, 400),
              });
              return out;
            } catch (err) {
              push('getToken.throw', { error: String(err && err.stack || err) });
              throw err;
            }
          };
        }
        return value;
      },
      set(target, prop, value, receiver) {
        push('set', {
          prop: String(prop),
          valueType: typeof value,
          valuePreview: typeof value === 'function' ? previewFunctionSource(value, 200) : previewValue(value, 200),
          stack: String((new Error(`window.${name}.set.${String(prop)}`)).stack || '').slice(0, 1200),
        });
        return Reflect.set(target, prop, value, receiver);
      },
      defineProperty(target, prop, descriptor) {
        push('defineProperty', {
          prop: String(prop),
          hasValue: Object.prototype.hasOwnProperty.call(descriptor || {}, 'value'),
          valueType: typeof descriptor?.value,
          valuePreview: typeof descriptor?.value === 'function'
            ? previewFunctionSource(descriptor.value, 200)
            : previewValue(descriptor?.value, 200),
          stack: String((new Error(`window.${name}.defineProperty.${String(prop)}`)).stack || '').slice(0, 1200),
        });
        return Reflect.defineProperty(target, prop, descriptor);
      },
      deleteProperty(target, prop) {
        push('delete', { prop: String(prop) });
        return Reflect.deleteProperty(target, prop);
      },
    });
    Object.defineProperty(proxy, '__trace_proxy_wrapped__', {
      value: true,
      enumerable: false,
      configurable: true,
    });
    return proxy;
  };

  Object.defineProperty(window, name, {
    configurable: true,
    enumerable: true,
    get() {
      return state.lastAssignedProxy;
    },
    set(value) {
      state.assignCount += 1;
      state.lastAssignedRaw = value;
      state.lastAssignedProxy = wrapObject(value);
      push('assign', {
        assignCount: state.assignCount,
        valueType: typeof value,
        keys: value && typeof value === 'object' ? Reflect.ownKeys(value).map(String).slice(0, 20) : [],
      });
    },
  });

  return {
    state,
    snapshot() {
      return {
        assignCount: state.assignCount,
        shape: snapshotObjectShape(state.lastAssignedRaw),
        events: state.events.slice(),
      };
    },
  };
}

function createLenientObject(base = {}, label = 'lenient') {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === 'toString') return () => `[${label}]`;
      if (prop === 'valueOf') return () => 0;
      return function noop() {};
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    has() {
      return true;
    },
  });
}

function makeComputedStyleFor(element) {
  const style = element?.style || {};
  const fontSize = style.fontSize || '16px';
  const lineHeight = style.lineHeight || 'normal';
  const fontFamily = style.fontFamily || 'Arial';
  const display = style.display || 'block';
  const visibility = style.visibility || 'visible';
  const position = style.position || 'static';
  const color = style.color || 'rgb(0, 0, 0)';
  const width = style.width || `${element?.offsetWidth || 0}px`;
  const height = style.height || `${element?.offsetHeight || 0}px`;
  const payload = {
    ...style,
    fontSize,
    lineHeight,
    fontFamily,
    display,
    visibility,
    position,
    color,
    width,
    height,
    getPropertyValue(name) {
      return this[name] ?? style[name] ?? '';
    },
    setProperty(name, value) {
      this[name] = String(value);
      style[name] = String(value);
    },
    removeProperty(name) {
      delete this[name];
      delete style[name];
    },
  };
  return createLenientObject(payload, 'computed-style');
}

function encodeFinalCaptchaVerifyParam({ certifyId, sceneId, securityToken }) {
  const payload = JSON.stringify({
    certifyId,
    sceneId,
    isSign: true,
    securityToken,
  });
  return Buffer.from(payload, 'utf8').toString('base64');
}

function patchAliyunCaptchaSource(source, options = {}) {
  if (typeof source !== 'string' || !source) return source;
  let patched = source;
  const applyLiteralSnippetPatches = (text, snippetPatches) => {
    if (!Array.isArray(snippetPatches) || snippetPatches.length === 0) return text;
    let current = text;
    for (const patch of snippetPatches) {
      const match = typeof patch?.match === 'string' ? patch.match : null;
      const replace = typeof patch?.replace === 'string' ? patch.replace : null;
      const sentinel = typeof patch?.sentinel === 'string' ? patch.sentinel : replace;
      if (!match || replace == null) continue;
      if (sentinel && current.includes(sentinel)) continue;
      const idx = current.indexOf(match);
      if (idx < 0) continue;
      current = current.slice(0, idx) + replace + current.slice(idx + match.length);
    }
    return current;
  };
  const applyOffsetSnippetPatches = (text, offsetPatches) => {
    if (!Array.isArray(offsetPatches) || offsetPatches.length === 0) return text;
    let current = text;
    for (const patch of offsetPatches) {
      const match = typeof patch?.match === 'string' ? patch.match : null;
      const replace = typeof patch?.replace === 'string' ? patch.replace : null;
      const sentinel = typeof patch?.sentinel === 'string' ? patch.sentinel : replace;
      const offset = Number(patch?.offset);
      const radius = Number.isFinite(patch?.radius) ? Math.max(0, patch.radius) : 320;
      if (!match || replace == null || !Number.isFinite(offset)) continue;
      if (sentinel && current.includes(sentinel)) continue;
      const directIdx = current.indexOf(match);
      if (directIdx >= 0) {
        current = current.slice(0, directIdx) + replace + current.slice(directIdx + match.length);
        continue;
      }
      const start = Math.max(0, offset - radius);
      const end = Math.min(current.length, offset + radius);
      const segment = current.slice(start, end);
      const localIdx = segment.indexOf(match);
      if (localIdx < 0) continue;
      const absoluteIdx = start + localIdx;
      current = current.slice(0, absoluteIdx) + replace + current.slice(absoluteIdx + match.length);
    }
    return current;
  };
  const appendWrapperBefore = (text, startMarker, endMarker, injected) => {
    const start = text.indexOf(startMarker);
    if (start < 0) return text;
    const end = text.indexOf(endMarker, start);
    if (end < 0) return text;
    const segment = text.slice(start, end);
    if (segment.includes(injected.slice(0, 48))) return text;
    return text.slice(0, end) + injected + text.slice(end);
  };
  const appendWrapperBeforeAny = (text, startMarker, endMarkers, injected) => {
    let current = text;
    for (const marker of Array.isArray(endMarkers) ? endMarkers : []) {
      const next = appendWrapperBefore(current, startMarker, marker, injected);
      if (next !== current) return next;
    }
    return current;
  };
  const wrapNamedFunctionDeclaration = (text, functionName, injectedFactory) => {
    const marker = `function ${functionName}(`;
    const idx = text.indexOf(marker);
    if (idx < 0) return text;
    const bodyStart = text.indexOf('{', idx);
    if (bodyStart < 0) return text;
    const sentinel = `__ZTO_${functionName.toUpperCase()}_WRAP_HIT__`;
    const bodyEndSearchStart = bodyStart + 1;
    const nextMarkers = ['function ', 'var ', 'const ', 'let '];
    let bodyEnd = -1;
    for (const next of nextMarkers) {
      const probe = text.indexOf(next, bodyEndSearchStart);
      if (probe !== -1 && (bodyEnd === -1 || probe < bodyEnd)) bodyEnd = probe;
    }
    if (bodyEnd === -1) bodyEnd = text.length;
    const segment = text.slice(idx, bodyEnd);
    if (segment.includes(sentinel)) return text;
    const injected = injectedFactory(sentinel);
    return text.slice(0, bodyStart + 1) + injected + text.slice(bodyStart + 1);
  };
  if (options.exposeReverseHelpers) {
    patched = patched.replace(
      'e(514);function Cn',
      'window.__ALIYUN_REVERSE__={ye:ye,me:me,xe:xe,we:we,be:be,Ce:Ce,encodeDeviceConfigParts:function(parts){return ye(de,(parts||[]).join("#"))},decodeDeviceConfigRaw:function(value){return me(de,value)},encodeLog1DataParts:function(parts){return be(parts||[])},signCaptchaParams:function(params){var payload=Object.assign({},params||{});delete payload.Signature;return Ce(payload,Ee.KEY_SECRET)}};e(514);function Cn',
    );
  }
  patched = patched.replace(
    'window.FEILIN&&window.FEILIN.initFeiLin(Ie,e)',
    'window.__ALIYUN_INIT_STATE__=Ie;window.FEILIN&&window.FEILIN.initFeiLin(Ie,e)',
  );
  patched = patched.replace(
    'nr._extend({preCollectData:e});',
    'window.__ALIYUN_PRECOLLECT_SNAPSHOT__=e;nr._extend({preCollectData:e});',
  );
  patched = patched.replace(
    'function K(t){var n=tC(t);return function(t){for(var n,e,r=0,i=t.length,a="";r<i;)n=t.subarray(r,Math.min(r+32768,i)),a+=null==(e=window.String.fromCharCode)?void 0:e.apply(null,n),r+=32768;return window.btoa(a)}((0,D.deflate)(n))}',
    'function K(t){window.__PE_K_LOGS__=window.__PE_K_LOGS__||[];window.__PE_K_LOGS__.push({inputType:typeof t,inputLen:t&&typeof t.length==="number"?t.length:null,inputPreview:typeof t==="string"?t.slice(0,800):null,stack:String((new Error("PE_K")).stack||"").slice(0,1200)});var n=tC(t),e=(window.__PE_DEFLATE_LOGS__=window.__PE_DEFLATE_LOGS__||[],window.__PE_DEFLATE_LOGS__.push({inputType:typeof t,inputLen:t&&typeof t.length==="number"?t.length:null,inputPreview:typeof t==="string"?t.slice(0,800):null}),(0,D.deflate)(n)),r=function(t){for(var n,e,r=0,i=t.length,a="";r<i;)n=t.subarray(r,Math.min(r+32768,i)),a+=null==(e=window.String.fromCharCode)?void 0:e.apply(null,n),r+=32768;return window.btoa(a)}(e);try{window.__PE_K_OUTPUT_LOGS__=window.__PE_K_OUTPUT_LOGS__||[],window.__PE_K_OUTPUT_LOGS__.push({inputLen:t&&typeof t.length==="number"?t.length:null,inputPreview:typeof t==="string"?t.slice(0,800):null,inputPrefix:typeof t==="string"?t.slice(0,32):null,transformedType:typeof n,transformedTag:Object.prototype.toString.call(n),transformedLen:n&&typeof n.length==="number"?n.length:null,transformedByteSample:n&&typeof n.length==="number"?Array.prototype.slice.call(n,0,48):null,transformedHexPreview:typeof byteLikeHexPreview==="function"?byteLikeHexPreview(n,128):null,deflatedLen:e&&typeof e.length==="number"?e.length:null,deflatedTag:Object.prototype.toString.call(e),deflatedByteSample:e&&typeof e.length==="number"?Array.prototype.slice.call(e,0,48):null,deflatedHexPreview:typeof byteLikeHexPreview==="function"?byteLikeHexPreview(e,128):null,outputPreview:typeof r==="string"?r.slice(0,400):r,stack:String((new Error("PE_K_TRANSFORM")).stack||"").slice(0,1200)});if(window.__PE_K_OUTPUT_LOGS__.length>40)window.__PE_K_OUTPUT_LOGS__.shift()}catch(_e){}return r}',
  );
  patched = patched.replace(
    'function ra(t,r,e){var n,i,a,o,c,s,f,l,h,d,p,v,b,w,g,m,y,k,M,O,U,N,S,x,I,A,T,R,B,F,C,q,E,Y,J,H,P,j,z,L,Q,Z,K,V,D,G,X,_,W,$,tt,tr,te,tn,ti,ta,to,tu,tc,ts,tf,tl,th,td,tp,tv,tb,tw,tg,tm,ty,tk,tM,tO,tU,tN,tS,tx,tI,tA,tT,tR;for(i=80;i;)switch(a=i>>6,o=i>>3&7,c=7&i,a){',
    'function ra(t,r,e){var n,i,a,o,c,s,f,l,h,d,p,v,b,w,g,m,y,k,M,O,U,N,S,x,I,A,T,R,B,F,C,q,E,Y,J,H,P,j,z,L,Q,Z,K,V,D,G,X,_,W,$,tt,tr,te,tn,ti,ta,to,tu,tc,ts,tf,tl,th,td,tp,tv,tb,tw,tg,tm,ty,tk,tM,tO,tU,tN,tS,tx,tI,tA,tT,tR;var __raTraceEnabled=t===20&&window&&Array.isArray(window.__RA_TRACE_TARGETS__)&&window.__RA_TRACE_TARGETS__.length>0&&window.__RA_TRACE_TARGETS__.some(function(target){return typeof target==="string"&&target&&(typeof r==="string"&&(r===target||r.indexOf(target)>=0||target.indexOf(r)>=0)||typeof e==="string"&&(e===target||e.indexOf(target)>=0||target.indexOf(e)>=0))});var __raTraceStep=0;function __raPush(stage,extra){try{window.__FEILIN_RA20_LOGS__=window.__FEILIN_RA20_LOGS__||[];window.__FEILIN_RA20_LOGS__.push(Object.assign({stage:stage,step:__raTraceStep,opcode:t,arg0:typeof r==="string"?r.slice(0,220):r,arg1Length:typeof e==="string"?e.length:null,arg1Head:typeof e==="string"?e.slice(0,260):e,i:i,nType:typeof n,nPreview:typeof n==="string"?n.slice(0,220):n,sType:typeof s,sPreview:typeof s==="string"?s.slice(0,220):s,fType:typeof f,fPreview:typeof f==="string"?f.slice(0,220):f,lType:typeof l,lPreview:typeof l==="string"?l.slice(0,220):l,MType:typeof M,MPreview:typeof M==="string"?M.slice(0,220):M,O:typeof O==="number"?O:null,ta:typeof ta==="number"?ta:null},extra||{}));window.__FEILIN_RA20_LOGS__.length>2400&&window.__FEILIN_RA20_LOGS__.shift()}catch(_e){}}for(i=80;i;){__raTraceEnabled&&__raTraceStep<240&&(__raTraceStep+=1,__raPush("loop",{i:i}));switch(a=i>>6,o=i>>3&7,c=7&i,a){',
  );
  patched = patched.replace(
    'return n}var ro=({0:ri})[0](25,40)+ri(~ri?45:5,~ri?94:6),ru=window[ro],rc=ru[ri(',
    '}return __raTraceEnabled&&__raPush("return",{returnType:typeof n,returnPreview:typeof n==="string"?n.slice(0,260):n}),n}var ro=({0:ri})[0](25,40)+ri(~ri?45:5,~ri?94:6),ru=window[ro],rc=ru[ri(',
  );
  patched = patched.replace(
    'concat:function(t){var r=this.words,e=t.words,n=this.sigBytes,i=t.sigBytes;if(this.clamp(),n%4)for(var o=0;o<i;o++){var c=e[o>>>2]>>>24-o%4*8&255;r[n+o>>>2]|=c<<24-(n+o)%4*8}else for(o=0;o<i;o+=4)r[n+o>>>2]=e[o>>>2];return this.sigBytes+=i,this}',
    'concat:function(t){var r=this.words,e=t.words,n=this.sigBytes,i=t.sigBytes;try{if(window&&Array.isArray(window.__CRYPTO_TRACE_TARGETS__)&&window.__CRYPTO_TRACE_TARGETS__.length>0){window.__CRYPTO_TRACE_LOGS__=window.__CRYPTO_TRACE_LOGS__||[];window.__CRYPTO_TRACE_LOGS__.push({stage:"bundle.wordarray.concat",selfSigBytes:n,argSigBytes:i,selfHexPreview:typeof window.wordArrayToHexPreview==="function"?window.wordArrayToHexPreview(this,160):null,argHexPreview:typeof window.wordArrayToHexPreview==="function"?window.wordArrayToHexPreview(t,160):null,stack:String((new Error("BUNDLE_WORDARRAY_CONCAT")).stack||"").slice(0,1200)});window.__CRYPTO_TRACE_LOGS__.length>1200&&window.__CRYPTO_TRACE_LOGS__.shift()}}catch(_e){}if(this.clamp(),n%4)for(var o=0;o<i;o++){var c=e[o>>>2]>>>24-o%4*8&255;r[n+o>>>2]|=c<<24-(n+o)%4*8}else for(o=0;o<i;o+=4)r[n+o>>>2]=e[o>>>2];return this.sigBytes+=i,this}',
  );
  patched = patched.replace(
    'clamp:function(){var r=this.words,e=this.sigBytes;r[e>>>2]&=4294967295<<32-e%4*8,r.length=t.ceil(e/4)}',
    'clamp:function(){var r=this.words,e=this.sigBytes;try{if(window&&Array.isArray(window.__CRYPTO_TRACE_TARGETS__)&&window.__CRYPTO_TRACE_TARGETS__.length>0){window.__CRYPTO_TRACE_LOGS__=window.__CRYPTO_TRACE_LOGS__||[];window.__CRYPTO_TRACE_LOGS__.push({stage:"bundle.wordarray.clamp",sigBytes:e,hexPreview:typeof window.wordArrayToHexPreview==="function"?window.wordArrayToHexPreview(this,160):null,stack:String((new Error("BUNDLE_WORDARRAY_CLAMP")).stack||"").slice(0,1200)});window.__CRYPTO_TRACE_LOGS__.length>1200&&window.__CRYPTO_TRACE_LOGS__.shift()}}catch(_e){}r[e>>>2]&=4294967295<<32-e%4*8,r.length=t.ceil(e/4)}',
  );
  patched = patched.replace(
    'parse:function(t){return s.parse(unescape(encodeURIComponent(t)))}',
    'parse:function(t){try{if(window&&Array.isArray(window.__CRYPTO_TRACE_TARGETS__)&&window.__CRYPTO_TRACE_TARGETS__.length>0){var __raw=String(t==null?"":t);if(window.__CRYPTO_TRACE_TARGETS__.some(function(target){return __raw===target||__raw.indexOf(target)>=0||target.indexOf(__raw)>=0})){window.__CRYPTO_TRACE_LOGS__=window.__CRYPTO_TRACE_LOGS__||[];window.__CRYPTO_TRACE_LOGS__.push({stage:"bundle.utf8.parse",inputLength:__raw.length,inputPreview:__raw.slice(0,400),stack:String((new Error("BUNDLE_UTF8_PARSE")).stack||"").slice(0,1200)});window.__CRYPTO_TRACE_LOGS__.length>1200&&window.__CRYPTO_TRACE_LOGS__.shift()}}}catch(_e){}return s.parse(unescape(encodeURIComponent(t)))}',
  );
  patched = patched.replace(
    'encrypt:function(t,r,e,n){n=this.cfg.extend(n);var i=t.createEncryptor(e,n),o=i.finalize(r),c=i.cfg;return d.create({ciphertext:o,key:e,iv:c.iv,algorithm:t,mode:c.mode,padding:c.padding,blockSize:t.blockSize,formatter:n.format})}',
    'encrypt:function(t,r,e,n){n=this.cfg.extend(n);try{if(window&&Array.isArray(window.__CRYPTO_TRACE_TARGETS__)&&window.__CRYPTO_TRACE_TARGETS__.length>0){window.__CRYPTO_TRACE_LOGS__=window.__CRYPTO_TRACE_LOGS__||[];window.__CRYPTO_TRACE_LOGS__.push({stage:"bundle.aes.encrypt.before",valueType:typeof r,valuePreview:typeof r==="string"?r.slice(0,400):previewValue(r,240),valueLength:typeof r==="string"?r.length:Number.isFinite(r&&r.sigBytes)?r.sigBytes:null,keyType:typeof e,keyHexPreview:typeof window.wordArrayToHexPreview==="function"?window.wordArrayToHexPreview(e,128):null,ivType:typeof n.iv,ivHexPreview:typeof window.wordArrayToHexPreview==="function"?window.wordArrayToHexPreview(n.iv,128):null,stack:String((new Error("BUNDLE_AES_ENCRYPT_BEFORE")).stack||"").slice(0,1200)});window.__CRYPTO_TRACE_LOGS__.length>1200&&window.__CRYPTO_TRACE_LOGS__.shift()}}catch(_e){}var i=t.createEncryptor(e,n),o=i.finalize(r),c=i.cfg;try{if(window&&Array.isArray(window.__CRYPTO_TRACE_TARGETS__)&&window.__CRYPTO_TRACE_TARGETS__.length>0){window.__CRYPTO_TRACE_LOGS__=window.__CRYPTO_TRACE_LOGS__||[];window.__CRYPTO_TRACE_LOGS__.push({stage:"bundle.aes.encrypt.after",cipherHexPreview:typeof window.wordArrayToHexPreview==="function"?window.wordArrayToHexPreview(o,160):null,cipherSigBytes:Number.isFinite(o&&o.sigBytes)?o.sigBytes:null,stack:String((new Error("BUNDLE_AES_ENCRYPT_AFTER")).stack||"").slice(0,1200)});window.__CRYPTO_TRACE_LOGS__.length>1200&&window.__CRYPTO_TRACE_LOGS__.shift()}}catch(_e){}return d.create({ciphertext:o,key:e,iv:c.iv,algorithm:t,mode:c.mode,padding:c.padding,blockSize:t.blockSize,formatter:n.format})}',
  );
  patched = patched.replace(
    '}function X(t){return t.reduce(function(t,n){return t+ +!!n},0)}',
    '}window.__ALIYUN_VERIFY_HELPERS__={K:K,tC:tC,D:typeof D!=="undefined"?D:null};function X(t){return t.reduce(function(t,n){return t+ +!!n},0)}',
  );
  patched = patched.replace(
    'function t(n,e,r,i,a,o){var s,c,u,f,l,h,p,d,A;',
    'function t(n,e,r,i,a,o){var s,c,u,f,l,h,p,d,A;window.__T_VM_CALLS__=window.__T_VM_CALLS__||[];try{window.__T_VM_CALLS__.push({startN:n,rLen:r&&r.length||null,eLen:e&&e.length||null,stack:String((new Error("T_VM_CALL")).stack||"").slice(0,1200)});if(window.__T_VM_CALLS__.length>40)window.__T_VM_CALLS__.shift();74===n&&(window.__T_VM_74_ENTRY_LOGS__=window.__T_VM_74_ENTRY_LOGS__||[],window.__T_VM_74_ENTRY_LOGS__.push({startN:n,rLen:r&&r.length||null,eLen:e&&e.length||null,iLen:i&&i.length||null,aKeys:a&&typeof a==="object"?Object.keys(a).slice(0,40):null,aPreview:a&&typeof a==="object"?{o:typeof a.o==="string"?a.o.slice(0,240):a.o,n:a.n,e:a.e,a:a.a,m:a.m,t:typeof a.t==="string"?a.t.slice(0,240):a.t,r:Array.isArray(a.r)?a.r.slice(0,80):a.r}:a,oPreview:Array.isArray(o)?o.map(function(x){return typeof x==="string"?x.slice(0,800):x&&typeof x==="object"?{tag:Object.prototype.toString.call(x),keys:Object.keys(x).slice(0,20)}:x;}):o,stack:String((new Error("T_VM_74_ENTRY")).stack||"").slice(0,1200)}),window.__T_VM_74_ENTRY_LOGS__.length>40&&window.__T_VM_74_ENTRY_LOGS__.shift())}catch(_e){}',
  );
  patched = patched.replace(
    'for((s=Object.create(a.s||{}))._=window,s["*"]=a.t||this,a.e&&(s[i[r[n+1]]]=a.e),s.arguments=o,c=0,u=void 0;(n-r.length)*93+61<61;)',
    'for((s=Object.create(a.s||{}))._=window,s["*"]=a.t||this,a.e&&(s[i[r[n+1]]]=a.e),s.arguments=o,c=0,u=void 0;(window.__T_VM_LAST__={n:n,nextOpcode:r&&n<r.length?r[n]:null,opcodeWindow:r&&r.slice?r.slice(n,Math.min(r.length,n+12)):null,eLen:e&&e.length||null,stackTail:e&&e.slice?e.slice(Math.max(0,e.length-12)).map(function(x){if(typeof x==="string")return x.slice(0,200);if(x&&typeof x==="object")return {type:Object.prototype.toString.call(x),keys:Object.keys(x).slice(0,8)};return x;}):null},n===1020&&((window.__T_VM_1020_SNAPSHOTS__=window.__T_VM_1020_SNAPSHOTS__||[]).push({n:n,nextOpcode:r&&n<r.length?r[n]:null,opcodeWindow:r&&r.slice?r.slice(n,Math.min(r.length,n+10)):null,eLen:e&&e.length||null,stackTail:e&&e.slice?e.slice(Math.max(0,e.length-10)).map(function(x){if(typeof x==="string")return x.slice(0,200);if(x&&typeof x==="object")return {type:Object.prototype.toString.call(x),keys:Object.keys(x).slice(0,8)};return x;}):null,sPreview:s&&typeof s==="object"?{o:typeof s.o==="string"?s.o.slice(0,400):s.o,n:s.n,e:s.e,a:s.a,m:s.m,t:typeof s.t==="string"?s.t.slice(0,400):s.t,r:Array.isArray(s.r)?s.r.slice(0,128):s.r}:null}),window.__T_VM_1020_SNAPSHOTS__.length>400&&window.__T_VM_1020_SNAPSHOTS__.shift(),!window.__T_VM_INIT_SNAPSHOT__&&(window.__T_VM_INIT_SNAPSHOT__=window.__T_VM_1020_SNAPSHOTS__[0]||null)), (n<120||n>860&&n<1038||n>1220&&n<1244||n>1390&&n<1420||n>1450&&n<1498)&&(window.__T_VM_TRACE__=window.__T_VM_TRACE__||[],window.__T_VM_TRACE__.push({n:n,nextOpcode:r&&n<r.length?r[n]:null,opcodeWindow:r&&r.slice?r.slice(n,Math.min(r.length,n+10)):null,eLen:e&&e.length||null,stackTail:e&&e.slice?e.slice(Math.max(0,e.length-10)).map(function(x){if(typeof x==="string")return x.slice(0,200);if(x&&typeof x==="object")return {type:Object.prototype.toString.call(x),keys:Object.keys(x).slice(0,8)};return x;}):null,sPreview:s&&typeof s==="object"?{o:typeof s.o==="string"?s.o.slice(0,120):s.o,n:s.n,e:s.e,a:s.a,m:s.m,t:typeof s.t==="string"?s.t.slice(0,120):s.t,r:Array.isArray(s.r)?s.r.slice(0,80):s.r}:null}),window.__T_VM_TRACE__.length>4000&&window.__T_VM_TRACE__.shift()),(n-r.length)*93+61<61);)',
  );
  patched = patched.replace(
    '50==A?(f=r[n++],l=e.pop(),h=e.pop(),o=[],v(f).forEach(function(){o.unshift(e.pop())}),p=null===h?l.apply(s,o):h[l].apply(h,o),r[n++]&&e.push(p))',
    '50==A?(f=r[n++],l=e.pop(),h=e.pop(),o=[],v(f).forEach(function(){o.unshift(e.pop())}),window.__T_VM_APPLY_LOGS__=window.__T_VM_APPLY_LOGS__||[],p=null===h?l.apply(s,o):h[l].apply(h,o),window.__T_VM_APPLY_LOGS__.push({f:f,lType:typeof l,lPreview:typeof l==="string"?l.slice(0,160):l&&typeof l==="function"?String(l).slice(0,200):l,hType:typeof h,hPreview:h&&typeof h==="function"?String(h).slice(0,200):h&&typeof h==="object"?{tag:Object.prototype.toString.call(h),keys:Object.keys(h).slice(0,8)}:h,argPreview:o.map(function(x){return typeof x==="string"?x.slice(0,160):x&&typeof x==="object"?{tag:Object.prototype.toString.call(x),keys:Object.keys(x).slice(0,8)}:x;}),resultType:typeof p,resultPreview:typeof p==="string"?p.slice(0,160):p&&typeof p==="object"?{tag:Object.prototype.toString.call(p),keys:Object.keys(p).slice(0,8)}:p,n:n,opcodeWindow:r&&r.slice?r.slice(Math.max(0,n-3),Math.min(r.length,n+8)):null}),window.__T_VM_APPLY_LOGS__.length>5000&&window.__T_VM_APPLY_LOGS__.shift(),r[n++]&&e.push(p))',
  );
  patched = patched.replace(
    '27==A?(f=e.pop(),l=e.pop(),h=e.pop(),(p=l===s&&b(l,f)||l)[f]=h,(d=r[n++])&&e.push(h))',
    '27==A?(f=e.pop(),l=e.pop(),h=e.pop(),window.__T_VM_ASSIGN_LOGS__=window.__T_VM_ASSIGN_LOGS__||[],("r"===f||"n"===f||"o"===f||"t"===f||"e"===f||"a"===f||"m"===f)&&window.__T_VM_ASSIGN_LOGS__.push({k:f,lType:typeof l,lPreview:typeof l==="string"?l.slice(0,120):l&&typeof l==="object"?{tag:Object.prototype.toString.call(l),keys:Object.keys(l).slice(0,20)}:l,vType:typeof h,vPreview:typeof h==="string"?h.slice(0,400):Array.isArray(h)?h.slice(0,128):h&&typeof h==="object"?{tag:Object.prototype.toString.call(h),keys:Object.keys(h).slice(0,20)}:h,n:n,opcodeWindow:r&&r.slice?r.slice(Math.max(0,n-3),Math.min(r.length,n+8)):null,sPreview:{o:typeof s.o==="string"?s.o.slice(0,120):s.o,n:s.n,e:s.e,a:s.a,m:s.m,t:typeof s.t==="string"?s.t.slice(0,120):s.t,r:Array.isArray(s.r)?s.r.slice(0,80):s.r}}),window.__T_VM_ASSIGN_LOGS__.length>8000&&window.__T_VM_ASSIGN_LOGS__.shift(),(p=l===s&&b(l,f)||l)[f]=h,(d=r[n++])&&e.push(h))',
  );
  patched = patched.replace(
    '56==A?(f=e.pop(),l=e.pop(),r[n++]&&e.push(l[f]))',
    '56==A?(f=e.pop(),l=e.pop(),window.__T_VM_GET_LOGS__=window.__T_VM_GET_LOGS__||[],(f==="C"||n>1475&&n<1485)&&window.__T_VM_GET_LOGS__.push({f:f,lType:typeof l,lKeys:l&&typeof l==="object"?Object.keys(l).slice(0,20):null,lPreview:l&&typeof l==="object"?{CType:typeof l.C,CSource:typeof l.C==="function"?String(l.C).slice(0,600):null,oType:typeof l.o,oPreview:typeof l.o==="string"?l.o.slice(0,240):l.o,nType:typeof l.n,nPreview:typeof l.n==="string"?l.n.slice(0,240):l.n,rType:typeof l.r,rPreview:Array.isArray(l.r)?l.r.slice(0,80):typeof l.r==="string"?l.r.slice(0,240):l.r,tType:typeof l.t,tPreview:typeof l.t==="string"?l.t.slice(0,240):l.t,eType:typeof l.e,eSource:typeof l.e==="function"?String(l.e).slice(0,600):null,aType:typeof l.a,aSource:typeof l.a==="function"?String(l.a).slice(0,600):null,hType:typeof l.h,hSource:typeof l.h==="function"?String(l.h).slice(0,600):null,mType:typeof l.m,mSource:typeof l.m==="function"?String(l.m).slice(0,600):null,lType:typeof l.l,lSource:typeof l.l==="function"?String(l.l).slice(0,600):null,cType:typeof l.c,cSource:typeof l.c==="function"?String(l.c).slice(0,600):null,fType:typeof l.f,fSource:typeof l.f==="function"?String(l.f).slice(0,600):null,sType:typeof l.s,sSource:typeof l.s==="function"?String(l.s).slice(0,600):null}:l,n:n,opcodeWindow:r&&r.slice?r.slice(Math.max(0,n-3),Math.min(r.length,n+8)):null}),window.__T_VM_GET_LOGS__.length>80&&window.__T_VM_GET_LOGS__.shift(),r[n++]&&e.push(l[f]))',
  );
  patched = patched.replace(
    'ek=[x.V(K,nx),nQ+[tm][0](227,78)],c+=-243',
    'window.__VERIFY_DATA_CALLSITE_LOGS__=window.__VERIFY_DATA_CALLSITE_LOGS__||[],window.__VERIFY_DATA_CALLSITE_LOGS__.push({nxPreview:typeof nx==="string"?nx.slice(0,400):nx,nQPreview:typeof nQ==="string"?nQ.slice(0,120):nQ,tb:tb,eyPreview:typeof ey==="string"?ey.slice(0,120):ey,stack:String((new Error("VERIFY_DATA_CALLSITE")).stack||"").slice(0,1200)}),window.__VERIFY_VM_CONTEXT__={nxPreview:typeof nx==="string"?nx.slice(0,400):nx,nQPreview:typeof nQ==="string"?nQ.slice(0,160):nQ,tb:tb,eyPreview:typeof ey==="string"?ey.slice(0,160):ey,rLength:Array.isArray(R)?R.length:null,qLength:Array.isArray(q)?q.length:null,eWKeys:eW&&typeof eW==="object"?Object.keys(eW).slice(0,40):null,eWPreview:eW&&typeof eW==="object"?Object.fromEntries(Object.entries(eW).slice(0,12).map(function(entry){var key=entry[0],value=entry[1];return [key,Array.isArray(value)?value.slice(0,24):typeof value==="string"?value.slice(0,200):value&&typeof value==="object"?{tag:Object.prototype.toString.call(value),keys:Object.keys(value).slice(0,16)}:value]})):null,xKeys:x&&typeof x==="object"?Object.keys(x).slice(0,40):null,xPreview:x&&typeof x==="object"?Object.fromEntries(["w","V","G","s","C","D","y","u","e","h","Z","W","N","k","B","X","x","E","O","M","U"].map(function(key){var value=x[key];return [key,typeof value==="function"?String(value).slice(0,400):value&&typeof value==="object"?{tag:Object.prototype.toString.call(value),keys:Object.keys(value).slice(0,12)}:value]})):null,tmSource:typeof tm==="function"?String(tm).slice(0,800):null,tmValue:x&&typeof x.s==="function"?x.s(tm,~tm?253:4,~tm?16:4):null,oPreview:[typeof nx==="string"?nx.slice(0,400):nx,x&&typeof x.s==="function"?x.s(tm,~tm?253:4,~tm?16:4):null]},ek=[x.V(K,nx),nQ+[tm][0](227,78)],c+=-243',
  );
  patched = patched.replace(
    'ey=ny[x.G(nJ,x.s(tm,x.C(57,~tm),7&~tm))](),c+=-180',
    'ey=ny[x.G(nJ,x.s(tm,x.C(57,~tm),7&~tm))](),window.__VERIFY_DATA_CALLSITE_LOGS__=window.__VERIFY_DATA_CALLSITE_LOGS__||[],window.__VERIFY_DATA_CALLSITE_LOGS__.push({stage:"ey",eyPreview:typeof ey==="string"?ey.slice(0,200):ey,nyType:typeof ny,nyKeys:ny&&typeof ny==="object"?Object.keys(ny).slice(0,20):null,stack:String((new Error("VERIFY_DATA_EY")).stack||"").slice(0,1200)}),c+=-180',
  );
  patched = patched.replace(
    'eu=e,c+=-230',
    'eu=(function(__v){window.__PREID_EXPR_LOGS__=window.__PREID_EXPR_LOGS__||[];window.__PREID_EXPR_LOGS__.push({stage:"eu",valueType:typeof __v,valuePreview:typeof __v==="string"?__v.slice(0,1200):__v&&typeof __v==="object"?{tag:Object.prototype.toString.call(__v),keys:Object.keys(__v).slice(0,12),sigBytes:Number.isFinite(__v.sigBytes)?__v.sigBytes:null}:__v,valueLength:typeof __v==="string"?__v.length:null,stack:String((new Error("PREID_EU")).stack||"").slice(0,1200)});window.__PREID_EXPR_LOGS__.length>160&&window.__PREID_EXPR_LOGS__.shift();return __v})(e),c+=-230',
  );
  patched = patched.replace(
    'eu=e,c-=105',
    'eu=(function(__v){window.__PREID_EXPR_LOGS__=window.__PREID_EXPR_LOGS__||[];window.__PREID_EXPR_LOGS__.push({stage:"eu",valueType:typeof __v,valuePreview:typeof __v==="string"?__v.slice(0,1200):__v&&typeof __v==="object"?{tag:Object.prototype.toString.call(__v),keys:Object.keys(__v).slice(0,12),sigBytes:Number.isFinite(__v.sigBytes)?__v.sigBytes:null}:__v,valueLength:typeof __v==="string"?__v.length:null,stack:String((new Error("PREID_EU")).stack||"").slice(0,1200)});window.__PREID_EXPR_LOGS__.length>160&&window.__PREID_EXPR_LOGS__.shift();return __v})(e),c-=105',
  );
  patched = patched.replace(
    'H=tV[tr.s(j,"t")][(tr.p(K),K)(85,162)]()||""',
    'H=(function(__v){window.__PREID_EXPR_LOGS__=window.__PREID_EXPR_LOGS__||[];window.__PREID_EXPR_LOGS__.push({stage:"H",valueType:typeof __v,valuePreview:typeof __v==="string"?__v.slice(0,1200):__v&&typeof __v==="object"?{tag:Object.prototype.toString.call(__v),keys:Object.keys(__v).slice(0,12),sigBytes:Number.isFinite(__v.sigBytes)?__v.sigBytes:null}:__v,valueLength:typeof __v==="string"?__v.length:null,decodedBytes:typeof __v==="string"&&/^[A-Za-z0-9+/=]+$/.test(__v)?(function(){try{return Buffer.from(__v,"base64").length}catch(_e){return null}})():null,stack:String((new Error("PREID_H")).stack||"").slice(0,1200)});window.__PREID_EXPR_LOGS__.length>160&&window.__PREID_EXPR_LOGS__.shift();return __v})(tV[tr.s(j,"t")][(tr.p(K),K)(85,162)]()||"")',
  );
  patched = patched.replace(
    '}(nU,tT),c^=276',
    '}(nU,tT),window.__PREID_H_REAL_LOGS__=window.__PREID_H_REAL_LOGS__||[],window.__PREID_H_REAL_LOGS__.push({valueType:typeof H,valuePreview:typeof H==="string"?H.slice(0,1200):H,valueLength:typeof H==="string"?H.length:null,decodedBytes:typeof H==="string"&&/^[A-Za-z0-9+/=]+$/.test(H)?(function(){try{return Buffer.from(H,"base64").length}catch(_e){return null}})():null,nUType:typeof nU,nULength:typeof nU==="string"?nU.length:Number.isFinite(nU&&nU.sigBytes)?nU.sigBytes:null,nUPreview:typeof nU==="string"?nU.slice(0,400):nU&&typeof nU==="object"?{tag:Object.prototype.toString.call(nU),keys:Object.keys(nU).slice(0,12),sigBytes:Number.isFinite(nU.sigBytes)?nU.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(nU,128):null}:nU,nUTail:typeof nU==="string"?nU.slice(-400):null,nUFull:typeof nU==="string"&&nU.length<5000?nU:null,tTType:typeof tT,tTLength:typeof tT==="string"?tT.length:Number.isFinite(tT&&tT.sigBytes)?tT.sigBytes:null,tTPreview:typeof tT==="string"?tT.slice(0,400):tT&&typeof tT==="object"?{tag:Object.prototype.toString.call(tT),keys:Object.keys(tT).slice(0,12),sigBytes:Number.isFinite(tT.sigBytes)?tT.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(tT,128):null}:tT,tTTail:typeof tT==="string"?tT.slice(-400):null,tTFull:typeof tT==="string"&&tT.length<5000?tT:null,nDType:typeof nD,nDPreview:typeof nD==="string"?nD.slice(0,400):nD&&typeof nD==="object"?{tag:Object.prototype.toString.call(nD),keys:Object.keys(nD).slice(0,12),sigBytes:Number.isFinite(nD.sigBytes)?nD.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(nD,128):null}:nD,nqType:typeof nq,nqPreview:typeof nq==="string"?nq.slice(0,400):nq&&typeof nq==="object"?{tag:Object.prototype.toString.call(nq),keys:Object.keys(nq).slice(0,12),sigBytes:Number.isFinite(nq.sigBytes)?nq.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(nq,128):null}:nq,n3Type:typeof n3,n3Preview:typeof n3==="string"?n3.slice(0,400):n3&&typeof n3==="object"?{tag:Object.prototype.toString.call(n3),keys:Object.keys(n3).slice(0,12),sigBytes:Number.isFinite(n3.sigBytes)?n3.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(n3,128):null}:n3,stack:String((new Error("PREID_H_REAL")).stack||"").slice(0,1200)}),window.__PREID_H_REAL_LOGS__.length>120&&window.__PREID_H_REAL_LOGS__.shift(),c^=276',
  );
  patched = patched.replace(
    'e=ts[a.g(i,~i&&60,~i&&48)](this,74)[a.g(i,~i?234:3,~i?33:9)](this,arguments)',
    'e=(function(__out){try{window.__PE_TS74_RETURN_INLINE_LOGS__=window.__PE_TS74_RETURN_INLINE_LOGS__||[];var __defaultString=null,__base64String=null,__hexString=null,__sigBytes=null,__wordArrayBase64=null,__wordArrayHex=null;try{if(__out&&typeof __out.toString==="function"){__defaultString=String(__out.toString());try{__base64String=__out.toString(cryptShim.enc.Base64)}catch(_e){}try{__hexString=__out.toString(cryptShim.enc.Hex)}catch(_e){}}}catch(_e){}try{if(__out&&typeof __out==="object"&&Number.isFinite(__out.sigBytes)){__sigBytes=__out.sigBytes;__wordArrayBase64=typeof normalizeWordArray==="function"?normalizeWordArray(__out).toString("base64"):null;__wordArrayHex=typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(__out,272):null}}catch(_e){}window.__PE_TS74_RETURN_INLINE_LOGS__.push({outputType:typeof __out,outputCtor:__out&&__out.constructor?String(__out.constructor.name||""):null,outputPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,320),outputLength:typeof __out==="string"?__out.length:null,outputDecodedBytes:typeof __out==="string"&&/^[A-Za-z0-9+/=]+$/.test(__out)?(function(){try{return Buffer.from(__out,"base64").length}catch(_e){return null}})():null,outputDefaultString:typeof __defaultString==="string"?__defaultString.slice(0,1200):null,outputDefaultStringLength:typeof __defaultString==="string"?__defaultString.length:null,outputBase64String:typeof __base64String==="string"?__base64String.slice(0,1200):null,outputBase64DecodedBytes:typeof __base64String==="string"&&/^[A-Za-z0-9+/=]+$/.test(__base64String)?(function(){try{return Buffer.from(__base64String,"base64").length}catch(_e){return null}})():null,outputHexString:typeof __hexString==="string"?__hexString.slice(0,1200):null,outputHexDecodedBytes:typeof __hexString==="string"&&/^[0-9a-f]+$/i.test(__hexString)&&__hexString.length%2===0?__hexString.length/2:null,outputSigBytes:__sigBytes,outputWordArrayBase64:typeof __wordArrayBase64==="string"?__wordArrayBase64.slice(0,1200):null,outputWordArrayHexPreview:typeof __wordArrayHex==="string"?__wordArrayHex.slice(0,1200):null,outputObjectShape:typeof snapshotObjectShape==="function"?snapshotObjectShape(__out,20):null,stack:String((new Error("PE_TS74_RETURN_INLINE")).stack||"").slice(0,1200)});window.__PE_TS74_RETURN_INLINE_LOGS__.length>160&&window.__PE_TS74_RETURN_INLINE_LOGS__.shift()}catch(_e){}return __out})(ts[a.g(i,~i&&60,~i&&48)](this,74)[a.g(i,~i?234:3,~i?33:9)](this,arguments))',
  );
  patched = patched.replace(
    'c^=97,ng=e,ny=r',
    'c^=97,ng=(function(__v){window.__PREID_EXPR_LOGS__=window.__PREID_EXPR_LOGS__||[];window.__PREID_EXPR_LOGS__.push({stage:"ng",valueType:typeof __v,valuePreview:typeof __v==="string"?__v.slice(0,1200):__v&&typeof __v==="object"?{tag:Object.prototype.toString.call(__v),keys:Object.keys(__v).slice(0,12),sigBytes:Number.isFinite(__v.sigBytes)?__v.sigBytes:null}:__v,valueLength:typeof __v==="string"?__v.length:null,stack:String((new Error("PREID_NG")).stack||"").slice(0,1200)});window.__PREID_EXPR_LOGS__.length>160&&window.__PREID_EXPR_LOGS__.shift();return __v})(e),ny=r',
  );
  patched = patched.replace(
    'ty(tx[x.G(Q,"EC")],tx[nw+(~tm?tm:8)(14,11)])',
    '(function(__v){window.__PREID_EXPR_LOGS__=window.__PREID_EXPR_LOGS__||[];window.__PREID_EXPR_LOGS__.push({stage:"nD",valueType:typeof __v,valuePreview:typeof __v==="string"?__v.slice(0,1200):__v&&typeof __v==="object"?{tag:Object.prototype.toString.call(__v),keys:Object.keys(__v).slice(0,12),sigBytes:Number.isFinite(__v.sigBytes)?__v.sigBytes:null}:__v,valueLength:typeof __v==="string"?__v.length:null,stack:String((new Error("PREID_ND")).stack||"").slice(0,1200)});window.__PREID_EXPR_LOGS__.length>160&&window.__PREID_EXPR_LOGS__.shift();return __v})(ty(tx[x.G(Q,"EC")],tx[nw+(~tm?tm:8)(14,11)]))',
  );
  patched = patched.replace(
    'V=ty(tx[x.G(n4,"EC")],tx[tm(92..valueOf(),70..valueOf())]),c=285',
    'V=(function(__v){window.__PREID_V_LOGS__=window.__PREID_V_LOGS__||[];window.__PREID_V_LOGS__.push({valueType:typeof __v,valuePreview:typeof __v==="string"?__v.slice(0,1200):__v&&typeof __v==="object"?{tag:Object.prototype.toString.call(__v),keys:Object.keys(__v).slice(0,12),sigBytes:Number.isFinite(__v.sigBytes)?__v.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(__v,128):null}:__v,valueLength:typeof __v==="string"?__v.length:null,arg0:tx&&typeof x.G==="function"?tx[x.G(n4,"EC")]:null,arg1:tx?tx[tm(92..valueOf(),70..valueOf())]:null,stack:String((new Error("PREID_V")).stack||"").slice(0,1200)});window.__PREID_V_LOGS__.length>120&&window.__PREID_V_LOGS__.shift();return __v})(ty(tx[x.G(n4,"EC")],tx[tm(92..valueOf(),70..valueOf())])),c=285',
  );
  patched = patched.replace(
    'ng[x.G(eR,tm(Math.round(57),Math.round(7)))]()',
    '(function(__v){window.__PREID_EXPR_LOGS__=window.__PREID_EXPR_LOGS__||[];window.__PREID_EXPR_LOGS__.push({stage:"nq",valueType:typeof __v,valuePreview:typeof __v==="string"?__v.slice(0,1200):__v&&typeof __v==="object"?{tag:Object.prototype.toString.call(__v),keys:Object.keys(__v).slice(0,12),sigBytes:Number.isFinite(__v.sigBytes)?__v.sigBytes:null}:__v,valueLength:typeof __v==="string"?__v.length:null,stack:String((new Error("PREID_NQ")).stack||"").slice(0,1200)});window.__PREID_EXPR_LOGS__.length>160&&window.__PREID_EXPR_LOGS__.shift();return __v})(ng[x.G(eR,tm(Math.round(57),Math.round(7)))]())',
  );
  patched = patched.replace(
    'th[({0:tm})[0](291,64)](nF)',
    '(function(__v){window.__PREID_EXPR_LOGS__=window.__PREID_EXPR_LOGS__||[];window.__PREID_EXPR_LOGS__.push({stage:"b",valueType:typeof __v,valuePreview:typeof __v==="string"?__v.slice(0,1200):__v&&typeof __v==="object"?{tag:Object.prototype.toString.call(__v),keys:Object.keys(__v).slice(0,12),sigBytes:Number.isFinite(__v.sigBytes)?__v.sigBytes:null}:__v,valueLength:typeof __v==="string"?__v.length:null,nFPreview:typeof nF==="string"?nF.slice(0,400):nF,stack:String((new Error("PREID_B")).stack||"").slice(0,1200)});window.__PREID_EXPR_LOGS__.length>160&&window.__PREID_EXPR_LOGS__.shift();return __v})(th[({0:tm})[0](291,64)](nF))',
  );
  patched = patched.replace(
    'v=[tk,nO,H,tA,ng][tm(147/x.u(tm,1),x.D(14,x.u(tm,1)))](A)',
    'v=[tk,nO,H,tA,ng][tm(147/x.u(tm,1),x.D(14,x.u(tm,1)))](A),window.__VERIFY_G_CALLSITE_LOGS__=window.__VERIFY_G_CALLSITE_LOGS__||[],window.__VERIFY_G_CALLSITE_LOGS__.push({stage:"join",separatorPreview:typeof A==="string"?A.slice(0,80):A,separatorLength:typeof A==="string"?A.length:null,namedParts:{tk:typeof tk==="string"?tk.slice(0,240):tk,nO:typeof nO==="string"?nO.slice(0,240):nO,H:typeof H==="string"?H.slice(0,1200):H,tA:typeof tA==="string"?tA.slice(0,240):tA,ng:typeof ng==="string"?ng.slice(0,240):ng},parts:[tk,nO,H,tA,ng].map(function(value){return typeof value==="string"?value.slice(0,1200):value&&typeof value==="object"?{tag:Object.prototype.toString.call(value),keys:Object.keys(value).slice(0,12)}:value}),joinContext:{HLength:typeof H==="string"?H.length:null,ngLength:typeof ng==="string"?ng.length:null,euType:typeof eu==="undefined"?null:typeof eu,euPreview:typeof eu==="undefined"?null:typeof eu==="string"?eu.slice(0,400):eu&&typeof eu==="object"?{tag:Object.prototype.toString.call(eu),keys:Object.keys(eu).slice(0,12),sigBytes:Number.isFinite(eu.sigBytes)?eu.sigBytes:null,toString:typeof eu.toString==="function"?String(eu.toString()).slice(0,240):null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(eu,128):null}:eu,mType:typeof m==="undefined"?null:typeof m,mPreview:typeof m==="undefined"?null:typeof m==="string"?m.slice(0,400):m&&typeof m==="object"?{tag:Object.prototype.toString.call(m),keys:Object.keys(m).slice(0,12),sigBytes:Number.isFinite(m.sigBytes)?m.sigBytes:null,toString:typeof m.toString==="function"?String(m.toString()).slice(0,240):null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(m,128):null}:m,bType:typeof b==="undefined"?null:typeof b,bPreview:typeof b==="undefined"?null:typeof b==="string"?b.slice(0,400):b&&typeof b==="object"?{tag:Object.prototype.toString.call(b),keys:Object.keys(b).slice(0,12),sigBytes:Number.isFinite(b.sigBytes)?b.sigBytes:null,toString:typeof b.toString==="function"?String(b.toString()).slice(0,240):null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(b,128):null}:b,nFPreview:typeof nF==="undefined"?null:typeof nF==="string"?nF.slice(0,240):nF,nDPreview:typeof nD==="undefined"?null:typeof nD==="string"?nD.slice(0,400):nD&&typeof nD==="object"?{tag:Object.prototype.toString.call(nD),keys:Object.keys(nD).slice(0,12),sigBytes:Number.isFinite(nD.sigBytes)?nD.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(nD,128):null}:nD,nqPreview:typeof nq==="undefined"?null:typeof nq==="string"?nq.slice(0,400):nq&&typeof nq==="object"?{tag:Object.prototype.toString.call(nq),keys:Object.keys(nq).slice(0,12),sigBytes:Number.isFinite(nq.sigBytes)?nq.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(nq,128):null}:nq,n3Preview:typeof n3==="undefined"?null:typeof n3==="string"?n3.slice(0,400):n3&&typeof n3==="object"?{tag:Object.prototype.toString.call(n3),keys:Object.keys(n3).slice(0,12),sigBytes:Number.isFinite(n3.sigBytes)?n3.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(n3,128):null}:n3,n1Preview:typeof n1==="undefined"?null:typeof n1==="string"?n1.slice(0,400):n1&&typeof n1==="object"?{tag:Object.prototype.toString.call(n1),keys:Object.keys(n1).slice(0,12),sigBytes:Number.isFinite(n1.sigBytes)?n1.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(n1,128):null}:n1,thKeys:th&&typeof th==="object"?Object.keys(th).slice(0,12):null,txKeys:tx&&typeof tx==="object"?Object.keys(tx).slice(0,12):null,txPreview:tx&&typeof tx==="object"?{tag:Object.prototype.toString.call(tx),keys:Object.keys(tx).slice(0,12)}:tx,tyType:typeof ty==="undefined"?null:typeof ty,tySource:typeof ty==="function"?String(ty).slice(0,500):null,tyPreview:typeof ty==="undefined"?null:typeof ty==="string"?ty.slice(0,400):ty&&typeof ty==="object"?{tag:Object.prototype.toString.call(ty),keys:Object.keys(ty).slice(0,12),sigBytes:Number.isFinite(ty.sigBytes)?ty.sigBytes:null}:ty},joinedPreview:typeof v==="string"?v.slice(0,1200):v,joinedLength:typeof v==="string"?v.length:null,stack:String((new Error("VERIFY_G_JOIN")).stack||"").slice(0,1200)}),window.__VERIFY_G_CALLSITE_LOGS__.length>80&&window.__VERIFY_G_CALLSITE_LOGS__.shift()',
  );
  patched = patched.replace(
    'ng=tU([tk,nO,H,tA,V][tm.bind(0,147,14)()](A))[(x.d(tm),tm)(252,98)](),c^=293',
    'ng=(function(__joined,__hash){window.__PREID_NG_LOGS__=window.__PREID_NG_LOGS__||[];var __out=__hash[(x.d(tm),tm)(252,98)]();window.__PREID_NG_LOGS__.push({joinedPreview:typeof __joined==="string"?__joined.slice(0,1600):__joined,joinedLength:typeof __joined==="string"?__joined.length:null,hashType:typeof __hash,hashPreview:typeof __hash==="string"?__hash.slice(0,1200):__hash&&typeof __hash==="object"?{tag:Object.prototype.toString.call(__hash),keys:Object.keys(__hash).slice(0,12),sigBytes:Number.isFinite(__hash.sigBytes)?__hash.sigBytes:null,hexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(__hash,128):null}:__hash,out:typeof __out==="string"?__out.slice(0,1200):__out,stack:String((new Error("PREID_NG")).stack||"").slice(0,1200)});window.__PREID_NG_LOGS__.length>120&&window.__PREID_NG_LOGS__.shift();return __out})([tk,nO,H,tA,V][tm.bind(0,147,14)()](A),tU([tk,nO,H,tA,V][tm.bind(0,147,14)()](A))),c^=293',
  );
  patched = patched.replace(
    'b=th[({0:tm})[0](291,64)](nF)',
    'b=th[({0:tm})[0](291,64)](nF),window.__VERIFY_G_CALLSITE_LOGS__=window.__VERIFY_G_CALLSITE_LOGS__||[],window.__VERIFY_G_CALLSITE_LOGS__.push({stage:"parse",inputPreview:typeof nF==="string"?nF.slice(0,400):nF,parsedPreview:typeof b==="string"?b.slice(0,400):Array.isArray(b)?b.slice(0,80):b&&typeof b==="object"?{tag:Object.prototype.toString.call(b),keys:Object.keys(b).slice(0,20),sample:Array.isArray(b)?b.slice(0,24):null}:b,parsedType:typeof b,thType:typeof th,parseSource:th&&typeof th.parse==="function"?String(th.parse).slice(0,240):null,stack:String((new Error("VERIFY_G_PARSE")).stack||"").slice(0,1200)}),window.__VERIFY_G_CALLSITE_LOGS__.length>80&&window.__VERIFY_G_CALLSITE_LOGS__.shift()',
  );
  patched = patched.replace(
    'function io(t,r){',
    'function io(t,r){window.__FEILIN_IO_LOGS__=window.__FEILIN_IO_LOGS__||[];window.__FEILIN_IO_LOGS__.push({args:[typeof t==="string"?t.slice(0,400):t,typeof r==="string"?r.slice(0,400):r],stack:String((new Error("FEILIN_IO")).stack||"").slice(0,1200)});',
  );
  patched = patched.replace(
    'function ty(t,n){var e,r,i,a,o,s;',
    'function ty(t,n){window.__PE_TY_LOGS__=window.__PE_TY_LOGS__||[];var __peTyEntry={arg0:typeof t==="string"?t.slice(0,400):t,arg1:typeof n==="string"?n.slice(0,400):n,arg0Type:typeof t,arg1Type:typeof n,stack:String((new Error("PE_TY")).stack||"").slice(0,1200)};window.__PE_TY_LOGS__.push(__peTyEntry);window.__PE_TY_LOGS__.length>120&&window.__PE_TY_LOGS__.shift();var e,r,i,a,o,s;',
  );
  patched = patched.replace(
    ')}return e}function tC(t){',
    ')}try{window.__PE_TY_RETURNS__=window.__PE_TY_RETURNS__||[];window.__PE_TY_RETURNS__.push({outputType:typeof e,outputPreview:typeof e==="string"?e.slice(0,400):e&&typeof e==="object"?{tag:Object.prototype.toString.call(e),keys:Object.keys(e).slice(0,12),sigBytes:Number.isFinite(e.sigBytes)?e.sigBytes:null}:e,outputLength:typeof e==="string"?e.length:null,outputHexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(e,96):null,stack:String((new Error("PE_TY_RETURN")).stack||"").slice(0,1200)});window.__PE_TY_RETURNS__.length>120&&window.__PE_TY_RETURNS__.shift()}catch(_e){}return e}window.__PE_TY__=ty;function tC(t){',
  );
  patched = patched.replace(
    'return e}function iu(t,r,e,n){',
    'return e}window.__FEILIN_IO__=io;function iu(t,r,e,n){',
  );
  patched = patched.replace(
    'function iu(t,r,e,n){',
    'function iu(t,r,e,n){window.__FEILIN_IU_LOGS__=window.__FEILIN_IU_LOGS__||[];window.__FEILIN_IU_LOGS__.push({args:[typeof t==="string"?t.slice(0,400):t,typeof r==="string"?r.slice(0,400):r,typeof e==="string"?e.slice(0,400):e,typeof n==="string"?n.slice(0,400):n],stack:String((new Error("FEILIN_IU")).stack||"").slice(0,1200)});',
  );
  patched = patched.replace(
    'return i}function ic(t,r){',
    'return i}window.__FEILIN_IU__=iu;function ic(t,r){',
  );
  patched = patched.replace(
    'function rL(t){try{return btoa(t)}catch(r){return btoa(unescape(encodeURIComponent(t)))}}',
    'function rL(t){try{window.__RL_LOGS__=window.__RL_LOGS__||[];var caller=null;try{caller=rL.caller;}catch(_err){}window.__RL_LOGS__.push({input:typeof t==="string"?t.slice(0,800):t,callerSource:caller?String(caller).slice(0,1200):null,callerArgs:(function(){try{return caller&&caller.arguments?Array.from(caller.arguments).slice(0,12).map(function(x){return typeof x==="string"?x.slice(0,400):x;}):null}catch(_e){return null}})(),stack:String((new Error(\"rL\")).stack||\"\").slice(0,1200)});return btoa(t)}catch(r){return btoa(unescape(encodeURIComponent(t)))}}',
  );
  patched = patched.replace(
    'function sb(t,r,e){',
    'window.__FEILIN_EXPORT_RE__=typeof re!=="undefined"?re:void 0;function sb(t,r,e){',
  );
  patched = patched.replace(
    'function sb(t,r,e){',
    'function sb(t,r,e){window.__FEILIN_SB__=sb;window.__FEILIN_SB_TRACE__=window.__FEILIN_SB_TRACE__||[];try{window.__FEILIN_SE__=typeof se!=="undefined"?se:void 0;window.__FEILIN_SA__=typeof sa!=="undefined"?sa:void 0;window.__FEILIN_SG__=typeof sg!=="undefined"?sg:void 0;window.__FEILIN_SY__=typeof sy!=="undefined"?sy:void 0;window.__FEILIN_RE__=typeof re!=="undefined"?re:void 0;window.__FEILIN_SI__=typeof si!=="undefined"?si:void 0;window.__FEILIN_SB_TRACE__.push({seKeys:window.__FEILIN_SE__&&typeof window.__FEILIN_SE__==="object"?Object.keys(window.__FEILIN_SE__).slice(0,80):null,saKeys:window.__FEILIN_SA__&&typeof window.__FEILIN_SA__==="object"?Object.keys(window.__FEILIN_SA__).slice(0,80):null,reType:typeof window.__FEILIN_RE__,siType:typeof window.__FEILIN_SI__,sgType:typeof window.__FEILIN_SG__,syType:typeof window.__FEILIN_SY__,stack:String((new Error(\"FEILIN_SB\")).stack||\"\").slice(0,1200)});}catch(_e){}',
  );
  patched = patched.replace(
    'function sw(t){',
    'window.__FEILIN_SB__=typeof sb==="function"?sb:window.__FEILIN_SB__;window.__FEILIN_SE_FN__=typeof se==="function"?se:window.__FEILIN_SE_FN__;window.__FEILIN_SV_FN__=typeof sv==="function"?sv:window.__FEILIN_SV_FN__;function sw(t){',
  );
  patched = patched.replace(
    'function sv(){',
    'function sv(){window.__FEILIN_SV_LOGS__=window.__FEILIN_SV_LOGS__||[];try{window.__FEILIN_SV_LOGS__.push({stage:"enter",thisType:typeof this,thisKeys:this&&typeof this==="object"?Object.keys(this).slice(0,30):null,thisPreview:previewValue(this,400),argc:arguments.length,args:Array.from(arguments).slice(0,8).map(function(x){return previewValue(x,240)}),stack:String((new Error("FEILIN_SV")).stack||"").slice(0,1200)});window.__FEILIN_SV_LOGS__.length>80&&window.__FEILIN_SV_LOGS__.shift()}catch(_e){}',
  );
  patched = patched.replace(
    'p=function(e){var n,i,a,o,d,p,M,O,U,N,S,x,I,A,T,R,B,F,C,q,E,Y,J,H,P,j,z,L,Q,Z,K,V,D,G,X,_,W,$,tt,tr,te,tn,ti,ta,to,tu,tc,ts,tf,tl,th,td,tp,tv,tb,tw,tg,tm,ty,tk,tM,tO,tU,tN,tS,tx,tI,tA,tT,tR,tB,tF,tC,tq,tE,tY,tJ,tH,tP,tj,tz,tL,tQ,tZ,tK,tV,tD,tG,tX,t_;for(i=45;i;)switch(a=i>>6,o=i>>3&7,d=7&i,a){',
    'p=function(e){window.__FEILIN_P_LOGS__=window.__FEILIN_P_LOGS__||[];try{window.__FEILIN_P_LOGS__.push({stage:"enter",thisType:typeof this,thisKeys:this&&typeof this==="object"?Object.keys(this).slice(0,30):null,arg0Type:typeof e,arg0Keys:e&&typeof e==="object"?Object.keys(e).slice(0,30):null,arg0HasLogs:!!(e&&typeof e==="object"&&"logs"in e),arg0LogsType:e&&typeof e==="object"?typeof e.logs:null,stack:String((new Error("FEILIN_P")).stack||"").slice(0,1200)});window.__FEILIN_P_LOGS__.length>160&&window.__FEILIN_P_LOGS__.shift()}catch(_e){}var n,i,a,o,d,p,M,O,U,N,S,x,I,A,T,R,B,F,C,q,E,Y,J,H,P,j,z,L,Q,Z,K,V,D,G,X,_,W,$,tt,tr,te,tn,ti,ta,to,tu,tc,ts,tf,tl,th,td,tp,tv,tb,tw,tg,tm,ty,tk,tM,tO,tU,tN,tS,tx,tI,tA,tT,tR,tB,tF,tC,tq,tE,tY,tJ,tH,tP,tj,tz,tL,tQ,tZ,tK,tV,tD,tG,tX,t_;for(i=45;i;)switch(a=i>>6,o=i>>3&7,d=7&i,a){',
  );
  patched = patched.replace(
    'te=t[(~N?N:0)(55,43)],i-=32',
    'te=t[(~N?N:0)(55,43)],window.__FEILIN_P_LOGS__=window.__FEILIN_P_LOGS__||[],window.__FEILIN_P_LOGS__.push({stage:"extract-logs",sourceType:typeof t,sourceKeys:t&&typeof t==="object"?Object.keys(t).slice(0,20):null,logsType:typeof te,logsKeys:te&&typeof te==="object"?Object.keys(te).slice(0,20):null,stack:String((new Error("FEILIN_P_EXTRACT_LOGS")).stack||"").slice(0,1200)}),window.__FEILIN_P_LOGS__.length>160&&window.__FEILIN_P_LOGS__.shift(),i-=32',
  );
  patched = patched.replace(
    'tL={logs:te}',
    'window.__FEILIN_P_LOGS__=window.__FEILIN_P_LOGS__||[],window.__FEILIN_P_LOGS__.push({stage:"build-logs-wrapper",logsType:typeof te,logsKeys:te&&typeof te==="object"?Object.keys(te).slice(0,20):null,EType:typeof E,EKeys:E&&typeof E==="object"?Object.keys(E).slice(0,20):null,stack:String((new Error("FEILIN_P_BUILD_LOGS")).stack||"").slice(0,1200)}),window.__FEILIN_P_LOGS__.length>160&&window.__FEILIN_P_LOGS__.shift(),tL={logs:te}',
  );
  patched = patched.replace(
    'w=re[B+N.call(5,14,79)]',
    'window.__FEILIN_P_LOGS__=window.__FEILIN_P_LOGS__||[],window.__FEILIN_P_LOGS__.push({stage:"assign-w-before",B:typeof B==="string"?B.slice(0,120):B,decodedSuffix:(function(){try{return N.call(5,14,79)}catch(_e){return "N_ERR:"+String(_e)}})(),reKeys:re&&typeof re==="object"?Object.keys(re).slice(0,30):null,stack:String((new Error("FEILIN_P_ASSIGN_W_BEFORE")).stack||"").slice(0,1200)}),window.__FEILIN_P_LOGS__.length>160&&window.__FEILIN_P_LOGS__.shift(),w=re[B+N.call(5,14,79)],window.__FEILIN_P_LOGS__.push({stage:"assign-w-after",wType:typeof w,wKeys:w&&typeof w==="object"?Object.keys(w).slice(0,30):null,wPreview:typeof previewValue==="function"?previewValue(w,240):null,stack:String((new Error("FEILIN_P_ASSIGN_W_AFTER")).stack||"").slice(0,1200)}),window.__FEILIN_P_LOGS__.length>160&&window.__FEILIN_P_LOGS__.shift()',
  );
  patched = patched.replace(
    'f=w[N(Math.round(126),88)],i-=-9',
    'window.__FEILIN_P_LOGS__=window.__FEILIN_P_LOGS__||[],window.__FEILIN_P_LOGS__.push({stage:"read-w-before",wType:typeof w,wKeys:w&&typeof w==="object"?Object.keys(w).slice(0,30):null,prop:(function(){try{return N(Math.round(126),88)}catch(_e){return "N_ERR:"+String(_e)}})(),stack:String((new Error("FEILIN_P_READ_W_BEFORE")).stack||"").slice(0,1200)}),window.__FEILIN_P_LOGS__.length>160&&window.__FEILIN_P_LOGS__.shift(),f=w[N(Math.round(126),88)],window.__FEILIN_P_LOGS__.push({stage:"read-w-after",fType:typeof f,fPreview:typeof previewValue==="function"?previewValue(f,240):null,stack:String((new Error("FEILIN_P_READ_W_AFTER")).stack||"").slice(0,1200)}),window.__FEILIN_P_LOGS__.length>160&&window.__FEILIN_P_LOGS__.shift(),i-=-9',
  );
  patched = patched.replace(
    'ts[N(134,44)]=sb,i+=-83',
    'window.__FEILIN_UM_REAL_SET_LOGS__=window.__FEILIN_UM_REAL_SET_LOGS__||[],window.__FEILIN_UM_REAL_SET_LOGS__.push({stage:"before-real-set",targetKeys:ts&&typeof ts==="object"?Object.keys(ts).slice(0,20):null,targetType:typeof ts,targetString:typeof ts==="string"?ts.slice(0,320):ts&&typeof ts!=="object"?String(ts).slice(0,320):null,thisType:typeof this,thisKeys:this&&typeof this==="object"?Object.keys(this).slice(0,20):null,stack:String((new Error("FEILIN_UM_REAL_SET")).stack||"").slice(0,1200)}),window.__FEILIN_UM_REAL_SET_LOGS__.length>160&&window.__FEILIN_UM_REAL_SET_LOGS__.shift(),ts[N(134,44)]=sb,i+=-83',
  );
  patched = patched.replace(
    'function ub(t,r){',
    'function ub(t,r){var __ubArg0=t,__ubArg1=r,__ubThis=this;try{window.__FEILIN_UB_LOGS__=window.__FEILIN_UB_LOGS__||[];window.__FEILIN_UB_LOGS__.push({stage:"enter",arg0:typeof t==="string"?t.slice(0,200):t,arg1:typeof r==="string"?r.slice(0,200):r,stack:String((new Error("FEILIN_UB")).stack||"").slice(0,1200)});if(t===100){try{window.__FEILIN_UB_ARG100_LOGS__=window.__FEILIN_UB_ARG100_LOGS__||[];window.__FEILIN_UB_ARG100_LOGS__.push({stage:"enter",arg0:t,arg1Type:typeof r,arg1Preview:typeof r==="string"?r.slice(0,200):previewValue(r,120),thisType:typeof this,thisKeys:this&&typeof this==="object"?Object.keys(this).slice(0,20):null,reKeys:window.__FEILIN_RE__&&typeof window.__FEILIN_RE__==="object"?Object.keys(window.__FEILIN_RE__).slice(0,30):null,reSessionId:window.__FEILIN_RE__&&typeof window.__FEILIN_RE__.sessionId==="string"?window.__FEILIN_RE__.sessionId.slice(0,120):window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.sessionId,120):null,reSecretKey:window.__FEILIN_RE__&&typeof window.__FEILIN_RE__.secretKey==="string"?window.__FEILIN_RE__.secretKey.slice(0,120):window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.secretKey,120):null,reRegion:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.region,80):null,rePrefix:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.prefix,80):null,reDeviceDataKeys:window.__FEILIN_RE__&&window.__FEILIN_RE__.deviceData&&typeof window.__FEILIN_RE__.deviceData==="object"?Object.keys(window.__FEILIN_RE__.deviceData).slice(0,20):null,reDeviceConfigKeys:window.__FEILIN_RE__&&window.__FEILIN_RE__.deviceConfig&&typeof window.__FEILIN_RE__.deviceConfig==="object"?Object.keys(window.__FEILIN_RE__.deviceConfig).slice(0,20):null,reDeviceDataUrl:window.__FEILIN_RE__&&window.__FEILIN_RE__.deviceData?previewValue(window.__FEILIN_RE__.deviceData.dfghfgdh6,120):null,reDeviceConfigSession:window.__FEILIN_RE__&&window.__FEILIN_RE__.deviceConfig?previewValue(window.__FEILIN_RE__.deviceConfig.sessionId,120):null,locationHref:typeof location!=="undefined"&&location?previewValue(location.href,160):null,documentCookie:typeof document!=="undefined"&&document?previewValue(document.cookie,160):null,localStorageKeys:typeof localStorage!=="undefined"&&localStorage&&typeof localStorage.length==="number"?(function(){var __keys=[];for(var __i=0;__i<localStorage.length&&__i<20;__i++)try{__keys.push(localStorage.key(__i))}catch(__e){}return __keys})():null,stack:String((new Error("FEILIN_UB_ARG100_ENTER")).stack||"").slice(0,1200)});window.__FEILIN_UB_ARG100_LOGS__.length>80&&window.__FEILIN_UB_ARG100_LOGS__.shift()}catch(__ubArg100Err){}}',
  );
  patched = patched.replace(
    'o>=1?116===N?n-=602:n+=-360:!V*!Math/(!Math*!V)==0?n=127:n+=-1262}}return e}',
    'o>=1?116===N?n-=602:n+=-360:!V*!Math/(!Math*!V)==0?n=127:n+=-1262}}try{window.__FEILIN_UB_LOGS__=window.__FEILIN_UB_LOGS__||[];window.__FEILIN_UB_LOGS__.push({stage:"return",arg0:typeof t==="string"?t.slice(0,200):t,arg1:typeof r==="string"?r.slice(0,200):r,returnType:typeof e,returnValue:typeof e==="string"?e.slice(0,400):previewValue(e,400),returnKeys:e&&typeof e==="object"?Object.keys(e).slice(0,20):null});if(t===100){window.__FEILIN_UB_ARG100_LOGS__=window.__FEILIN_UB_ARG100_LOGS__||[];window.__FEILIN_UB_ARG100_LOGS__.push({stage:"return",arg0:t,returnType:typeof e,returnValue:typeof e==="string"?e.slice(0,400):previewValue(e,200),returnKeys:e&&typeof e==="object"?Object.keys(e).slice(0,20):null,stack:String((new Error("FEILIN_UB_ARG100_RETURN")).stack||"").slice(0,1200)});window.__FEILIN_UB_ARG100_LOGS__.length>80&&window.__FEILIN_UB_ARG100_LOGS__.shift()}}catch(_e){}return e}catch(__ubErr){try{window.__FEILIN_UB_ERROR_LOGS__=window.__FEILIN_UB_ERROR_LOGS__||[];window.__FEILIN_UB_ERROR_LOGS__.push({arg0:typeof __ubArg0==="string"?__ubArg0.slice(0,200):__ubArg0,arg1Type:typeof __ubArg1,arg1Preview:typeof __ubArg1==="string"?__ubArg1.slice(0,200):previewValue(__ubArg1,120),thisType:typeof __ubThis,thisKeys:__ubThis&&typeof __ubThis==="object"?Object.keys(__ubThis).slice(0,20):null,error:String(__ubErr&&__ubErr.stack||__ubErr),reKeys:window.__FEILIN_RE__&&typeof window.__FEILIN_RE__==="object"?Object.keys(window.__FEILIN_RE__).slice(0,30):null,reSessionId:window.__FEILIN_RE__&&typeof window.__FEILIN_RE__.sessionId==="string"?window.__FEILIN_RE__.sessionId.slice(0,120):window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.sessionId,120):null,reSecretKey:window.__FEILIN_RE__&&typeof window.__FEILIN_RE__.secretKey==="string"?window.__FEILIN_RE__.secretKey.slice(0,120):window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.secretKey,120):null,reDeviceDataKeys:window.__FEILIN_RE__&&window.__FEILIN_RE__.deviceData&&typeof window.__FEILIN_RE__.deviceData==="object"?Object.keys(window.__FEILIN_RE__.deviceData).slice(0,20):null,reDeviceConfigKeys:window.__FEILIN_RE__&&window.__FEILIN_RE__.deviceConfig&&typeof window.__FEILIN_RE__.deviceConfig==="object"?Object.keys(window.__FEILIN_RE__.deviceConfig).slice(0,20):null,reDeviceDataUrl:window.__FEILIN_RE__&&window.__FEILIN_RE__.deviceData?previewValue(window.__FEILIN_RE__.deviceData.dfghfgdh6,120):null,reDeviceConfigSession:window.__FEILIN_RE__&&window.__FEILIN_RE__.deviceConfig?previewValue(window.__FEILIN_RE__.deviceConfig.sessionId,120):null,locationHref:typeof location!=="undefined"&&location?previewValue(location.href,160):null,documentCookie:typeof document!=="undefined"&&document?previewValue(document.cookie,160):null,stack:String((new Error("FEILIN_UB_THROW")).stack||"").slice(0,1200)});window.__FEILIN_UB_ERROR_LOGS__.length>80&&window.__FEILIN_UB_ERROR_LOGS__.shift()}catch(__ubErr2){}throw __ubErr}}window.__FEILIN_UB__=ub;',
  );
  patched = patched.replace(
    'function uY(){',
    'function uY(){window.__FEILIN_UY_LOGS__=window.__FEILIN_UY_LOGS__||[];window.__FEILIN_UY_LOGS__.push({stage:"enter",stack:String((new Error("FEILIN_UY")).stack||"").slice(0,1200)});',
  );
  patched = patched.replace(
    'r=4,n=ub[e.call(6,30,148)](this,100)',
    'r=4,n=function(){var __uyUbKey=e.call(6,30,148),__uyObj=ub[__uyUbKey](this,100);try{window.__FEILIN_UY_LOGS__=window.__FEILIN_UY_LOGS__||[];window.__FEILIN_UY_LOGS__.push({stage:"after-ub",ubKey:__uyUbKey,nType:typeof __uyObj,nKeys:__uyObj&&typeof __uyObj==="object"?Object.keys(__uyObj).slice(0,20):null,nSource:typeof __uyObj==="function"?String(__uyObj).slice(0,400):null});}catch(_e){}return __uyObj}.call(this)',
  );
  patched = patched.replace(
    't=n[e(73,64)](this,arguments),r-=1',
    't=function(){var __uyCallKey=e(73,64),__uyCallable=n[__uyCallKey];try{window.__FEILIN_UY_LOGS__=window.__FEILIN_UY_LOGS__||[];window.__FEILIN_UY_LOGS__.push({stage:"before-call",callKey:__uyCallKey,callableType:typeof __uyCallable,callableSource:typeof __uyCallable==="function"?String(__uyCallable).slice(0,400):null});}catch(_e){}return __uyCallable.call(n,this,arguments)}.call(this),r-=1',
  );
  patched = patched.replace(
    'return t}function uJ(){',
    'try{window.__FEILIN_UY_LOGS__=window.__FEILIN_UY_LOGS__||[];window.__FEILIN_UY_LOGS__.push({stage:"return",value:typeof t==="string"?t.slice(0,400):t});}catch(_e){}return t}window.__FEILIN_UY__=uY;function uJ(){',
  );
  patched = patched.replace(
    'function st(){',
    'function st(){window.__FEILIN_ST_LOGS__=window.__FEILIN_ST_LOGS__||[];window.__FEILIN_ST_LOGS__.push({stage:"enter",stack:String((new Error("FEILIN_ST")).stack||"").slice(0,1200)});',
  );
  patched = patched.replace(
    'function uU(){',
    'function uU(){window.__FEILIN_UU_LOGS__=window.__FEILIN_UU_LOGS__||[];window.__FEILIN_UU_LOGS__.push({stage:"enter",stack:String((new Error("FEILIN_UU")).stack||"").slice(0,1200)});',
  );
  patched = patched.replace(
    'return t}function uN(){',
    'try{window.__FEILIN_UU_LOGS__=window.__FEILIN_UU_LOGS__||[];window.__FEILIN_UU_LOGS__.push({stage:"return",value:typeof t==="string"?t.slice(0,400):t});}catch(_e){}return t}window.__FEILIN_UU__=uU;function uN(){',
  );
  patched = patched.replace(
    'function u$(){',
    'function u$(){window.__FEILIN_U_DOLLAR_LOGS__=window.__FEILIN_U_DOLLAR_LOGS__||[];window.__FEILIN_U_DOLLAR_LOGS__.push({stage:"enter",stack:String((new Error("FEILIN_U_DOLLAR")).stack||"").slice(0,1200)});',
  );
  patched = patched.replace(
    'return t}function u1(){',
    'try{window.__FEILIN_U_DOLLAR_LOGS__=window.__FEILIN_U_DOLLAR_LOGS__||[];window.__FEILIN_U_DOLLAR_LOGS__.push({stage:"return",value:typeof t==="string"?t.slice(0,400):t});}catch(_e){}return t}window.__FEILIN_U_DOLLAR__=u$;function u1(){',
  );
  patched = patched.replace(
    's=uY(),r^=116',
    's=uY(),window.__FEILIN_ST_LOGS__=window.__FEILIN_ST_LOGS__||[],window.__FEILIN_ST_LOGS__.push({stage:"after-uY",sPreview:typeof s==="string"?s.slice(0,400):s,stack:String((new Error("FEILIN_ST_AFTER_UY")).stack||"").slice(0,1200)}),r^=116',
  );
  patched = patched.replace(
    'function u$(){window.__FEILIN_U_DOLLAR_LOGS__=window.__FEILIN_U_DOLLAR_LOGS__||[];window.__FEILIN_U_DOLLAR_LOGS__.push({stage:"enter",stack:String((new Error("FEILIN_U_DOLLAR")).stack||"").slice(0,1200)});',
    'function u$(){window.__FEILIN_U_DOLLAR_LOGS__=window.__FEILIN_U_DOLLAR_LOGS__||[];window.__FEILIN_U_DOLLAR_LOGS__.push({stage:"enter",stack:String((new Error("FEILIN_U_DOLLAR")).stack||"").slice(0,1200)});',
  );
  patched = patched.replace(
    'function st(){window.__FEILIN_ST_LOGS__=window.__FEILIN_ST_LOGS__||[];window.__FEILIN_ST_LOGS__.push({stage:"enter",stack:String((new Error("FEILIN_ST")).stack||"").slice(0,1200)});',
    'function st(){window.__FEILIN_ST_LOGS__=window.__FEILIN_ST_LOGS__||[];window.__FEILIN_ST_LOGS__.push({stage:"enter",stack:String((new Error("FEILIN_ST")).stack||"").slice(0,1200)});window.__FEILIN_ST__=st;',
  );
  patched = patched.replace(
    'B.E=function(t){return t()}',
    'B.E=function(t){window.__FEILIN_BE_LOGS__=window.__FEILIN_BE_LOGS__||[];var __beOut=t();try{window.__FEILIN_BE_LOGS__.push({calleeSource:typeof t==="function"?String(t).slice(0,400):typeof t,output:typeof __beOut==="string"?__beOut.slice(0,400):__beOut,stack:String((new Error("FEILIN_BE")).stack||"").slice(0,1200)});}catch(_e){}return __beOut}',
  );
  patched = patched.replace(
    'function ts(t,e,r,i,a,o){',
    'function ts(t,e,r,i,a,o){if(74===t)try{window.__PE_TS74_LOGS__=window.__PE_TS74_LOGS__||[],window.__PE_TS74_LOGS__.push({argc:arguments.length,arg0:t,arg1:typeof e==="string"?e.slice(0,400):previewValue(e,240),arg2:typeof r==="string"?r.slice(0,800):previewValue(r,320),stack:String((new Error("PE_TS74")).stack||"").slice(0,1200)}),window.__PE_TS74_LOGS__.length>80&&window.__PE_TS74_LOGS__.shift()}catch(_e){}if(75===t)try{window.__PE_TS75_LOGS__=window.__PE_TS75_LOGS__||[],window.__PE_TS75_LOGS__.push({argc:arguments.length,arg0:t,arg1:typeof e==="string"?e.slice(0,400):previewValue(e,240),arg2:typeof r==="string"?r.slice(0,800):previewValue(r,320),stack:String((new Error("PE_TS75")).stack||"").slice(0,1200)}),window.__PE_TS75_LOGS__.length>80&&window.__PE_TS75_LOGS__.shift()}catch(_e){}',
  );
  patched = patched.replace(
    'function rS(t,r){var e,n,i,a;for(n=1;n;)n>=1&&(n<3?n<=1?(n=2,i=function(t,r){return(-ri?5:ri)(t- -2,r)}):(a=ra[i([29,i()][0],[13,i()][0])](this,20),n^=1):(n+=-3,e=a[i.bind(9,26,6)()](this,arguments)));return e}',
    'function rS(t,r){var e,n,i,a;for(n=1;n;)n>=1&&(n<3?n<=1?(n=2,i=function(t,r){return(-ri?5:ri)(t- -2,r)}):(a=(function(__rsThis,__rsArg0,__rsArg1){var __rsRaKey=i([29,i()][0],[13,i()][0]),__rsRaMethod=ra&&ra[__rsRaKey],__rsSelected=__rsRaMethod.call(ra,__rsThis,20);window.__FEILIN_RS_SELECTOR_LOGS__=window.__FEILIN_RS_SELECTOR_LOGS__||[];try{window.__FEILIN_RS_SELECTOR_LOGS__.push({stage:"select-ra20",raType:typeof ra,raName:ra&&ra.name?ra.name:null,raLength:ra&&typeof ra.length==="number"?ra.length:null,raSource:typeof ra==="function"?String(ra).slice(0,400):previewValue(ra,240),raKey:__rsRaKey,raMethodType:typeof __rsRaMethod,raMethodIsNativeBind:__rsRaMethod===Function.prototype.bind,raMethodSource:typeof __rsRaMethod==="function"?String(__rsRaMethod).slice(0,400):null,outType:typeof __rsSelected,outSource:typeof __rsSelected==="function"?String(__rsSelected).slice(0,400):previewValue(__rsSelected,240),thisType:typeof __rsThis,thisKeys:__rsThis&&typeof __rsThis==="object"?Object.keys(__rsThis).slice(0,20):null,arg0:typeof __rsArg0==="string"?__rsArg0.slice(0,160):previewValue(__rsArg0,120),arg1Length:typeof __rsArg1==="string"?__rsArg1.length:null,arg1Head:typeof __rsArg1==="string"?__rsArg1.slice(0,280):previewValue(__rsArg1,160),stack:String((new Error("FEILIN_RS_SELECT_RA20")).stack||"").slice(0,1200)});window.__FEILIN_RS_SELECTOR_LOGS__.length>200&&window.__FEILIN_RS_SELECTOR_LOGS__.shift()}catch(_e){}return __rsSelected})(this,t,r),window.__FEILIN_RS_FN_IDS__=window.__FEILIN_RS_FN_IDS__||new WeakMap,window.__FEILIN_RS_FN_SEQ__=window.__FEILIN_RS_FN_SEQ__||0,window.__FEILIN_RS_FN_REGISTRY__=window.__FEILIN_RS_FN_REGISTRY__||{},typeof a==="function"&&!window.__FEILIN_RS_FN_IDS__.has(a)&&window.__FEILIN_RS_FN_IDS__.set(a,++window.__FEILIN_RS_FN_SEQ__),typeof a==="function"&&window.__FEILIN_RS_FN_IDS__&&(window.__FEILIN_RS_FN_REGISTRY__[window.__FEILIN_RS_FN_IDS__.get(a)]=a),window.__FEILIN_RS_LAST_A__=a,window.__FEILIN_RS_INNER_LOGS__=window.__FEILIN_RS_INNER_LOGS__||[],window.__FEILIN_RS_INNER_LOGS__.push({stage:"after-ra20",aType:typeof a,aId:typeof a==="function"?window.__FEILIN_RS_FN_IDS__.get(a):null,aKeys:a&&typeof a==="object"?Object.keys(a).slice(0,20):null,aSource:typeof a==="function"?String(a).slice(0,400):null,thisType:typeof this,thisKeys:this&&typeof this==="object"?Object.keys(this).slice(0,20):null,arg0:typeof t==="string"?t.slice(0,160):t,arg1Length:typeof r==="string"?r.length:null,arg1Head:typeof r==="string"?r.slice(0,280):r,stack:String((new Error("FEILIN_RS_AFTER_RA20")).stack||"").slice(0,1200)}),n^=1):(n+=-3,e=(function(__rsThis,__rsArgs){var __rsMethodKey=i.bind(9,26,6)(),__rsMethod=a&&a[__rsMethodKey];try{window.__FEILIN_RS_INNER_LOGS__=window.__FEILIN_RS_INNER_LOGS__||[];window.__FEILIN_RS_INNER_LOGS__.push({stage:"before-method",aId:typeof a==="function"&&window.__FEILIN_RS_FN_IDS__?window.__FEILIN_RS_FN_IDS__.get(a):null,methodKey:__rsMethodKey,methodType:typeof __rsMethod,methodSource:typeof __rsMethod==="function"?String(__rsMethod).slice(0,400):null,arg0:__rsArgs&&typeof __rsArgs[0]==="string"?__rsArgs[0].slice(0,160):previewValue(__rsArgs&&__rsArgs[0],120),arg1Length:__rsArgs&&typeof __rsArgs[1]==="string"?__rsArgs[1].length:null,arg1Head:__rsArgs&&typeof __rsArgs[1]==="string"?__rsArgs[1].slice(0,280):previewValue(__rsArgs&&__rsArgs[1],160),stack:String((new Error("FEILIN_RS_BEFORE_METHOD")).stack||"").slice(0,1200)});}catch(_e){}var __rsOut;try{__rsOut=__rsMethod.call(a,__rsThis,__rsArgs)}catch(__rsApplyErr){try{window.__FEILIN_RS_INNER_LOGS__=window.__FEILIN_RS_INNER_LOGS__||[];window.__FEILIN_RS_INNER_LOGS__.push({stage:"method-throw",aId:typeof a==="function"&&window.__FEILIN_RS_FN_IDS__?window.__FEILIN_RS_FN_IDS__.get(a):null,methodKey:__rsMethodKey,error:String(__rsApplyErr&&__rsApplyErr.stack||__rsApplyErr),stack:String((new Error("FEILIN_RS_METHOD_THROW")).stack||"").slice(0,1200)})}catch(_e){}throw __rsApplyErr}try{window.__FEILIN_RS_INNER_LOGS__=window.__FEILIN_RS_INNER_LOGS__||[];window.__FEILIN_RS_INNER_LOGS__.push({stage:"after-method",aId:typeof a==="function"&&window.__FEILIN_RS_FN_IDS__?window.__FEILIN_RS_FN_IDS__.get(a):null,methodKey:__rsMethodKey,methodType:typeof __rsMethod,methodSource:typeof __rsMethod==="function"?String(__rsMethod).slice(0,400):null,outType:typeof __rsOut,outPreview:typeof __rsOut==="string"?__rsOut.slice(0,400):previewValue(__rsOut,240),stack:String((new Error("FEILIN_RS_AFTER_METHOD")).stack||"").slice(0,1200)});}catch(_e){}return __rsOut})(this,arguments)));return e}',
  );
  patched = patched.replace(
    'function rx(t,r){function e(t,r){return ri.bind(8,t-2,r)()}return ra[e.call(5,33,13)](this,19)[e(-e?2:30,-e?8:6)](this,arguments)}',
    'window.__PE_TS_FN__=ts;(function(){var __orig=ts;ts=function(){var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{var __tag=__args[0]===74?"ts74":__args[0]===75?"ts75":null;if(__tag){window.__PE_TS_RETURN_LOGS__=window.__PE_TS_RETURN_LOGS__||[];window.__PE_TS_RETURN_LOGS__.push({tag:__tag,argc:__args.length,arg0:__args[0],arg1:typeof __args[1]==="string"?__args[1].slice(0,400):previewValue(__args[1],240),arg2:typeof __args[2]==="string"?__args[2].slice(0,800):previewValue(__args[2],320),outputType:typeof __out,outputPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,320),outputLength:typeof __out==="string"?__out.length:null,outputDecodedBytes:typeof __out==="string"&&/^[A-Za-z0-9+/=]+$/.test(__out)?(function(){try{return Buffer.from(__out,"base64").length}catch(_e){return null}})():null,stack:String((new Error("PE_TS_RETURN")).stack||"").slice(0,1200)});if(window.__PE_TS_RETURN_LOGS__.length>160)window.__PE_TS_RETURN_LOGS__.shift()}}catch(_e){}return __out};window.__PE_TS_FN__=ts})();function rx(t,r){window.__FEILIN_RX_LOGS__=window.__FEILIN_RX_LOGS__||[];function e(t,r){return ri.bind(8,t-2,r)()}var __rxOut=ra[e.call(5,33,13)](this,19)[e(-e?2:30,-e?8:6)](this,arguments);try{window.__FEILIN_RX_LAST_THIS__=this;window.__FEILIN_RX_LOGS__.push({arg0:typeof t==="string"?t.slice(0,300):t,arg1:typeof r==="string"?r.slice(0,300):r,arg1Decoded:typeof r==="string"?decodeBase64Utf8(r,300):null,output:typeof __rxOut==="string"?__rxOut.slice(0,300):__rxOut,thisType:typeof this,thisKeys:this&&typeof this==="object"?Object.keys(this).slice(0,20):null,stack:String((new Error("FEILIN_RX")).stack||"").slice(0,1200)});if(window.__FEILIN_RX_LOGS__.length>120)window.__FEILIN_RX_LOGS__.shift()}catch(_e){}return __rxOut}',
  );
  patched = patched.replace(
    'return o?i=o:(i=nd.dX(i,r),t[n]=i),i}})(t,n)}',
    'return o?i=o:(i=nd.dX(i,r),t[n]=i),window.__STRING_DECODER_LOGS__=window.__STRING_DECODER_LOGS__||[],window.__STRING_DECODER_LOGS__.push({decoder:"nd",index:n,key:r,output:typeof i==="string"?i.slice(0,1200):i,outputLength:typeof i==="string"?i.length:null,stack:String((new Error("DECODER_ND")).stack||"").slice(0,1200)}),window.__STRING_DECODER_LOGS__.length>400&&window.__STRING_DECODER_LOGS__.shift(),i}})(t,n)}',
  );
  patched = patched.replace(
    'return o?i=o:(i=ng.IR(i,r),t[n]=i),i}})(t,n)}',
    'return o?i=o:(i=ng.IR(i,r),t[n]=i),window.__STRING_DECODER_LOGS__=window.__STRING_DECODER_LOGS__||[],window.__STRING_DECODER_LOGS__.push({decoder:"ng",index:n,key:r,output:typeof i==="string"?i.slice(0,1200):i,outputLength:typeof i==="string"?i.length:null,stack:String((new Error("DECODER_NG")).stack||"").slice(0,1200)}),window.__STRING_DECODER_LOGS__.length>400&&window.__STRING_DECODER_LOGS__.shift(),i}})(t,n)}',
  );
  patched = patched.replace(
    'function rI(t){',
    'window.__FEILIN_RA__=typeof ra!=="undefined"?ra:void 0;if(typeof rk!=="undefined"&&rk&&typeof rk==="object"&&!rk.__probe_wrapped__){try{rk=new Proxy(rk,{get:function(target,prop,receiver){var value=Reflect.get(target,prop,receiver);try{window.__FEILIN_RK_ACCESS_LOGS__=window.__FEILIN_RK_ACCESS_LOGS__||[];window.__FEILIN_RK_ACCESS_LOGS__.push({prop:String(prop),value:typeof value==="string"?value.slice(0,300):value,stack:String((new Error("FEILIN_RK_GET")).stack||"").slice(0,1200)});window.__FEILIN_RK_ACCESS_LOGS__.length>200&&window.__FEILIN_RK_ACCESS_LOGS__.shift()}catch(_e){}return value;}});try{rk.__probe_wrapped__=!0}catch(_e){}}catch(_e){}}window.__FEILIN_RK__=typeof rk!=="undefined"?rk:void 0;window.__FEILIN_RM__=typeof rM!=="undefined"?rM:void 0;window.__FEILIN_RO__=typeof rO!=="undefined"?rO:void 0;window.__FEILIN_RU__=typeof rU!=="undefined"?rU:void 0;window.__FEILIN_RN__=typeof rN!=="undefined"?rN:void 0;window.__FEILIN_RX__=typeof rx==="function"?rx:void 0;if(typeof rS==="function"){var __feilinOriginalRS__=rS;window.__FEILIN_RS_ORIGINAL__=__feilinOriginalRS__;rS=function(t,r){window.__FEILIN_RS_LAST_THIS__=this;var __rsInnerStart=Array.isArray(window.__FEILIN_RS_INNER_LOGS__)?window.__FEILIN_RS_INNER_LOGS__.length:0;var __rsOut=__feilinOriginalRS__.apply(this,arguments);try{var __rsString=null;try{__rsString=typeof __rsOut==="string"?__rsOut:String(__rsOut)}catch(__rsErr){__rsString=null}var __rsDetails=typeof window.captureRsOutputDetails==="function"?window.captureRsOutputDetails(__rsOut):null;var __rsInnerDelta=(window.__FEILIN_RS_INNER_LOGS__||[]).slice(__rsInnerStart);window.__FEILIN_RS_LOGS__=window.__FEILIN_RS_LOGS__||[];window.__FEILIN_RS_LOGS__.push(Object.assign({thisType:typeof this,thisCtor:this&&this.constructor&&this.constructor.name?this.constructor.name:null,thisKeys:this&&typeof this==="object"?Object.keys(this).slice(0,20):null,arg0:typeof t==="string"?t.slice(0,600):t,arg1:typeof r==="string"?r.slice(0,1200):r,arg1Length:typeof r==="string"?r.length:null,arg1Decoded:typeof r==="string"?decodeBase64Utf8(r,400):null,outputType:typeof __rsOut,outputKeys:__rsOut&&typeof __rsOut==="object"?Object.keys(__rsOut).slice(0,20):null,output:typeof __rsOut==="string"?__rsOut.slice(0,1200):__rsOut&&typeof __rsOut==="object"?{tag:Object.prototype.toString.call(__rsOut),keys:Object.keys(__rsOut).slice(0,20)}:__rsOut,outputString:typeof __rsString==="string"?__rsString.slice(0,1200):null,outputStringLength:typeof __rsString==="string"?__rsString.length:null,outputDecoded:typeof __rsString==="string"?decodeBase64Utf8(__rsString,400):null,innerLogCount:__rsInnerDelta.length,innerStages:__rsInnerDelta.map(function(x){return x&&x.stage?x.stage:null}).slice(0,12),innerAIds:[].concat.apply([],__rsInnerDelta.map(function(x){return x&&x.aId!=null?[x.aId]:[]})).slice(0,12),innerThrow:__rsInnerDelta.find(function(x){return x&&x.stage==="method-throw"})||null,lastAId:(function(){for(var __i=__rsInnerDelta.length-1;__i>=0;__i-=1){if(__rsInnerDelta[__i]&&__rsInnerDelta[__i].aId!=null)return __rsInnerDelta[__i].aId}return null})(),stack:String((new Error("FEILIN_RS")).stack||"").slice(0,1200)},__rsDetails||{}));if(window.__FEILIN_RS_LOGS__.length>160)window.__FEILIN_RS_LOGS__.shift()}catch(_e){}return __rsOut};window.__FEILIN_RS__=rS}else window.__FEILIN_RS__=void 0;function rI(t){',
  );
  patched = patched.replace(
    'g=[Z,tA,v,tn,B][tU.apply(4,[34,15])](ia)',
    'g=[Z,tA,v,tn,B][tU.apply(4,[34,15])](ia),window.__N0_G_LOGS__=window.__N0_G_LOGS__||[],window.__N0_G_LOGS__.push({separator:ia,parts:[typeof Z==="string"?Z.slice(0,300):Z,typeof tA==="string"?tA.slice(0,300):tA,typeof v==="string"?v.slice(0,300):v,typeof tn==="string"?tn.slice(0,300):tn,typeof B==="string"?B.slice(0,300):B],output:typeof g==="string"?g.slice(0,800):g,stack:String((new Error("N0_G")).stack||"").slice(0,1200)})',
  );
  patched = patched.replace(
    'm=U.i(n4,th),o+=19',
    'm=(function(){var __n0MOut=U.i(n4,th);window.__N0_PART_LOGS__=window.__N0_PART_LOGS__||[];window.__N0_PART_LOGS__.push({name:"m",thPreview:typeof th==="string"?th.slice(0,500):th,n4Type:typeof n4,n4Source:typeof n4==="function"?String(n4).slice(0,300):null,mType:typeof __n0MOut,mPreview:typeof __n0MOut==="string"?__n0MOut.slice(0,300):__n0MOut,mHexPreview:typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(__n0MOut,64):null,stack:String((new Error("N0_m")).stack||"").slice(0,1200)});return __n0MOut})(),o+=19',
  );
  patched = patched.replace(
    'B=m[tU(31*(1|tU),34/(1|tU))](),o-=23',
    'B=function(){var __n0BKey=tU(31*(1|tU),34/(1|tU)),__n0BMethod=m[__n0BKey],__n0BOut=__n0BMethod(),__n0BHex=typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(m,64):null;if((__n0BOut===""||__n0BOut==null)&&__n0BHex)__n0BOut=__n0BHex;window.__N0_PART_LOGS__=window.__N0_PART_LOGS__||[];window.__N0_PART_LOGS__.push({name:"B",key:__n0BKey,value:typeof __n0BOut==="string"?__n0BOut.slice(0,300):__n0BOut,mType:typeof m,mPreview:typeof m==="string"?m.slice(0,300):m,mHexPreview:__n0BHex,methodType:typeof __n0BMethod,methodSource:typeof __n0BMethod==="function"?String(__n0BMethod).slice(0,300):null,stack:String((new Error("N0_B")).stack||"").slice(0,1200)});return __n0BOut}(),o-=23',
  );
  patched = patched.replace(
    'tA=rx(tr,C)',
    'tA=rx(tr,C),window.__N0_PART_LOGS__=window.__N0_PART_LOGS__||[],window.__N0_PART_LOGS__.push({name:"tA",value:typeof tA==="string"?tA.slice(0,300):tA,trPreview:typeof tr==="string"?tr.slice(0,300):tr,CPreview:typeof C==="string"?C.slice(0,300):C,CDecoded:typeof C==="string"?decodeBase64Utf8(C,300):null,stack:String((new Error("N0_tA")).stack||"").slice(0,1200)})',
  );
  patched = patched.replace(
    'v=rS(x,l)',
    'v=rS(x,l),window.__N0_PART_LOGS__=window.__N0_PART_LOGS__||[],window.__N0_PART_LOGS__.push({name:"v",value:typeof v==="string"?v.slice(0,300):v,xPreview:typeof x==="string"?x.slice(0,300):x,lPreview:typeof l==="string"?l.slice(0,2000):l,lLength:typeof l==="string"?l.length:null,stack:String((new Error("N0_v")).stack||"").slice(0,1200)})',
  );
  patched = patched.replace(
    'O={secretKey:rS(re[ti],w[(~N?N:6)(50,51)]),sessionId:c.H(rS,re[j+"EC"],w[c.c(K,"d")])}',
    'O=(window.__FEILIN_DERIVE_SECRET_BLOB__=window.__FEILIN_DERIVE_SECRET_BLOB__||function(secretSeed,sessionSecret){try{return rS(secretSeed,sessionSecret)}catch(_e){return null}},window.__FEILIN_DERIVE_SESSION_BLOB__=window.__FEILIN_DERIVE_SESSION_BLOB__||function(sessionSeed,sessionPlain){try{return c.H(rS,sessionSeed,sessionPlain)}catch(_e){return null}},window.__FEILIN_SESSION_DERIVE_LOGS__=window.__FEILIN_SESSION_DERIVE_LOGS__||[],window.__FEILIN_SESSION_DERIVE_LOGS__.push({reSecretPreview:typeof re[ti]==="string"?re[ti].slice(0,200):re[ti],reSessionPreview:typeof re[j+"EC"]==="string"?re[j+"EC"].slice(0,200):re[j+"EC"],wSecretPreview:typeof w[(~N?N:6)(50,51)]==="string"?w[(~N?N:6)(50,51)].slice(0,200):w[(~N?N:6)(50,51)],wSessionPreview:typeof w[c.c(K,"d")] ==="string"?w[c.c(K,"d")].slice(0,200):w[c.c(K,"d")],stack:String((new Error("FEILIN_SESSION_DERIVE")).stack||"").slice(0,1200)}),{secretKey:rS(re[ti],w[(~N?N:6)(50,51)]),sessionId:c.H(rS,re[j+"EC"],w[c.c(K,"d")])}),window.__FEILIN_LAST_SESSION_DERIVE__=O',
  );
  patched = patched.replace(
    'y=iu(S,null,null,D)',
    'y=iu(S,null,null,D),window.__TOKEN_PATH_LOGS__=window.__TOKEN_PATH_LOGS__||[],window.__TOKEN_PATH_LOGS__.push({type:"iu-callsite",sKeys:S&&typeof S==="object"?Object.keys(S).slice(0,40):null,sPreview:S&&typeof S==="object"?Object.fromEntries(Object.keys(S).slice(0,20).map(function(k){var v=S[k];return[k,typeof v==="string"?v.slice(0,400):v]})):S,dPreview:typeof D==="string"?D.slice(0,400):D,yPreview:typeof y==="string"?y.slice(0,400):y,stack:String((new Error("IU_CALLSITE")).stack||"").slice(0,1200)})',
  );
  patched = patched.replace(
    'u=re[m.U(f,"ts")]',
    'u=re[m.U(f,"ts")],window.__EXTEND_CONSUME_LOGS__=window.__EXTEND_CONSUME_LOGS__||[],window.__EXTEND_CONSUME_LOGS__.push({stage:"base",arg:t,uKeys:u&&typeof u==="object"?Object.keys(u).slice(0,60):null,uPreview:u&&typeof u==="object"?Object.fromEntries(Object.keys(u).slice(0,20).map(function(k){var v=u[k];return[k,typeof v==="string"?v.slice(0,200):v]})):u,stack:String((new Error("EXT_BASE")).stack||"").slice(0,1200)})',
  );
  patched = patched.replace(
    'c=u[t]',
    'c=u[t],window.__EXTEND_CONSUME_LOGS__=window.__EXTEND_CONSUME_LOGS__||[],window.__EXTEND_CONSUME_LOGS__.push({stage:"access",arg:t,cType:typeof c,cPreview:typeof c==="string"?c.slice(0,400):c&&typeof c==="object"?Object.keys(c).slice(0,40):c,stack:String((new Error("EXT_ACCESS")).stack||"").slice(0,1200)})',
  );
  patched = patched.replace(
    's=si(c)[(a&&a)(36,104)]()',
    's=si(c)[(a&&a)(36,104)](),window.__EXTEND_CONSUME_LOGS__=window.__EXTEND_CONSUME_LOGS__||[],window.__EXTEND_CONSUME_LOGS__.push({stage:"decode",arg:t,sType:typeof s,sPreview:typeof s==="string"?s.slice(0,400):s,stack:String((new Error("EXT_DECODE")).stack||"").slice(0,1200)})',
  );
  patched = patched.replace(
    'w=c.t(io,d,l),n=26',
    'w=c.t(io,d,l),window.__TOKEN_PATH_LOGS__=window.__TOKEN_PATH_LOGS__||[],window.__TOKEN_PATH_LOGS__.push({type:"io-callsite",tKeys:t&&typeof t==="object"?Object.keys(t).slice(0,40):null,dPreview:typeof d==="string"?d.slice(0,400):d,lPreview:typeof l==="string"?l.slice(0,400):l,hPreview:typeof h==="string"?h.slice(0,400):h,pPreview:typeof p==="string"?p.slice(0,400):p,wPreview:typeof w==="string"?w.slice(0,400):w,stack:String((new Error("IO_CALLSITE")).stack||"").slice(0,1200)}),n=26',
  );
  patched = patched.replace(
    '_extend:function(t){var n=this;new V(t)._each(function(t,e){n._obj[t]=e})}',
    '_extend:function(t){var n=this;window.__ALIYUN_EXTEND_ASSIGN_LOGS__=window.__ALIYUN_EXTEND_ASSIGN_LOGS__||[],window.__ALIYUN_EXTEND_ASSIGN_LOGS__.push({stage:"before",keys:t&&typeof t==="object"?Object.keys(t).slice(0,30):null,preview:t&&typeof t==="object"?Object.fromEntries(Object.keys(t).slice(0,12).map(function(k){var v=t[k];return[k,typeof v==="string"?v.slice(0,240):v&&typeof v==="object"?Object.keys(v).slice(0,12):v]})):t,stack:String((new Error("ALIYUN_EXTEND_BEFORE")).stack||"").slice(0,1200)}),new V(t)._each(function(t,e){window.__ALIYUN_EXTEND_ASSIGN_LOGS__.push({stage:"assign",key:t,value:typeof e==="string"?e.slice(0,240):e&&typeof e==="object"?Object.keys(e).slice(0,12):e,stack:String((new Error("ALIYUN_EXTEND_ASSIGN")).stack||"").slice(0,1200)}),window.__ALIYUN_EXTEND_ASSIGN_LOGS__.length>240&&window.__ALIYUN_EXTEND_ASSIGN_LOGS__.shift(),n._obj[t]=e})}',
  );
  patched = appendWrapperBefore(
    patched,
    'function tY(t,n){',
    'function tJ(){',
    ';window.__PE_TY_FN2__=tY;(function(){var __orig=tY;tY=function(){window.__PE_TY2_CALLS__=window.__PE_TY2_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_TY2_CALLS__.push({argc:__args.length,arg0:typeof __args[0]==="string"?__args[0].slice(0,400):previewValue(__args[0],300),arg1:typeof __args[1]==="string"?__args[1].slice(0,400):previewValue(__args[1],200),outputType:typeof __out,outputPreview:typeof __out==="string"?__out.slice(0,600):previewValue(__out,300),stack:String((new Error("PE_TY2")).stack||"").slice(0,1200)});if(window.__PE_TY2_CALLS__.length>120)window.__PE_TY2_CALLS__.shift()}catch(_e){}return __out};window.__PE_TY_FN2__=tY})();',
  );
  patched = appendWrapperBefore(
    patched,
    'function tD(t){',
    'var tV=navigator',
    ';window.__PE_TD_FN__=tD;(function(){var __orig=tD;tD=function(){window.__PE_TD_CALLS__=window.__PE_TD_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_TD_CALLS__.push({argc:__args.length,arg0:typeof __args[0]==="string"?__args[0].slice(0,400):previewValue(__args[0],300),arg1:typeof __args[1]==="string"?__args[1].slice(0,400):previewValue(__args[1],200),outputType:typeof __out,outputPreview:typeof __out==="string"?__out.slice(0,600):previewValue(__out,300),stack:String((new Error("PE_TD")).stack||"").slice(0,1200)});if(window.__PE_TD_CALLS__.length>120)window.__PE_TD_CALLS__.shift()}catch(_e){}return __out};window.__PE_TD_FN__=tD})();',
  );
  patched = appendWrapperBefore(
    patched,
    'function ts(t,e,r,i,a,o){',
    'function nd(t,n){',
    ';window.__PE_TS_FN__=ts;(function(){var __orig=ts;ts=function(){var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{var __tag=__args[0]===74?"ts74":__args[0]===75?"ts75":null;if(__tag){var __outDefaultString=null,__outBase64String=null,__outHexString=null,__outWordArrayBase64=null,__outWordArrayHex=null,__outSigBytes=null;try{if(__out&&typeof __out.toString==="function"){__outDefaultString=String(__out.toString());try{__outBase64String=__out.toString(cryptShim.enc.Base64)}catch(_e){}try{__outHexString=__out.toString(cryptShim.enc.Hex)}catch(_e){}}}catch(_e){}try{if(__out&&typeof __out==="object"&&Number.isFinite(__out.sigBytes)){__outSigBytes=__out.sigBytes;__outWordArrayBase64=typeof normalizeWordArray==="function"?normalizeWordArray(__out).toString("base64"):null;__outWordArrayHex=typeof wordArrayToHexPreview==="function"?wordArrayToHexPreview(__out,272):null}}catch(_e){}window.__PE_TS_RETURN_LOGS__=window.__PE_TS_RETURN_LOGS__||[];window.__PE_TS_RETURN_LOGS__.push({tag:__tag,argc:__args.length,arg0:__args[0],arg1:typeof __args[1]==="string"?__args[1].slice(0,400):previewValue(__args[1],240),arg2:typeof __args[2]==="string"?__args[2].slice(0,800):previewValue(__args[2],320),outputType:typeof __out,outputCtor:__out&&__out.constructor?String(__out.constructor.name||""):null,outputPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,320),outputLength:typeof __out==="string"?__out.length:null,outputDecodedBytes:typeof __out==="string"&&/^[A-Za-z0-9+/=]+$/.test(__out)?(function(){try{return Buffer.from(__out,"base64").length}catch(_e){return null}})():null,outputDefaultString:typeof __outDefaultString==="string"?__outDefaultString.slice(0,1200):null,outputDefaultStringLength:typeof __outDefaultString==="string"?__outDefaultString.length:null,outputBase64String:typeof __outBase64String==="string"?__outBase64String.slice(0,1200):null,outputBase64DecodedBytes:typeof __outBase64String==="string"&&/^[A-Za-z0-9+/=]+$/.test(__outBase64String)?(function(){try{return Buffer.from(__outBase64String,"base64").length}catch(_e){return null}})():null,outputHexString:typeof __outHexString==="string"?__outHexString.slice(0,1200):null,outputHexDecodedBytes:typeof __outHexString==="string"&&/^[0-9a-f]+$/i.test(__outHexString)&&__outHexString.length%2===0?__outHexString.length/2:null,outputSigBytes:__outSigBytes,outputWordArrayBase64:typeof __outWordArrayBase64==="string"?__outWordArrayBase64.slice(0,1200):null,outputWordArrayHexPreview:typeof __outWordArrayHex==="string"?__outWordArrayHex.slice(0,1200):null,outputObjectShape:typeof snapshotObjectShape==="function"?snapshotObjectShape(__out,20):null,stack:String((new Error("PE_TS_RETURN")).stack||"").slice(0,1200)});if(window.__PE_TS_RETURN_LOGS__.length>160)window.__PE_TS_RETURN_LOGS__.shift()}}catch(_e){}return __out};window.__PE_TS_FN__=ts})();',
  );
  patched = patched.replace(
    'function rx(t,r){',
    ';window.__PE_TS_FN__=ts;(function(){var __orig=ts;ts=function(){var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{var __tag=__args[0]===74?"ts74":__args[0]===75?"ts75":null;if(__tag){window.__PE_TS_RETURN_LOGS__=window.__PE_TS_RETURN_LOGS__||[];window.__PE_TS_RETURN_LOGS__.push({tag:__tag,argc:__args.length,arg0:__args[0],arg1:typeof __args[1]==="string"?__args[1].slice(0,400):previewValue(__args[1],240),arg2:typeof __args[2]==="string"?__args[2].slice(0,800):previewValue(__args[2],320),outputType:typeof __out,outputPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,320),outputLength:typeof __out==="string"?__out.length:null,outputDecodedBytes:typeof __out==="string"&&/^[A-Za-z0-9+/=]+$/.test(__out)?(function(){try{return Buffer.from(__out,"base64").length}catch(_e){return null}})():null,stack:String((new Error("PE_TS_RETURN")).stack||"").slice(0,1200)});if(window.__PE_TS_RETURN_LOGS__.length>160)window.__PE_TS_RETURN_LOGS__.shift()}}catch(_e){}return __out};window.__PE_TS_FN__=ts})();function rx(t,r){',
  );
  patched = appendWrapperBefore(
    patched,
    'function nc(t){',
    'function nu(t,n){',
    ';window.__PE_NC_FN__=nc;(function(){var __orig=nc;nc=function(){window.__PE_NC_CALLS__=window.__PE_NC_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_NC_CALLS__.push({argc:__args.length,arg0:typeof __args[0]==="string"?__args[0].slice(0,500):previewValue(__args[0],300),arg1:typeof __args[1]==="string"?__args[1].slice(0,400):previewValue(__args[1],200),outputType:typeof __out,outputPreview:typeof __out==="string"?__out.slice(0,800):previewValue(__out,300),stack:String((new Error("PE_NC")).stack||"").slice(0,1200)});if(window.__PE_NC_CALLS__.length>120)window.__PE_NC_CALLS__.shift()}catch(_e){}return __out};window.__PE_NC_FN__=nc})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function tC(t,n){',
    ['function tw(', 'var tx=', 'var tk='],
    ';window.__PE_TC_FN__=tC;(function(){if(window.__PE_TC_WRAP_V1__)return;window.__PE_TC_WRAP_V1__=1;var __orig=tC;tC=function(){window.__PE_TC_CALLS__=window.__PE_TC_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_TC_CALLS__.push({argc:__args.length,arg0:typeof __args[0]==="string"?__args[0].slice(0,500):previewValue(__args[0],300),arg1:typeof __args[1]==="string"?__args[1].slice(0,400):previewValue(__args[1],200),outputType:typeof __out,outputPreview:typeof __out==="string"?__out.slice(0,800):previewValue(__out,300),outputDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,stack:String((new Error("PE_TC")).stack||"").slice(0,1200)});if(window.__PE_TC_CALLS__.length>120)window.__PE_TC_CALLS__.shift()}catch(_e){}return __out};window.__PE_TC_FN__=tC})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function tD(t,n,e,r,i){',
    ['function tG(', 'function tR(', 'var tH=navigator'],
    ';window.__PE_TD_FN__=tD;(function(){if(window.__PE_TD_WRAP_V2__)return;window.__PE_TD_WRAP_V2__=1;var __orig=tD;tD=function(){window.__PE_TD_CALLS__=window.__PE_TD_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_TD_CALLS__.push({argc:__args.length,arg0:typeof __args[0]==="string"?__args[0].slice(0,500):previewValue(__args[0],300),arg1:typeof __args[1]==="string"?__args[1].slice(0,400):previewValue(__args[1],200),arg2:typeof __args[2]==="string"?__args[2].slice(0,400):previewValue(__args[2],200),outputType:typeof __out,outputPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,300),outputDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,stack:String((new Error("PE_TD_V2")).stack||"").slice(0,1200)});if(window.__PE_TD_CALLS__.length>120)window.__PE_TD_CALLS__.shift()}catch(_e){}return __out};window.__PE_TD_FN__=tD})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function nc(){',
    ['function nf(', 'function nl(', 'e(4261);'],
    ';window.__PE_NC_FN__=nc;(function(){if(window.__PE_NC_WRAP_V2__)return;window.__PE_NC_WRAP_V2__=1;var __orig=nc;nc=function(){window.__PE_NC_CALLS__=window.__PE_NC_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_NC_CALLS__.push({argc:__args.length,arg0:typeof __args[0]==="string"?__args[0].slice(0,500):previewValue(__args[0],300),arg1:typeof __args[1]==="string"?__args[1].slice(0,400):previewValue(__args[1],200),outputType:typeof __out,outputPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,300),outputDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,stack:String((new Error("PE_NC_V2")).stack||"").slice(0,1200)});if(window.__PE_NC_CALLS__.length>120)window.__PE_NC_CALLS__.shift()}catch(_e){}return __out};window.__PE_NC_FN__=nc})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function tu(',
    ['function tH(', 'function tK(', 'function tV(', 'function nf(', 'function nl('],
    ';window.__PE_TU_FN__=tu;(function(){if(window.__PE_TU_WRAP_V1__)return;window.__PE_TU_WRAP_V1__=1;var __orig=tu;tu=function(){window.__PE_CHAIN_CALLS__=window.__PE_CHAIN_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_CHAIN_CALLS__.push({fn:"tu",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,500):previewValue(v,220)}),outType:typeof __out,outPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,260),outDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,stack:String((new Error("PE_TU")).stack||"").slice(0,1200)});if(window.__PE_CHAIN_CALLS__.length>240)window.__PE_CHAIN_CALLS__.shift()}catch(_e){}return __out};window.__PE_TU_FN__=tu})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function tH(',
    ['function tK(', 'function tV(', 'function nf(', 'function nl(', 'function X('],
    ';window.__PE_TH_FN__=tH;(function(){if(window.__PE_TH_WRAP_V1__)return;window.__PE_TH_WRAP_V1__=1;var __orig=tH;tH=function(){window.__PE_CHAIN_CALLS__=window.__PE_CHAIN_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_CHAIN_CALLS__.push({fn:"tH",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,500):previewValue(v,220)}),outType:typeof __out,outPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,260),outDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,stack:String((new Error("PE_TH")).stack||"").slice(0,1200)});if(window.__PE_CHAIN_CALLS__.length>240)window.__PE_CHAIN_CALLS__.shift()}catch(_e){}return __out};window.__PE_TH_FN__=tH})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function tK(',
    ['function tV(', 'function nf(', 'function nl(', 'function X('],
    ';window.__PE_TK_FN__=tK;(function(){if(window.__PE_TK_WRAP_V1__)return;window.__PE_TK_WRAP_V1__=1;var __orig=tK;tK=function(){window.__PE_CHAIN_CALLS__=window.__PE_CHAIN_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_CHAIN_CALLS__.push({fn:"tK",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,500):previewValue(v,220)}),outType:typeof __out,outPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,260),outDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,stack:String((new Error("PE_TK")).stack||"").slice(0,1200)});if(window.__PE_CHAIN_CALLS__.length>240)window.__PE_CHAIN_CALLS__.shift()}catch(_e){}return __out};window.__PE_TK_FN__=tK})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function tV(',
    ['function nf(', 'function nl(', 'function X('],
    ';window.__PE_TV_FN__=tV;(function(){if(window.__PE_TV_WRAP_V1__)return;window.__PE_TV_WRAP_V1__=1;var __orig=tV;tV=function(){window.__PE_CHAIN_CALLS__=window.__PE_CHAIN_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_CHAIN_CALLS__.push({fn:"tV",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,500):previewValue(v,220)}),outType:typeof __out,outPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,260),outDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,stack:String((new Error("PE_TV")).stack||"").slice(0,1200)});if(window.__PE_CHAIN_CALLS__.length>240)window.__PE_CHAIN_CALLS__.shift()}catch(_e){}return __out};window.__PE_TV_FN__=tV})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function nf(',
    ['function nl(', 'function X(', 'function t0('],
    ';window.__PE_NF_FN__=nf;(function(){if(window.__PE_NF_WRAP_V1__)return;window.__PE_NF_WRAP_V1__=1;var __orig=nf;nf=function(){window.__PE_CHAIN_CALLS__=window.__PE_CHAIN_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_CHAIN_CALLS__.push({fn:"nf",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,500):previewValue(v,220)}),outType:typeof __out,outPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,260),outDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,stack:String((new Error("PE_NF")).stack||"").slice(0,1200)});if(window.__PE_CHAIN_CALLS__.length>240)window.__PE_CHAIN_CALLS__.shift()}catch(_e){}return __out};window.__PE_NF_FN__=nf})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function nl(',
    ['function X(', 'function t0(', 'function n0('],
    ';window.__PE_NL_FN__=nl;(function(){if(window.__PE_NL_WRAP_V1__)return;window.__PE_NL_WRAP_V1__=1;var __orig=nl;nl=function(){window.__PE_CHAIN_CALLS__=window.__PE_CHAIN_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_CHAIN_CALLS__.push({fn:"nl",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,500):previewValue(v,220)}),outType:typeof __out,outPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,260),outDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,stack:String((new Error("PE_NL")).stack||"").slice(0,1200)});if(window.__PE_CHAIN_CALLS__.length>240)window.__PE_CHAIN_CALLS__.shift()}catch(_e){}return __out};window.__PE_NL_FN__=nl})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function X(',
    ['function t0(', 'function n0(', 'function tw('],
    ';window.__PE_X_FN__=X;(function(){if(window.__PE_X_WRAP_V1__)return;window.__PE_X_WRAP_V1__=1;var __orig=X;X=function(){window.__PE_CHAIN_CALLS__=window.__PE_CHAIN_CALLS__||[];var __args=Array.prototype.slice.call(arguments);var __out=__orig.apply(this,__args);try{window.__PE_CHAIN_CALLS__.push({fn:"X",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,500):previewValue(v,220)}),outType:typeof __out,outPreview:typeof __out==="string"?__out.slice(0,1200):previewValue(__out,260),outDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,stack:String((new Error("PE_X")).stack||"").slice(0,1200)});if(window.__PE_CHAIN_CALLS__.length>240)window.__PE_CHAIN_CALLS__.shift()}catch(_e){}return __out};window.__PE_X_FN__=X})();',
  );
  const makeDirectFnTrace = (fnName) => (sentinel) => `try{window["${sentinel}"]=1;window.__PE_DIRECT_HITS__=window.__PE_DIRECT_HITS__||{};window.__PE_DIRECT_HITS__["${fnName}"]=(window.__PE_DIRECT_HITS__["${fnName}"]||0)+1;window.__PE_DIRECT_FN_CALLS__=window.__PE_DIRECT_FN_CALLS__||[];window.__PE_DIRECT_FN_CALLS__.push({fn:"${fnName}",stage:"enter",argc:arguments.length,firstArgType:typeof arguments[0],firstArgPreview:typeof arguments[0]==="string"?arguments[0].slice(0,500):String(arguments[0]),stack:String((new Error("PE_DIRECT_${fnName}")).stack||"").slice(0,1200)});if(window.__PE_DIRECT_FN_CALLS__.length>240)window.__PE_DIRECT_FN_CALLS__.shift()}catch(_e){window.__PE_DIRECT_HIT_ERRORS__=window.__PE_DIRECT_HIT_ERRORS__||[];window.__PE_DIRECT_HIT_ERRORS__.push({fn:"${fnName}",error:String(_e&&_e.stack||_e)});window.__PE_DIRECT_HIT_ERRORS__.length>120&&window.__PE_DIRECT_HIT_ERRORS__.shift()}`;
  patched = wrapNamedFunctionDeclaration(patched, 'tV', makeDirectFnTrace('tV'));
  patched = wrapNamedFunctionDeclaration(patched, 'tK', makeDirectFnTrace('tK'));
  patched = wrapNamedFunctionDeclaration(patched, 'nf', makeDirectFnTrace('nf'));
  patched = wrapNamedFunctionDeclaration(patched, 'nl', makeDirectFnTrace('nl'));
  patched = appendWrapperBeforeAny(
    patched,
    'function ub(){',
    ['function uw(', 'function ug(', 'function uq(', 'function uY('],
    ';window.__FEILIN_UB__=ub;(function(){if(window.__FEILIN_UB_WRAP_V2__)return;window.__FEILIN_UB_WRAP_V2__=1;var __orig=ub;ub=function(){window.__FEILIN_UB_LOGS__=window.__FEILIN_UB_LOGS__||[];var __args=Array.prototype.slice.call(arguments);try{window.__FEILIN_UB_LOGS__.push({stage:"wrap-enter",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,240):previewValue(v,160)}),thisType:typeof this,thisKeys:this&&typeof this==="object"?Object.keys(this).slice(0,20):null,reSessionId:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.sessionId,160):null,reSecretKey:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.secretKey,160):null,stack:String((new Error("FEILIN_UB_WRAP_ENTER")).stack||"").slice(0,1200)});if(window.__FEILIN_UB_LOGS__.length>160)window.__FEILIN_UB_LOGS__.shift()}catch(_e){}try{var __out=__orig.apply(this,__args);try{window.__FEILIN_UB_LOGS__.push({stage:"wrap-return",argc:__args.length,returnType:typeof __out,returnValue:typeof __out==="string"?__out.slice(0,400):previewValue(__out,240),returnKeys:__out&&typeof __out==="object"?Object.keys(__out).slice(0,24):null,reSessionId:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.sessionId,160):null,reSecretKey:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.secretKey,160):null,stack:String((new Error("FEILIN_UB_WRAP_RETURN")).stack||"").slice(0,1200)});if(window.__FEILIN_UB_LOGS__.length>160)window.__FEILIN_UB_LOGS__.shift()}catch(_e){}return __out}catch(__err){try{window.__FEILIN_UB_ERROR_LOGS__=window.__FEILIN_UB_ERROR_LOGS__||[];window.__FEILIN_UB_ERROR_LOGS__.push({stage:"wrap-throw",argc:__args.length,error:String(__err&&__err.stack||__err),reSessionId:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.sessionId,160):null,reSecretKey:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.secretKey,160):null,stack:String((new Error("FEILIN_UB_WRAP_THROW")).stack||"").slice(0,1200)});if(window.__FEILIN_UB_ERROR_LOGS__.length>120)window.__FEILIN_UB_ERROR_LOGS__.shift()}catch(_e){}throw __err}};window.__FEILIN_UB__=ub})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function uY(){',
    ['function uP(', 'function uj(', 'function uH(', 'function uN('],
    ';window.__FEILIN_UY__=uY;(function(){if(window.__FEILIN_UY_WRAP_V2__)return;window.__FEILIN_UY_WRAP_V2__=1;var __orig=uY;uY=function(){window.__FEILIN_UY_LOGS__=window.__FEILIN_UY_LOGS__||[];var __args=Array.prototype.slice.call(arguments);try{window.__FEILIN_UY_LOGS__.push({stage:"wrap-enter",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,240):previewValue(v,160)}),thisType:typeof this,thisKeys:this&&typeof this==="object"?Object.keys(this).slice(0,20):null,reSessionId:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.sessionId,160):null,reSecretKey:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.secretKey,160):null,stack:String((new Error("FEILIN_UY_WRAP_ENTER")).stack||"").slice(0,1200)});if(window.__FEILIN_UY_LOGS__.length>160)window.__FEILIN_UY_LOGS__.shift()}catch(_e){}try{var __out=__orig.apply(this,__args);try{window.__FEILIN_UY_LOGS__.push({stage:"wrap-return",argc:__args.length,returnType:typeof __out,returnValue:typeof __out==="string"?__out.slice(0,500):previewValue(__out,260),returnDecoded:typeof __out==="string"?decodeBase64Utf8(__out,260):null,reSessionId:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.sessionId,160):null,reSecretKey:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.secretKey,160):null,stack:String((new Error("FEILIN_UY_WRAP_RETURN")).stack||"").slice(0,1200)});if(window.__FEILIN_UY_LOGS__.length>160)window.__FEILIN_UY_LOGS__.shift()}catch(_e){}return __out}catch(__err){try{window.__FEILIN_UY_LOGS__.push({stage:"wrap-throw",argc:__args.length,error:String(__err&&__err.stack||__err),stack:String((new Error("FEILIN_UY_WRAP_THROW")).stack||"").slice(0,1200)});if(window.__FEILIN_UY_LOGS__.length>160)window.__FEILIN_UY_LOGS__.shift()}catch(_e){}throw __err}};window.__FEILIN_UY__=uY})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function rg(t,r){',
    ['function rm(', 'function rU(', 'function rC('],
    ';window.__FEILIN_RG__=rg;(function(){if(window.__FEILIN_RG_WRAP_V1__)return;window.__FEILIN_RG_WRAP_V1__=1;var __orig=rg;rg=function(){window.__FEILIN_SESSION_HELPER_LOGS__=window.__FEILIN_SESSION_HELPER_LOGS__||[];var __args=Array.prototype.slice.call(arguments);try{var __out=__orig.apply(this,__args);window.__FEILIN_SESSION_HELPER_LOGS__.push({helper:"rg",stage:"return",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,240):previewValue(v,160)}),returnType:typeof __out,returnValue:typeof __out==="string"?__out.slice(0,400):previewValue(__out,200),returnDecoded:typeof __out==="string"?decodeBase64Utf8(__out,240):null,stack:String((new Error("FEILIN_RG_WRAP")).stack||"").slice(0,1200)});if(window.__FEILIN_SESSION_HELPER_LOGS__.length>200)window.__FEILIN_SESSION_HELPER_LOGS__.shift();return __out}catch(__err){try{window.__FEILIN_SESSION_HELPER_LOGS__.push({helper:"rg",stage:"throw",argc:__args.length,error:String(__err&&__err.stack||__err),stack:String((new Error("FEILIN_RG_WRAP_THROW")).stack||"").slice(0,1200)});if(window.__FEILIN_SESSION_HELPER_LOGS__.length>200)window.__FEILIN_SESSION_HELPER_LOGS__.shift()}catch(_e){}throw __err}};window.__FEILIN_RG__=rg})();',
  );
  patched = appendWrapperBeforeAny(
    patched,
    'function rC(t,r){',
    ['function rE(', 'function rH(', 'function rq('],
    ';window.__FEILIN_RC__=rC;(function(){if(window.__FEILIN_RC_WRAP_V1__)return;window.__FEILIN_RC_WRAP_V1__=1;var __orig=rC;rC=function(){window.__FEILIN_SESSION_HELPER_LOGS__=window.__FEILIN_SESSION_HELPER_LOGS__||[];var __args=Array.prototype.slice.call(arguments);try{var __out=__orig.apply(this,__args);window.__FEILIN_SESSION_HELPER_LOGS__.push({helper:"rC",stage:"return",argc:__args.length,args:__args.map(function(v){return typeof v==="string"?v.slice(0,240):previewValue(v,160)}),returnType:typeof __out,returnValue:typeof __out==="string"?__out.slice(0,400):previewValue(__out,200),returnDecoded:typeof __out==="string"?decodeBase64Utf8(__out,240):null,stack:String((new Error("FEILIN_RC_WRAP")).stack||"").slice(0,1200)});if(window.__FEILIN_SESSION_HELPER_LOGS__.length>200)window.__FEILIN_SESSION_HELPER_LOGS__.shift();return __out}catch(__err){try{window.__FEILIN_SESSION_HELPER_LOGS__.push({helper:"rC",stage:"throw",argc:__args.length,error:String(__err&&__err.stack||__err),stack:String((new Error("FEILIN_RC_WRAP_THROW")).stack||"").slice(0,1200)});if(window.__FEILIN_SESSION_HELPER_LOGS__.length>200)window.__FEILIN_SESSION_HELPER_LOGS__.shift()}catch(_e){}throw __err}};window.__FEILIN_RC__=rC})();',
  );
  patched = patched.replace(
    /([A-Za-z_$][\w$]*)=\{secretKey:([\s\S]*?),sessionId:([\s\S]*?)\}/,
    '$1=(window.__FEILIN_SESSION_DERIVE_LOGS__=window.__FEILIN_SESSION_DERIVE_LOGS__||[],window.__FEILIN_SESSION_DERIVE_LOGS__.push({reSecretPreview:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.secretKey,200):null,reSessionPreview:window.__FEILIN_RE__?previewValue(window.__FEILIN_RE__.sessionId,200):null,stack:String((new Error("FEILIN_SESSION_DERIVE_V2")).stack||"").slice(0,1200)}),{secretKey:$2,sessionId:$3}),window.__FEILIN_LAST_SESSION_DERIVE__=$1',
  );
  patched = applyLiteralSnippetPatches(patched, options.literalSnippetPatches);
  patched = applyOffsetSnippetPatches(patched, options.offsetSnippetPatches);
  return patched;
}

function createWordArray(input = Buffer.alloc(0)) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return {
    buffer,
    sigBytes: buffer.length,
    words: [],
    toString(encoder) {
      let out;
      let encoderName = 'Hex';
      if (!encoder || encoder === cryptShim.enc.Hex) {
        out = buffer.toString('hex');
        encoderName = 'Hex';
      } else if (encoder === cryptShim.enc.Base64) {
        out = buffer.toString('base64');
        encoderName = 'Base64';
      } else if (encoder === cryptShim.enc.Utf8) {
        out = buffer.toString('utf8');
        encoderName = 'Utf8';
      } else if (typeof encoder?.stringify === 'function') {
        out = encoder.stringify(this);
        encoderName = encoder === cryptShim.enc.Base64 ? 'Base64' : encoder === cryptShim.enc.Utf8 ? 'Utf8' : 'Custom';
      } else {
        out = buffer.toString('hex');
        encoderName = 'Hex';
      }
      if (typeof window !== 'undefined' && typeof out === 'string' && out.length >= 120) {
        pushWindowLog(window, '__WORD_ARRAY_TOSTRING_LOGS__', {
          encoder: encoderName,
          inputBytes: buffer.length,
          outputLength: out.length,
          outputPreview: out.slice(0, 400),
          inputHexPreview: buffer.toString('hex').slice(0, 400),
          stack: String(new Error('WORD_ARRAY_TOSTRING').stack || '').slice(0, 1200),
        });
      }
      return out;
    },
    concat(other) {
      const otherBuf = normalizeWordArray(other);
      const outBuf = Buffer.concat([buffer, otherBuf]);
      if (typeof window !== 'undefined' && Array.isArray(window.__CRYPTO_TRACE_TARGETS__) && window.__CRYPTO_TRACE_TARGETS__.length > 0) {
        pushWindowLog(window, '__CRYPTO_TRACE_LOGS__', {
          stage: 'wordarray.concat',
          leftBytes: buffer.length,
          rightBytes: otherBuf.length,
          outputBytes: outBuf.length,
          leftUtf8Preview: buffer.toString('utf8').slice(0, 240),
          rightUtf8Preview: otherBuf.toString('utf8').slice(0, 240),
          outputUtf8Preview: outBuf.toString('utf8').slice(0, 240),
          leftHexPreview: buffer.toString('hex').slice(0, 240),
          rightHexPreview: otherBuf.toString('hex').slice(0, 240),
          outputHexPreview: outBuf.toString('hex').slice(0, 240),
          stack: String(new Error('CRYPTO_TRACE_WORDARRAY_CONCAT').stack || '').slice(0, 1200),
        });
      }
      if (typeof window !== 'undefined' && outBuf.length >= 120) {
        pushWindowLog(window, '__WORD_ARRAY_CONCAT_LOGS__', {
          leftBytes: buffer.length,
          rightBytes: otherBuf.length,
          outputBytes: outBuf.length,
          leftHexPreview: buffer.toString('hex').slice(0, 400),
          rightHexPreview: otherBuf.toString('hex').slice(0, 400),
          outputHexPreview: outBuf.toString('hex').slice(0, 400),
          leftBase64Preview: buffer.toString('base64').slice(0, 400),
          rightBase64Preview: otherBuf.toString('base64').slice(0, 400),
          outputBase64Preview: outBuf.toString('base64').slice(0, 400),
          stack: String(new Error('WORD_ARRAY_CONCAT').stack || '').slice(0, 1200),
        });
      }
      return createWordArray(outBuf);
    },
    clamp() {
      return this;
    },
  };
}

function normalizeWordArray(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') {
    if (typeof window !== 'undefined' && Array.isArray(window.__CRYPTO_TRACE_TARGETS__) && window.__CRYPTO_TRACE_TARGETS__.length > 0) {
      const raw = value;
      if (window.__CRYPTO_TRACE_TARGETS__.some((target) => raw === target || raw.includes(target) || target.includes(raw))) {
        pushWindowLog(window, '__CRYPTO_TRACE_LOGS__', {
          stage: 'normalize.string',
          inputLength: raw.length,
          inputPreview: raw.slice(0, 400),
          asHex: /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0,
          stack: String(new Error('CRYPTO_TRACE_NORMALIZE_STRING').stack || '').slice(0, 1200),
        });
      }
    }
    if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) return Buffer.from(value, 'hex');
    try {
      return Buffer.from(value, 'base64');
    } catch {
      return Buffer.from(value, 'utf8');
    }
  }
  if (value.buffer && Buffer.isBuffer(value.buffer)) return value.buffer;
  if (typeof value.toString === 'function' && value !== Object.prototype) {
    const str = String(value.toString(cryptShim.enc.Hex));
    if (/^[0-9a-f]+$/i.test(str) && str.length % 2 === 0) return Buffer.from(str, 'hex');
  }
  if (value.ciphertext) return normalizeWordArray(value.ciphertext);
  return Buffer.alloc(0);
}

const cryptShim = {
  enc: {
    Utf8: {
      parse(value) {
        if (typeof window !== 'undefined' && Array.isArray(window.__CRYPTO_TRACE_TARGETS__) && window.__CRYPTO_TRACE_TARGETS__.length > 0) {
          const raw = String(value ?? '');
          if (window.__CRYPTO_TRACE_TARGETS__.some((target) => raw === target || raw.includes(target) || target.includes(raw))) {
            pushWindowLog(window, '__CRYPTO_TRACE_LOGS__', {
              stage: 'utf8.parse',
              inputLength: raw.length,
              inputPreview: raw.slice(0, 400),
              stack: String(new Error('CRYPTO_TRACE_UTF8_PARSE').stack || '').slice(0, 1200),
            });
          }
        }
        return createWordArray(Buffer.from(String(value ?? ''), 'utf8'));
      },
      stringify(value) {
        return normalizeWordArray(value).toString('utf8');
      },
    },
    Hex: {
      parse(value) {
        const raw = String(value ?? '');
        const out = createWordArray(Buffer.from(raw, 'hex'));
        if (typeof window !== 'undefined' && raw.length >= 120) {
          pushWindowLog(window, '__HEX_PARSE_LOGS__', {
            inputLength: raw.length,
            inputPreview: raw.slice(0, 400),
            outputBytes: out.sigBytes,
            outputHexPreview: out.buffer.toString('hex').slice(0, 400),
            stack: String(new Error('HEX_PARSE').stack || '').slice(0, 1200),
          });
        }
        return out;
      },
      stringify(value) {
        return normalizeWordArray(value).toString('hex');
      },
    },
    Base64: {
      parse(value) {
        const raw = String(value ?? '');
        const out = createWordArray(Buffer.from(raw, 'base64'));
        if (typeof window !== 'undefined' && raw.length >= 120) {
          pushWindowLog(window, '__BASE64_PARSE_LOGS__', {
            inputLength: raw.length,
            inputPreview: raw.slice(0, 400),
            outputBytes: out.sigBytes,
            outputHexPreview: out.buffer.toString('hex').slice(0, 400),
            stack: String(new Error('BASE64_PARSE').stack || '').slice(0, 1200),
          });
        }
        return out;
      },
      stringify(value) {
        const out = normalizeWordArray(value).toString('base64');
        if (typeof window !== 'undefined' && typeof out === 'string' && out.length >= 120) {
          pushWindowLog(window, '__BASE64_STRINGIFY_LOGS__', {
            inputBytes: normalizeWordArray(value).length,
            outputLength: out.length,
            outputPreview: out.slice(0, 400),
            stack: String(new Error('BASE64_STRINGIFY').stack || '').slice(0, 1200),
          });
        }
        return out;
      },
    },
  },
  pad: {
    Pkcs7: {},
  },
  mode: {
    CBC: {},
  },
  AES: {
    encrypt(value, key, options = {}) {
      try {
        const keyBuf = normalizeWordArray(key);
        const ivBuf = normalizeWordArray(options.iv).subarray(0, 16);
        const source = normalizeWordArray(value);
        if (typeof window !== 'undefined' && Array.isArray(window.__CRYPTO_TRACE_TARGETS__) && window.__CRYPTO_TRACE_TARGETS__.length > 0) {
          pushWindowLog(window, '__CRYPTO_TRACE_LOGS__', {
            stage: 'aes.encrypt',
            valueType: typeof value,
            keyType: typeof key,
            ivType: typeof options.iv,
            sourceBytes: source.length,
            sourceUtf8Preview: source.toString('utf8').slice(0, 400),
            sourceHexPreview: source.toString('hex').slice(0, 400),
            keyBytes: keyBuf.length,
            keyHexPreview: keyBuf.toString('hex').slice(0, 200),
            ivBytes: ivBuf.length,
            ivHexPreview: ivBuf.toString('hex').slice(0, 200),
            stack: String(new Error('CRYPTO_TRACE_AES_ENCRYPT').stack || '').slice(0, 1200),
          });
        }
        const algo = `aes-${Math.max(16, Math.min(32, keyBuf.length || 16)) * 8}-cbc`;
        const normalizedKey = Buffer.alloc(Math.max(16, Math.min(32, keyBuf.length || 16)));
        keyBuf.copy(normalizedKey, 0, 0, Math.min(normalizedKey.length, keyBuf.length));
        const normalizedIv = Buffer.alloc(16);
        ivBuf.copy(normalizedIv, 0, 0, Math.min(16, ivBuf.length));
        const cipher = crypto.createCipheriv(algo, normalizedKey, normalizedIv);
        cipher.setAutoPadding(true);
        const ciphertext = Buffer.concat([cipher.update(source), cipher.final()]);
        return {
          ciphertext: createWordArray(ciphertext),
          toString(encoder) {
            let out;
            let encoderName = 'Base64';
            if (!encoder || encoder === cryptShim.enc.Base64) {
              out = ciphertext.toString('base64');
              encoderName = 'Base64';
            } else if (encoder === cryptShim.enc.Hex) {
              out = ciphertext.toString('hex');
              encoderName = 'Hex';
            } else if (encoder === cryptShim.enc.Utf8) {
              out = ciphertext.toString('utf8');
              encoderName = 'Utf8';
            } else if (typeof encoder?.stringify === 'function') {
              out = encoder.stringify(createWordArray(ciphertext));
              encoderName = 'Custom';
            } else {
              out = ciphertext.toString('base64');
              encoderName = 'Base64';
            }
            if (typeof window !== 'undefined' && typeof out === 'string' && out.length >= 120) {
              pushWindowLog(window, '__AES_ENCRYPT_TOSTRING_LOGS__', {
                encoder: encoderName,
                inputBytes: source.length,
                keyBytes: normalizedKey.length,
                ivBytes: normalizedIv.length,
                ciphertextBytes: ciphertext.length,
                outputLength: out.length,
                outputPreview: out.slice(0, 400),
                stack: String(new Error('AES_ENCRYPT_TOSTRING').stack || '').slice(0, 1200),
              });
            }
            return out;
          },
        };
      } catch {
        const empty = Buffer.alloc(0);
        return {
          ciphertext: createWordArray(empty),
          toString() {
            return '';
          },
        };
      }
    },
    decrypt(ciphertext, key, options = {}) {
      try {
        const keyBuf = normalizeWordArray(key);
        const ivBuf = normalizeWordArray(options.iv).subarray(0, 16);
        const source = normalizeWordArray(ciphertext);
        const algo = `aes-${Math.max(16, Math.min(32, keyBuf.length || 16)) * 8}-cbc`;
        const normalizedKey = Buffer.alloc(Math.max(16, Math.min(32, keyBuf.length || 16)));
        keyBuf.copy(normalizedKey, 0, 0, Math.min(normalizedKey.length, keyBuf.length));
        const normalizedIv = Buffer.alloc(16);
        ivBuf.copy(normalizedIv, 0, 0, Math.min(16, ivBuf.length));
        const decipher = crypto.createDecipheriv(algo, normalizedKey, normalizedIv);
        decipher.setAutoPadding(true);
        return createWordArray(Buffer.concat([decipher.update(source), decipher.final()]));
      } catch {
        return createWordArray(Buffer.alloc(0));
      }
    },
  },
  MD5(value) {
    return createWordArray(crypto.createHash('md5').update(normalizeWordArray(value)).digest());
  },
  SHA1(value) {
    return createWordArray(crypto.createHash('sha1').update(normalizeWordArray(value)).digest());
  },
  SHA256(value) {
    return createWordArray(crypto.createHash('sha256').update(normalizeWordArray(value)).digest());
  },
  HmacSHA1(value, key) {
    return createWordArray(crypto.createHmac('sha1', normalizeWordArray(key)).update(normalizeWordArray(value)).digest());
  },
};

function tryDecodeBase64Json(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

class Navigator {}
Object.defineProperty(Navigator.prototype, Symbol.toStringTag, {
  value: 'Navigator',
  configurable: true
});

class AudioDestinationNode {}
Object.defineProperty(AudioDestinationNode.prototype, Symbol.toStringTag, { value: 'AudioDestinationNode', configurable: true });

class AudioBuffer {
  constructor(options = {}) {
    this.numberOfChannels = options.numberOfChannels || 1;
    this.length = options.length || 44100;
    this.sampleRate = options.sampleRate || 44100;
    this.duration = this.length / this.sampleRate;
  }
  getChannelData(channel) {
    const data = new Float32Array(this.length);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.sin(i * 0.05) * 0.01;
    }
    return data;
  }
  copyFromChannel() {}
  copyToChannel() {}
}
Object.defineProperty(AudioBuffer.prototype, Symbol.toStringTag, { value: 'AudioBuffer', configurable: true });

class AudioNode {
  constructor() {
    this.channelCount = 2;
    this.channelCountMode = 'max';
    this.channelInterpretation = 'speakers';
  }
  connect(target) { return target; }
  disconnect() {}
}
Object.defineProperty(AudioNode.prototype, Symbol.toStringTag, { value: 'AudioNode', configurable: true });

class OscillatorNode extends AudioNode {
  constructor() {
    super();
    this.type = 'sine';
    this.frequency = { value: 440 };
    this.detune = { value: 0 };
  }
  start() {}
  stop() {}
}
Object.defineProperty(OscillatorNode.prototype, Symbol.toStringTag, { value: 'OscillatorNode', configurable: true });

class AudioParam {
  constructor(val = 0) {
    this.value = val;
    this.defaultValue = val;
    this.maxValue = 3.4028234663852886e+38;
    this.minValue = -3.4028234663852886e+38;
  }
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  setTargetAtTime() { return this; }
  setValueCurveAtTime() { return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
}
Object.defineProperty(AudioParam.prototype, Symbol.toStringTag, { value: 'AudioParam', configurable: true });

class GainNode extends AudioNode {
  constructor() {
    super();
    this.gain = new AudioParam(1.0);
  }
}
Object.defineProperty(GainNode.prototype, Symbol.toStringTag, { value: 'GainNode', configurable: true });

class EventTargetLike {
  constructor() {
    this._listeners = new Map();
  }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }
  dispatchEvent(event) {
    const type = event?.type;
    const list = this._listeners.get(type) || [];
    for (const fn of list.slice()) {
      try {
        fn.call(this, event);
      } catch (_err) {
        // ignore probe listener errors
      }
    }
    return true;
  }
}

class BaseAudioContext extends EventTargetLike {
  constructor() {
    super();
    this.destination = new AudioDestinationNode();
    this.sampleRate = 44100;
    this.currentTime = 0.0;
    this.state = 'running';
    this.listener = {};
  }
  createOscillator() { return new OscillatorNode(); }
  createGain() { return new GainNode(); }
  createAnalyser() {
    const node = new AudioNode();
    node.fftSize = 2048;
    node.frequencyBinCount = 1024;
    node.getByteFrequencyData = (array) => { array.fill(0); };
    node.getByteTimeDomainData = (array) => { array.fill(128); };
    node.getFloatFrequencyData = (array) => { array.fill(-Infinity); };
    node.getFloatTimeDomainData = (array) => { array.fill(0); };
    return node;
  }
  createBiquadFilter() {
    const node = new AudioNode();
    node.type = 'lowpass';
    node.frequency = new AudioParam(350);
    node.Q = new AudioParam(1);
    node.gain = new AudioParam(0);
    return node;
  }
  createDynamicsCompressor() {
    const node = new AudioNode();
    node.threshold = new AudioParam(-24);
    node.knee = new AudioParam(30);
    node.ratio = new AudioParam(12);
    node.reduction = 0.0;
    node.attack = new AudioParam(0.003);
    node.release = new AudioParam(0.25);
    return node;
  }
  createBuffer(numberOfChannels, length, sampleRate) {
    return new AudioBuffer({ numberOfChannels, length, sampleRate });
  }
  createBufferSource() {
    const node = new AudioNode();
    node.buffer = null;
    node.playbackRate = new AudioParam(1.0);
    node.loop = false;
    node.loopStart = 0;
    node.loopEnd = 0;
    node.start = () => {};
    node.stop = () => {};
    return node;
  }
  decodeAudioData(buffer, success, fail) {
    const ab = new AudioBuffer();
    if (typeof success === 'function') success(ab);
    return Promise.resolve(ab);
  }
}

class AudioContext extends BaseAudioContext {
  constructor() {
    super();
  }
  close() { this.state = 'closed'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
Object.defineProperty(AudioContext.prototype, Symbol.toStringTag, { value: 'AudioContext', configurable: true });

class OfflineAudioContext extends BaseAudioContext {
  constructor(numberOfChannels = 1, length = 44100, sampleRate = 44100) {
    super();
    this.destination = new AudioDestinationNode();
    this.sampleRate = sampleRate;
    this.length = length;
  }
  async startRendering() {
    const ab = new AudioBuffer({ length: this.length, sampleRate: this.sampleRate });
    return ab;
  }
}
Object.defineProperty(OfflineAudioContext.prototype, Symbol.toStringTag, { value: 'OfflineAudioContext', configurable: true });

function createContext(recorder, options = {}) {
  const xhrLog = [];
  const hostFetch = typeof global.fetch === 'function' ? global.fetch.bind(global) : null;
  const consoleLogBuffer = [];
  const pushConsoleLog = (level, args) => {
    try {
      consoleLogBuffer.push({
        level,
        args: Array.isArray(args) ? args.map((value) => previewValue(value, 800)) : [],
        stack: String(new Error(`CONSOLE_${String(level).toUpperCase()}`).stack || '').slice(0, 1000),
      });
      if (consoleLogBuffer.length > 200) consoleLogBuffer.shift();
    } catch {}
  };
  const silentConsole = {
    log(...args) { pushConsoleLog('log', args); },
    info(...args) { pushConsoleLog('info', args); },
    warn(...args) { pushConsoleLog('warn', args); },
    error(...args) { pushConsoleLog('error', args); },
    debug(...args) { pushConsoleLog('debug', args); },
    trace(...args) { pushConsoleLog('trace', args); },
    dir() {},
    group() {},
    groupCollapsed() {},
    groupEnd() {},
    time() {},
    timeEnd() {},
    timeLog() {},
    table() {},
    clear() {},
    assert() {},
    count() {},
    countReset() {},
  };
  const candidateSourceFiles = Array.isArray(options.sourceFiles) ? options.sourceFiles.map(String) : [];
  const idRegistry = new Map();
  const normalizeIdKey = (value) => String(value || '').toLowerCase();
  const INIT_STATIC_PATH = options.initStaticPath || '3.25.0/pe.092.5b9f44e900a2b7c5';
  const VERIFY_SECURITY_TOKEN = options.verifySecurityToken ?? null;
  const INIT_CERTIFY_ID = options.initCertifyId ?? null;
  const locationHref = options.locationHref || 'https://chat.z.ai/';
  const locationUrl = new URL(locationHref);
  const normalizePlainObject = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return { ...value };
  };
  const normalizeRecord = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [String(k), v == null ? '' : String(v)]),
    );
  };
  const parseCookieString = (value) => {
    const out = {};
    if (typeof value !== 'string' || !value.trim()) return out;
    for (const part of value.split(/;\s*/)) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key) out[key] = val;
    }
    return out;
  };
  const cookieStore = {
    ...parseCookieString(options.documentCookie || ''),
    ...normalizeRecord(options.cookieSeed),
  };
  const serializeCookieStore = () =>
    Object.entries(cookieStore).map(([k, v]) => `${k}=${v}`).join('; ');
  const parseForm = (body) => {
    const out = {};
    if (typeof body !== 'string') return out;
    for (const pair of body.split('&')) {
      if (!pair) continue;
      const idx = pair.indexOf('=');
      const rawKey = idx >= 0 ? pair.slice(0, idx) : pair;
      const rawValue = idx >= 0 ? pair.slice(idx + 1) : '';
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    }
    return out;
  };
  const executeMappedScript = (src, scriptNode = null) => {
    if (!src) return;
    const mappings = options.scriptMappings || [];
    let mappedFile = null;
    for (const mapping of mappings) {
      if (src.includes(mapping.pattern) && fs.existsSync(mapping.file)) {
        mappedFile = mapping.file;
        break;
      }
    }
    if (!mappedFile && options.scriptFetchMode === 'auto') {
      mappedFile = downloadScriptToCacheSync(src, options.scriptFetchCacheDir || '/tmp/aliyun-script-cache');
      if (mappedFile) {
        pushWindowLog('__SCRIPT_LOAD_LOGS__', {
          op: 'auto-fetch-script',
          src,
          file: mappedFile,
        }, 200);
      }
    }
    if (!mappedFile || !fs.existsSync(mappedFile)) return;
    const source = patchAliyunCaptchaSource(
      fs.readFileSync(mappedFile, 'utf8'),
      options.patchAliyunOptions || {},
    );
    const previousCurrentScript = rawDocument?._currentScript || null;
    if (rawDocument) rawDocument._currentScript = scriptNode || null;
    try {
      vm.runInContext(source, context, { timeout: 15000, filename: mappedFile });
    } finally {
      if (rawDocument) rawDocument._currentScript = previousCurrentScript;
    }
  };
  const makeStyle = () => ({
    setProperty(name, value) { this[name] = String(value); },
    removeProperty(name) { delete this[name]; },
    getPropertyValue(name) { return this[name] ?? ''; },
  });
  let globalWindowRef = null;
  const pushWindowLog = (bucketName, payload, limit = 300) => {
    try {
      const logWindow = globalWindowRef || {};
      logWindow[bucketName] = logWindow[bucketName] || [];
      logWindow[bucketName].push(payload);
      if (logWindow[bucketName].length > limit) logWindow[bucketName].shift();
    } catch {}
  };
  const previewForAccessLog = (value, limit = 160) => {
    if (value == null) return value;
    if (typeof value === 'string') return value.slice(0, limit);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
    if (typeof value === 'function') return previewFunctionSource(value, limit);
    if (Array.isArray(value)) return `[array:${value.length}]`;
    if (typeof value === 'object') {
      const ctor = value?.constructor?.name || 'Object';
      const keys = safeCall(value, (x) => Reflect.ownKeys(x).map(String).slice(0, 8)) || [];
      return `[${ctor} keys=${keys.join(',')}]`;
    }
    try {
      return String(value).slice(0, limit);
    } catch {
      return '[unpreviewable]';
    }
  };
  const makeNodeAccessProxy = (node, label) => {
    if (!node || typeof node !== 'object' || node.__isNodeAccessProxy) return node;
    const proxy = new Proxy(node, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        try {
          const key = String(prop);
          if (!key.startsWith('_')) {
            pushWindowLog('__NODE_ACCESS_LOGS__', {
              op: 'get',
              label,
              key,
              exists: Reflect.has(target, prop),
              valueType: typeof value,
              valuePreview: previewForAccessLog(value, 120),
              stack: String((new Error(`NODE_GET_${label}_${key}`)).stack || '').slice(0, 1000),
            }, 500);
          }
        } catch {}
        return value;
      },
      set(target, prop, value, receiver) {
        try {
          pushWindowLog('__NODE_ACCESS_LOGS__', {
            op: 'set',
            label,
            key: String(prop),
            valueType: typeof value,
            valuePreview: previewForAccessLog(value, 160),
            stack: String((new Error(`NODE_SET_${label}_${String(prop)}`)).stack || '').slice(0, 1000),
          }, 500);
        } catch {}
        return Reflect.set(target, prop, value, receiver);
      },
      has(target, prop) {
        return Reflect.has(target, prop);
      },
    });
    Object.defineProperty(proxy, '__isNodeAccessProxy', {
      value: true,
      enumerable: false,
      configurable: true,
    });
    return proxy;
  };



  class NodeLike extends EventTargetLike {
    constructor(tagName = '') {
      super();
      this.tagName = tagName ? String(tagName).toUpperCase() : '';
      this.nodeName = this.tagName;
      this.style = makeStyle();
      this.children = [];
      this.childNodes = this.children;
      this._attributesMap = {};
      Object.defineProperty(this, 'attributesMap', {
        enumerable: false,
        configurable: true,
        get: () => this._attributesMap,
        set: (value) => {
          this._attributesMap = value && typeof value === 'object' ? { ...value } : {};
        },
      });
      this.dataset = {};
      this.parentNode = null;
      this.ownerDocument = null;
      this.textContent = '';
      this._innerHTML = '';
      this.className = '';
      this.onclick = null;
      this._offsetWidth = null;
      this._offsetHeight = null;
      Object.defineProperty(this, 'innerHTML', {
        enumerable: true,
        configurable: true,
        get: () => this._innerHTML || '',
        set: (value) => {
          this._setInnerHTML(value);
        },
      });
      Object.defineProperty(this, 'innerText', {
        enumerable: true,
        configurable: true,
        get: () => this.textContent || '',
        set: (value) => {
          this.textContent = String(value ?? '');
        },
      });
      Object.defineProperty(this, 'parentElement', {
        enumerable: true,
        configurable: true,
        get: () => (this.parentNode && this.parentNode.tagName ? this.parentNode : null),
      });
      Object.defineProperty(this, 'firstChild', {
        enumerable: true,
        configurable: true,
        get: () => this.children[0] || null,
      });
      Object.defineProperty(this, 'lastChild', {
        enumerable: true,
        configurable: true,
        get: () => this.children[this.children.length - 1] || null,
      });
      Object.defineProperty(this, 'previousSibling', {
        enumerable: true,
        configurable: true,
        get: () => {
          const list = this.parentNode?.children || [];
          const index = list.indexOf(this);
          return index > 0 ? list[index - 1] : null;
        },
      });
      Object.defineProperty(this, 'nextSibling', {
        enumerable: true,
        configurable: true,
        get: () => {
          const list = this.parentNode?.children || [];
          const index = list.indexOf(this);
          return index >= 0 && index < list.length - 1 ? list[index + 1] : null;
        },
      });
      Object.defineProperty(this, 'outerHTML', {
        enumerable: true,
        configurable: true,
        get: () => {
          if (!this.tagName || this.tagName.startsWith('#')) return String(this.textContent || this.innerHTML || '');
          const attrs = Object.entries(this.attributesMap || {})
            .map(([key, value]) => ` ${key}="${String(value)}"`)
            .join('');
          const body = this.innerHTML || this.textContent || this.children.map((child) => child.outerHTML || child.textContent || '').join('');
          return `<${this.tagName.toLowerCase()}${attrs}>${body}</${this.tagName.toLowerCase()}>`;
        },
      });
      Object.defineProperty(this, 'attributes', {
        enumerable: true,
        configurable: true,
        get: () => {
          const map = new NamedNodeMap(this.attributesMap, this);
          const entries = Object.entries(this.attributesMap || {});
          map.length = entries.length;
          entries.forEach(([key, value], index) => {
            map[index] = new Attr(key, value);
            map[index].ownerElement = this;
            map[key] = map[index];
          });
          return map;
        },
        set: (value) => { this.attributesMap = value; },
      });
      Object.defineProperty(this, 'offsetWidth', {
        enumerable: true,
        configurable: true,
        get: () => {
          const explicit = this._offsetWidth ?? Number(this.style.width || this.width || 0);
          if (explicit > 0) return explicit;
          const text = String(this.textContent || this.innerHTML || '');
          const familyHash = simpleStringHash(this.style.fontFamily || '');
          const fontDelta = familyHash ? (familyHash % 19) + ((familyHash >> 5) % 7) : 0;
          return Math.max(8, Math.min(1920, text.length * 8 + 16 + fontDelta));
        },
        set: (value) => {
          this._offsetWidth = Number(value) || 0;
        },
      });
      Object.defineProperty(this, 'offsetHeight', {
        enumerable: true,
        configurable: true,
        get: () => {
          const explicit = this._offsetHeight ?? Number(this.style.height || this.height || 0);
          if (explicit > 0) return explicit;
          const text = String(this.textContent || this.innerHTML || '');
          const familyHash = simpleStringHash(this.style.fontFamily || '');
          const fontDelta = familyHash ? familyHash % 5 : 0;
          return Math.max(16, Math.min(1080, 16 + Math.ceil(text.length / 32) * 18 + fontDelta));
        },
        set: (value) => {
          this._offsetHeight = Number(value) || 0;
        },
      });
      Object.defineProperty(this, 'clientWidth', {
        enumerable: true,
        configurable: true,
        get: () => this.offsetWidth,
        set: (value) => {
          this.offsetWidth = value;
        },
      });
      Object.defineProperty(this, 'clientHeight', {
        enumerable: true,
        configurable: true,
        get: () => this.offsetHeight,
        set: (value) => {
          this.offsetHeight = value;
        },
      });
      Object.defineProperty(this, 'scrollWidth', {
        enumerable: true,
        configurable: true,
        get: () => this.offsetWidth,
        set: (value) => {
          this.offsetWidth = value;
        },
      });
      Object.defineProperty(this, 'scrollHeight', {
        enumerable: true,
        configurable: true,
        get: () => this.offsetHeight,
        set: (value) => {
          this.offsetHeight = value;
        },
      });
      this.classList = {
        add: (...names) => {
          const set = new Set(String(this.className || '').split(/\s+/).filter(Boolean));
          for (const name of names) set.add(String(name));
          this.className = [...set].join(' ');
        },
        remove: (...names) => {
          const remove = new Set(names.map((x) => String(x)));
          this.className = String(this.className || '')
            .split(/\s+/)
            .filter((x) => x && !remove.has(x))
            .join(' ');
        },
        contains: (name) => String(this.className || '').split(/\s+/).includes(String(name)),
      };
      if (this.tagName === 'SCRIPT') {
        this._src = '';
        Object.defineProperty(this, 'src', {
          enumerable: true,
          configurable: true,
          get: () => this._src,
          set: (val) => {
            this._src = String(val);
            this.attributesMap['src'] = this._src;
            this._triggerScriptLoad();
          },
        });
      }
    }
    _dropSubtreeIds(node) {
      if (!node) return;
      if (node.id) idRegistry.delete(normalizeIdKey(node.id));
      for (const child of Array.isArray(node.children) ? node.children : []) {
        this._dropSubtreeIds(child);
      }
    }
    _applyInlineStyle(value) {
      if (typeof value !== 'string' || !value.trim()) return;
      for (const chunk of value.split(';')) {
        const [rawKey, ...rest] = chunk.split(':');
        const key = String(rawKey || '').trim();
        if (!key) continue;
        const cssValue = rest.join(':').trim();
        const camelKey = key.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
        this.style[camelKey] = cssValue;
      }
      this.style.cssText = value;
    }
    _appendHtmlFragment(html) {
      const raw = String(html || '');
      if (!raw.trim()) return;
      const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
      const tagRe = /<\/?([a-zA-Z0-9-]+)([^>]*?)\/?>/g;
      const attrRe = /([:@a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
      const stack = [this];
      let match;
      while ((match = tagRe.exec(raw))) {
        const full = match[0];
        const tag = String(match[1] || '').toLowerCase();
        if (!tag) continue;
        const isClosing = full.startsWith('</');
        if (isClosing) {
          while (stack.length > 1) {
            const node = stack.pop();
            if (String(node?.tagName || '').toLowerCase() === tag) break;
          }
          continue;
        }
        const attrsRaw = match[2] || '';
        const node = this.ownerDocument?.createElement
          ? this.ownerDocument.createElement(tag)
          : new NodeLike(tag);
        let attrMatch;
        while ((attrMatch = attrRe.exec(attrsRaw))) {
          const attrName = String(attrMatch[1] || '').trim();
          if (!attrName) continue;
          const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
          node.setAttribute(attrName, attrValue);
          const lowerName = attrName.toLowerCase();
          if (lowerName === 'class') node.className = String(attrValue);
          if (lowerName === 'style') node._applyInlineStyle(String(attrValue));
        }
        stack[stack.length - 1].appendChild(node);
        const selfClosing = full.endsWith('/>') || voidTags.has(tag);
        if (!selfClosing) stack.push(node);
      }
    }
    _setInnerHTML(value) {
      const next = String(value ?? '');
      for (const child of this.children) {
        this._dropSubtreeIds(child);
      }
      this.children.length = 0;
      this._innerHTML = next;
      if (!next.trim()) {
        this.textContent = '';
        return;
      }
      if (next.includes('<') && next.includes('>')) {
        this._appendHtmlFragment(next);
        return;
      }
      this.textContent = next;
    }
    _triggerScriptLoad() {
      if (this.tagName !== 'SCRIPT') return;
      if (!this.src) return;
      if (!this.parentNode) return;
      if (this._executed) return;
      this._executed = true;
      setTimeout(() => {
        try {
          pushWindowLog('__SCRIPT_LOAD_LOGS__', {
            op: 'append-script',
            tagName: this.tagName,
            src: this.src,
          }, 200);
          executeMappedScript(this.src, this);
          if (typeof this.onload === 'function') {
            this.onload({ type: 'load', target: this });
          }
        } catch (err) {
          pushWindowLog('__SCRIPT_LOAD_LOGS__', {
            op: 'append-script-error',
            tagName: this.tagName,
            src: this.src,
            error: String(err && err.stack || err),
          }, 200);
          if (typeof this.onerror === 'function') {
            this.onerror(err);
          }
        }
      }, 0);
    }
    appendChild(child) {
      if (!child) return child;
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
      if (child.id) idRegistry.set(normalizeIdKey(child.id), child);
      if (child.tagName === 'SCRIPT') {
        child._triggerScriptLoad();
        return child;
      }
      if (typeof child.onload === 'function') {
        setTimeout(() => child.onload({ type: 'load', target: child }), 0);
      }
      return child;
    }
    append(...nodes) {
      for (const node of nodes) {
        if (node == null) continue;
        if (typeof node === 'string') {
          this.appendChild(this.ownerDocument.createTextNode(node));
          continue;
        }
        this.appendChild(node);
      }
    }
    prepend(...nodes) {
      const prepared = [];
      for (const node of nodes) {
        if (node == null) continue;
        if (typeof node === 'string') {
          prepared.push(this.ownerDocument.createTextNode(node));
          continue;
        }
        prepared.push(node);
      }
      for (let i = prepared.length - 1; i >= 0; i -= 1) {
        this.insertBefore(prepared[i], this.children[0] || null);
      }
    }
    insertBefore(child, referenceNode) {
      if (!child) return child;
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument;
      const nextChildren = this.children;
      const index = referenceNode ? nextChildren.indexOf(referenceNode) : -1;
      if (index >= 0) nextChildren.splice(index, 0, child);
      else nextChildren.push(child);
      if (child.id) idRegistry.set(normalizeIdKey(child.id), child);
      if (child.tagName === 'SCRIPT') {
        child._triggerScriptLoad();
        return child;
      }
      if (typeof child.onload === 'function') {
        setTimeout(() => child.onload({ type: 'load', target: child }), 0);
      }
      return child;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      this._dropSubtreeIds(child);
      child.parentNode = null;
      return child;
    }
    setAttribute(name, value) {
      const lowerName = String(name).toLowerCase();
      this.attributesMap[name] = String(value);
      if (lowerName === 'src' && this.tagName === 'SCRIPT') {
        this.src = String(value);
      } else {
        this[name] = String(value);
      }
      if (lowerName === 'id') idRegistry.set(normalizeIdKey(value), this);
    }
    getElementsByTagName(tag) {
      const lower = String(tag || '').toLowerCase();
      const results = [];
      const dfs = (node) => {
        for (const child of node.children) {
          if (child.tagName && child.tagName.toLowerCase() === lower) {
            results.push(child);
          }
          dfs(child);
        }
      };
      dfs(this);
      return results;
    }
    getAttribute(name) {
      return this.attributesMap[name] ?? null;
    }
    removeAttribute(name) {
      delete this.attributesMap[name];
      delete this[name];
    }
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributesMap, name);
    }
    getAttributeNames() {
      return Object.keys(this.attributesMap);
    }
    getBoundingClientRect() {
      const width = this.offsetWidth || 0;
      const height = this.offsetHeight || 0;
      return { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height };
    }
    contains(node) {
      if (!node) return false;
      if (node === this) return true;
      return this.children.some((child) => child === node || (typeof child.contains === 'function' && child.contains(node)));
    }
    querySelector(selector) {
      const lower = String(selector || '').toLowerCase();
      const dfs = (node) => {
        if (!node) return null;
        for (const child of node.children) {
          if (lower.startsWith('#')) {
            if (String(child.id || '').toLowerCase() === lower.slice(1)) return child;
          } else if (lower.startsWith('.')) {
            const klass = lower.slice(1);
            if (String(child.className || '').toLowerCase().split(/\s+/).includes(klass)) return child;
          } else {
            if (child.tagName && child.tagName.toLowerCase() === lower) return child;
          }
          const match = dfs(child);
          if (match) return match;
        }
        return null;
      };
      if (lower.startsWith('#')) {
        const direct = idRegistry.get(lower.slice(1));
        if (direct) {
          pushWindowLog('__SELECTOR_LOGS__', { scope: 'node', op: 'querySelector-hit', selector: lower, via: 'idRegistry' }, 500);
          return direct;
        }
      }
      const found = dfs(this);
      pushWindowLog('__SELECTOR_LOGS__', {
        scope: 'node',
        op: found ? 'querySelector-hit' : 'querySelector-miss',
        selector: lower,
        tagName: this.tagName || null,
      }, 500);
      return found;
    }
    querySelectorAll(selector) {
      const lower = String(selector || '').toLowerCase();
      const results = [];
      const dfs = (node) => {
        if (!node) return;
        for (const child of node.children) {
          if (lower === '*') {
            results.push(child);
          } else if (lower.startsWith('#')) {
            if (String(child.id || '').toLowerCase() === lower.slice(1)) {
              results.push(child);
            }
          } else if (lower.startsWith('.')) {
            const klass = lower.slice(1);
            if (String(child.className || '').toLowerCase().split(/\s+/).includes(klass)) {
              results.push(child);
            }
          } else {
            if (child.tagName && child.tagName.toLowerCase() === lower) {
              results.push(child);
            }
          }
          dfs(child);
        }
      };
      dfs(this);
      pushWindowLog('__SELECTOR_LOGS__', {
        scope: 'node',
        op: 'querySelectorAll',
        selector: lower,
        resultCount: results.length,
        tagName: this.tagName || null,
      }, 500);
      return results;
    }
    closest(selector) {
      const lower = String(selector || '').toLowerCase();
      let cur = this;
      while (cur) {
        if (lower.startsWith('#') && String(cur.id || '').toLowerCase() === lower.slice(1)) return cur;
        if (lower.startsWith('.') && String(cur.className || '').toLowerCase().split(/\s+/).includes(lower.slice(1))) {
          return cur;
        }
        if (cur.tagName?.toLowerCase?.() === lower) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
    insertAdjacentHTML(_position, html) {
      const appended = String(html || '');
      this._innerHTML = String(this._innerHTML || '') + appended;
      this._appendHtmlFragment(appended);
    }
    focus() {
      this.dispatchEvent(new Event('focus'));
    }
    blur() {
      this.dispatchEvent(new Event('blur'));
    }
    click() {
      if (typeof this.onclick === 'function') {
        try {
          this.onclick(new MouseEvent('click', { bubbles: true, target: this }));
        } catch (_err) {
          // ignore
        }
      }
      this.dispatchEvent(new Event('click', { bubbles: true }));
    }
  }

  class CanvasLike extends NodeLike {
    constructor() {
      super('canvas');
      this.width = 300;
      this.height = 150;
    }
    getContext(type) {
      recorder.push('call', 'canvas.getContext', { type });
      if (type === '2d') {
        return createLenientObject({
          canvas: this,
          fillRect() {},
          clearRect() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          fill() {},
          closePath() {},
          rect() {},
          arc() {},
          save() {},
          restore() {},
          translate() {},
          rotate() {},
          scale() {},
          drawImage() {},
          createPattern: () => ({}),
          createImageData: () => ({ data: new Uint8ClampedArray(4) }),
          putImageData() {},
          fillText() {},
          strokeText() {},
          measureText: () => ({ width: 10 }),
          createLinearGradient: () => ({ addColorStop() {} }),
          createRadialGradient: () => ({ addColorStop() {} }),
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        }, 'canvas-2d-context');
      }
      if (type === 'webgl' || type === 'experimental-webgl') {
        const gl = createLenientObject({
          canvas: this,
          getParameter(pname) {
            const VENDOR = 0x1F00;
            const RENDERER = 0x1F01;
            const VERSION = 0x1F02;
            const SHADING_LANGUAGE_VERSION = 0x1F03;
            const UNMASKED_VENDOR_WEBGL = 0x9245;
            const UNMASKED_RENDERER_WEBGL = 0x9246;
            
            if (pname === VENDOR || pname === UNMASKED_VENDOR_WEBGL) {
              return 'Google Inc. (NVIDIA)';
            }
            if (pname === RENDERER || pname === UNMASKED_RENDERER_WEBGL) {
              return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
            }
            if (pname === VERSION) {
              return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
            }
            if (pname === SHADING_LANGUAGE_VERSION) {
              return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
            }
            if (pname === 0x852 || pname === 0x853 || pname === 0x854 || pname === 0x855) return 8; // RGBA bits
            if (pname === 0x856) return 24; // DEPTH_BITS
            if (pname === 0x857) return 8; // STENCIL_BITS
            if (pname === 0xD33 || pname === 0x84E8) return 16384; // MAX_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE
            if (pname === 0xD3A) return new Int32Array([16384, 16384]); // MAX_VIEWPORT_DIMS
            
            return '';
          },
          getExtension(name) {
            if (name && name.toLowerCase() === 'webgl_debug_renderer_info') {
              return {
                UNMASKED_VENDOR_WEBGL: 0x9245,
                UNMASKED_RENDERER_WEBGL: 0x9246,
              };
            }
            return null;
          },
          getSupportedExtensions() {
            return [
              'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float', 
              'EXT_disjoint_timer_query', 'EXT_float_blend', 'EXT_frag_depth', 
              'EXT_shader_texture_lod', 'EXT_sRGB', 'EXT_texture_compression_bptc', 
              'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic', 
              'KHR_parallel_shader_compile', 'OES_element_index_uint', 'OES_fbo_render_mipmap', 
              'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_float_linear', 
              'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object', 
              'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 
              'WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_s3tc', 
              'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_renderer_info', 
              'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_draw_buffers', 
              'WEBGL_lose_context', 'WEBGL_multi_draw'
            ];
          },
        }, 'canvas-webgl-context');
        return gl;
      }
      return createLenientObject({}, `canvas-${type || 'unknown'}-context`);
    }
    toDataURL() {
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    }
  }

  class IFrameLike extends NodeLike {
    constructor() {
      super('iframe');
      this.contentWindow = {
        document: new DocumentLike(),
        navigator,
        location: { href: 'about:blank' },
        addEventListener() {},
        removeEventListener() {},
      };
      this.contentWindow.document.defaultView = this.contentWindow;
      this.contentDocument = this.contentWindow.document;
    }
  }

  const collectDocumentNodes = (root) => {
    const results = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.tagName && !String(node.tagName).startsWith('#')) {
        results.push(node);
      }
      for (const child of Array.isArray(node.children) ? node.children : []) {
        walk(child);
      }
    };
    walk(root);
    return results;
  };

  const buildLiveNodeCollection = (resolveNodes) => {
    const makeSnapshot = () => {
      const nodes = Array.isArray(resolveNodes?.()) ? resolveNodes() : [];
      const collection = new HTMLCollection(...nodes);
      collection.length = nodes.length;
      collection.item = (index) => nodes[index] || null;
      collection.namedItem = (name) => {
        const key = String(name || '').toLowerCase();
        return nodes.find((node) =>
          String(node?.id || '').toLowerCase() === key ||
          String(node?.name || '').toLowerCase() === key) || null;
      };
      for (let i = 0; i < nodes.length; i += 1) {
        collection[i] = nodes[i];
      }
      return { nodes, collection };
    };
    return new Proxy({}, {
      get(_target, prop) {
        const { nodes, collection } = makeSnapshot();
        if (prop === Symbol.iterator) return nodes[Symbol.iterator].bind(nodes);
        if (prop === 'length') return nodes.length;
        if (prop === 'item') return collection.item;
        if (prop === 'namedItem') return collection.namedItem;
        if (prop === 'forEach') return nodes.forEach.bind(nodes);
        if (prop === 'entries') return nodes.entries.bind(nodes);
        if (prop === 'keys') return nodes.keys.bind(nodes);
        if (prop === 'values') return nodes.values.bind(nodes);
        if (prop === 'toString') return () => '[object HTMLAllCollection]';
        if (prop === Symbol.toStringTag) return 'HTMLAllCollection';
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return nodes[Number(prop)] || undefined;
        if (typeof prop === 'string' && prop) {
          const named = collection.namedItem(prop);
          if (named) return named;
        }
        return collection[prop];
      },
      has(_target, prop) {
        const { nodes, collection } = makeSnapshot();
        if (prop === 'length' || prop === 'item' || prop === 'namedItem') return true;
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return Number(prop) < nodes.length;
        if (typeof prop === 'string' && prop && collection.namedItem(prop)) return true;
        return prop in collection;
      },
      ownKeys() {
        const { nodes } = makeSnapshot();
        return [
          ...nodes.map((_, index) => String(index)),
          'length',
          'item',
          'namedItem',
        ];
      },
      getOwnPropertyDescriptor(_target, prop) {
        const value = this.get?.(_target, prop) ?? makeSnapshot().collection[prop];
        if (value === undefined && prop !== 'length') return undefined;
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value,
        };
      },
    });
  };

  class DocumentLike extends EventTargetLike {
    constructor() {
      super();
      Object.defineProperty(this, 'cookie', {
        enumerable: true,
        configurable: true,
        get() {
          return serializeCookieStore();
        },
        set(value) {
          if (typeof value !== 'string' || !value.trim()) return true;
          const first = value.split(';')[0] || '';
          const idx = first.indexOf('=');
          if (idx <= 0) return true;
          cookieStore[first.slice(0, idx).trim()] = first.slice(idx + 1).trim();
          return true;
        },
      });
      this.domain = locationUrl.hostname;
      this.readyState = 'complete';
      this.visibilityState = 'visible';
      this.hidden = false;
      this.msHidden = false;
      this.mozHidden = false;
      this.webkitHidden = false;
      this.referrer = options.referrer || '';
      this.characterSet = 'UTF-8';
      this.URL = locationHref;
      this.documentURI = locationHref;
      this.baseURI = locationHref;
      this.fullscreenElement = null;
      this.msFullscreenElement = null;
      this.mozFullScreenElement = null;
      this.webkitFullscreenElement = null;
      this.fullscreenEnabled = false;
      this.webkitFullscreenEnabled = false;
      this.msFullscreenEnabled = false;
      this.mozFullScreenEnabled = false;
      this.fonts = {
        ready: Promise.resolve(),
        status: 'loaded',
        check() { return true; },
        load: async () => [],
        add() {},
        delete() { return false; },
        clear() {},
        forEach() {},
        values() { return [][Symbol.iterator](); },
      };
      this.documentElement = new NodeLike('html');
      this.documentElement.ownerDocument = this;
      this.documentElement.parentNode = this;
      this.documentElement.style = makeStyle();
      this.documentElement.clientWidth = 765;
      this.documentElement.clientHeight = 821;
      this.head = new NodeLike('head');
      this.head.ownerDocument = this;
      this.body = new NodeLike('body');
      this.body.ownerDocument = this;
      this.documentElement.appendChild(this.head);
      this.documentElement.appendChild(this.body);
      this.activeElement = this.body;
      Object.defineProperty(this, 'all', {
        enumerable: true,
        configurable: true,
        get: () => buildLiveNodeCollection(() => collectDocumentNodes(this.documentElement)),
      });
      this.$cdc_asdjflasutopfhvcZLmcfl_ = '';
      this.fxdriver_id = '';
      this.__webdriver_script_fn = '';
      this.__driver_evaluate = '';
      this.__webdriver_evaluate = '';
      this.__selenium_evaluate = '';
      this.__fxdriver_evaluate = '';
      this.defaultView = null;
      this._selection = null;
      this._currentScript = null;
      Object.defineProperty(this, 'currentScript', {
        enumerable: true,
        configurable: true,
        get: () => this._currentScript,
      });
      Object.assign(this, normalizePlainObject(options.documentOverrides));
    }
    createElement(tag) {
      recorder.push('call', 'document.createElement', { tag });
      const lower = String(tag).toLowerCase();
      if (lower === 'canvas') {
        const canvas = new CanvasLike();
        canvas.ownerDocument = this;
        return canvas;
      }
      if (lower === 'iframe') {
        const iframe = new IFrameLike();
        iframe.ownerDocument = this;
        return iframe;
      }
      const el = new NodeLike(tag);
      el.ownerDocument = this;
      return el;
    }
    createTextNode(text) {
      const node = new NodeLike('#text');
      node.textContent = String(text);
      node.ownerDocument = this;
      return node;
    }
    createDocumentFragment() {
      const frag = new NodeLike('#fragment');
      frag.ownerDocument = this;
      return frag;
    }
    createRange() {
      return new Range();
    }
    getElementById(id) {
      const result = idRegistry.get(normalizeIdKey(id)) || null;
      pushWindowLog('__SELECTOR_LOGS__', {
        scope: 'document',
        op: result ? 'getElementById-hit' : 'getElementById-miss',
        selector: String(id),
      }, 500);
      return result;
    }
    getElementsByTagName(tag) {
      const lower = String(tag || '').toLowerCase();
      if (lower === '*') return collectDocumentNodes(this.documentElement);
      if (lower === 'html') return [this.documentElement];
      const results = [];
      if (this.documentElement.tagName && this.documentElement.tagName.toLowerCase() === lower) {
        results.push(this.documentElement);
      }
      results.push(...this.documentElement.getElementsByTagName(tag));
      return results;
    }
    querySelector(selector) {
      const lower = String(selector || '').toLowerCase();
      if (lower === 'head') return this.head;
      if (lower === 'body') return this.body;
      if (lower === 'html') return this.documentElement;
      if (lower.startsWith('#')) {
        const result = idRegistry.get(lower.slice(1)) || null;
        pushWindowLog('__SELECTOR_LOGS__', {
          scope: 'document',
          op: result ? 'querySelector-hit' : 'querySelector-miss',
          selector: lower,
          via: 'idRegistry',
        }, 500);
        return result;
      }
      const result = this.body.querySelector(selector) || this.head.querySelector(selector);
      pushWindowLog('__SELECTOR_LOGS__', {
        scope: 'document',
        op: result ? 'querySelector-hit' : 'querySelector-miss',
        selector: lower,
      }, 500);
      return result;
    }
    querySelectorAll(selector) {
      const lower = String(selector || '').toLowerCase();
      if (lower === 'head') return [this.head];
      if (lower === 'body') return [this.body];
      if (lower === 'html') return [this.documentElement];
      if (lower === '*') {
        const results = [
          ...this.head.querySelectorAll(selector),
          ...this.body.querySelectorAll(selector),
        ];
        pushWindowLog('__SELECTOR_LOGS__', {
          scope: 'document',
          op: 'querySelectorAll',
          selector: lower,
          resultCount: results.length,
        }, 500);
        return results;
      }
      if (lower.startsWith('#')) {
        const match = this.querySelector(selector);
        return match ? [match] : [];
      }
      const results = [
        ...this.head.querySelectorAll(selector),
        ...this.body.querySelectorAll(selector),
      ];
      pushWindowLog('__SELECTOR_LOGS__', {
        scope: 'document',
        op: 'querySelectorAll',
        selector: lower,
        resultCount: results.length,
      }, 500);
      return results;
    }
    hasFocus() {
      return true;
    }
    elementFromPoint() {
      return this.body;
    }
    caretRangeFromPoint() {
      const range = new Range();
      range.selectNodeContents(this.body);
      return range;
    }
    caretPositionFromPoint() {
      return {
        offsetNode: this.body,
        offset: 0,
      };
    }
    createEvent(type = 'Event') {
      const event = new Event(type);
      event.initEvent = function initEvent(eventType, bubbles, cancelable) {
        this.type = eventType;
        this.bubbles = !!bubbles;
        this.cancelable = !!cancelable;
      };
      return event;
    }
    execCommand() {
      return false;
    }
    queryCommandSupported() {
      return false;
    }
    queryCommandState() {
      return false;
    }
    queryCommandValue() {
      return '';
    }
    async browsingTopics() {
      return [];
    }
    async hasStorageAccess() {
      return false;
    }
    async requestStorageAccess() {
      return false;
    }
    async requestStorageAccessFor() {
      return false;
    }
    getSelection() {
      if (!this._selection) {
        const range = new Range();
        range.selectNodeContents(this.body);
        this._selection = {
          anchorNode: this.body,
          focusNode: this.body,
          anchorOffset: 0,
          focusOffset: 0,
          isCollapsed: true,
          rangeCount: 1,
          type: 'Caret',
          addRange(nextRange) {
            this._range = nextRange || range;
            this.rangeCount = 1;
            this.anchorNode = this._range.startContainer || this.anchorNode;
            this.focusNode = this._range.endContainer || this.focusNode;
            this.isCollapsed = !!this._range.collapsed;
          },
          removeAllRanges() {
            this.rangeCount = 0;
            this.isCollapsed = true;
          },
          getRangeAt() {
            return this._range || range;
          },
          collapse(node, offset = 0) {
            this.anchorNode = node || this.anchorNode;
            this.focusNode = node || this.focusNode;
            this.anchorOffset = offset;
            this.focusOffset = offset;
            this.isCollapsed = true;
          },
          containsNode(node) {
            return !!(node && (node === this.anchorNode || this.anchorNode?.contains?.(node)));
          },
          toString() {
            return '';
          },
        };
        this._selection._range = range;
      }
      return this._selection;
    }
  }

  const makeStorage = (seed = {}, name = 'storage') => {
    const storageData = new Map(Object.entries(normalizeRecord(seed)));
    return {
      get length() {
        return storageData.size;
      },
      clear() {
        recorder.push('call', `${name}.clear`, null);
        storageData.clear();
      },
      getItem(k) { recorder.push('call', `${name}.getItem`, { k }); return storageData.get(k) ?? null; },
      key(i) {
        recorder.push('call', `${name}.key`, { i });
        return [...storageData.keys()][Number(i)] ?? null;
      },
      setItem(k, v) { recorder.push('call', `${name}.setItem`, { k }); storageData.set(k, String(v)); },
      removeItem(k) { recorder.push('call', `${name}.removeItem`, { k }); storageData.delete(k); },
      _dump() {
        return Object.fromEntries(storageData.entries());
      },
    };
  };

  const localStorage = makeStorage(options.localStorageSeed, 'localStorage');
  const sessionStorage = makeStorage(options.sessionStorageSeed, 'sessionStorage');
  function Storage() {}
  Object.setPrototypeOf(localStorage, Storage.prototype);
  Object.setPrototypeOf(sessionStorage, Storage.prototype);

  function HTMLButtonElement() {}
  HTMLButtonElement.prototype = { popover: '', showPopover() {}, hidePopover() {}, togglePopover() {} };
  function Attr(name = '', value = '') {
    this.name = String(name);
    this.value = String(value);
    this.nodeName = this.name;
    this.nodeValue = this.value;
    this.textContent = this.value;
    this.ownerElement = null;
    this.specified = true;
  }
  function NamedNodeMap(seed = {}, ownerElement = null) {
    this._seed = seed || {};
    this._ownerElement = ownerElement || null;
  }
  NamedNodeMap.prototype.item = function item(index) {
    const entries = Object.entries(this._seed || {});
    const pair = entries[Number(index)] || null;
    if (!pair) return null;
    const attr = new Attr(pair[0], pair[1]);
    attr.ownerElement = this._ownerElement || null;
    return attr;
  };
  NamedNodeMap.prototype.getNamedItem = function getNamedItem(name) {
    if (!this._seed || !Object.prototype.hasOwnProperty.call(this._seed, name)) return null;
    const attr = new Attr(name, this._seed[name]);
    attr.ownerElement = this._ownerElement || null;
    return attr;
  };
  function MediaSource() {}
  function DeviceMotionEvent() {}
  function MediaStream(tracks = []) {
    this._tracks = Array.isArray(tracks) ? tracks : [];
  }
  MediaStream.prototype.getTracks = function getTracks() {
    return this._tracks.slice();
  };

  const rawDocument = new DocumentLike();
  rawDocument.documentElement = makeNodeAccessProxy(rawDocument.documentElement, 'documentElement');
  rawDocument.head = makeNodeAccessProxy(rawDocument.head, 'head');
  rawDocument.body = makeNodeAccessProxy(rawDocument.body, 'body');
  rawDocument.documentElement.childNodes = rawDocument.documentElement.children;
  rawDocument.head.parentNode = rawDocument.documentElement;
  rawDocument.body.parentNode = rawDocument.documentElement;
  rawDocument.activeElement = rawDocument.body;
  rawDocument.all = [rawDocument.documentElement, rawDocument.head, rawDocument.body];
  rawDocument.$chrome_asyncScriptInfo = '';
  rawDocument.documentElement.$chrome_asyncScriptInfo = '';
  const document = new Proxy(rawDocument, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      try {
        const key = String(prop);
        if (typeof key === 'string' && !key.startsWith('_')) {
          pushWindowLog('__DOCUMENT_ACCESS_LOGS__', {
            op: 'get',
            key,
            exists: Reflect.has(target, prop),
            valueType: typeof value,
            valuePreview: previewForAccessLog(value, 120),
            stack: String((new Error(`DOCUMENT_GET_${key}`)).stack || '').slice(0, 1000),
          }, 300);
        }
      } catch {}
      return value;
    },
    set(target, prop, value, receiver) {
      try {
        const key = String(prop);
        pushWindowLog('__DOCUMENT_ACCESS_LOGS__', {
          op: 'set',
          key,
          valueType: typeof value,
          valuePreview: previewForAccessLog(value, 160),
          stack: String((new Error(`DOCUMENT_SET_${key}`)).stack || '').slice(0, 1000),
        }, 300);
      } catch {}
      return Reflect.set(target, prop, value, receiver);
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
  });

  const navigator = Object.assign(Object.create(Navigator.prototype), {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    appName: 'Netscape',
    vendor: 'Google Inc.',
    vendorSub: '',
    platform: 'Win32',
    product: 'Gecko',
    productSub: '20030107',
    language: 'en-US',
    languages: ['en-US', 'en'],
    cookieEnabled: true,
    onLine: true,
    webdriver: false,
    pdfViewerEnabled: true,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    doNotTrack: null,
    maxTouchPoints: 0,
    plugins: [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ],
    mimeTypes: [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ],
    serviceWorker: {},
    brave: undefined,
    mediaDevices: {},
    permissions: {
      async query() {
        return { state: 'granted' };
      },
    },
    userAgentData: {
      brands: [
        { brand: 'Not-A.Brand', version: '99' },
        { brand: 'Chromium', version: '124' },
        { brand: 'Google Chrome', version: '124' },
      ],
      mobile: false,
      platform: 'Windows',
      async getHighEntropyValues() {
        return {
          architecture: 'x86',
          bitness: '64',
          brands: this.brands,
          mobile: false,
          model: '',
          platform: 'Windows',
          platformVersion: '10.0.0',
          uaFullVersion: '124.0.0.0',
          wow64: false,
        };
      },
      toJSON() {
        return { brands: this.brands, mobile: this.mobile, platform: this.platform };
      },
    },
    webkitTemporaryStorage: {
      queryUsageAndQuota(cb) { recorder.push('call', 'navigator.webkitTemporaryStorage.queryUsageAndQuota', null); cb(0, 1024 * 1024 * 1024); },
    },
  });
  const mediaScenario = String(options.mediaScenario || 'empty');
  const mediaDeviceLogs = [];
  const pushMediaLog = (type, detail = {}) => {
    const entry = { type, detail: previewValue(detail, 300), ts: Date.now() };
    mediaDeviceLogs.push(entry);
    if (mediaDeviceLogs.length > 80) mediaDeviceLogs.shift();
    recorder.push('call', `media.${type}`, entry.detail);
  };
  const makeVideoTrack = () => ({
    kind: 'video',
    label: 'Integrated Camera',
    enabled: true,
    muted: false,
    readyState: 'live',
    id: 'video-track-1',
    stop() { pushMediaLog('track.stop', {}); },
    getSettings() {
      pushMediaLog('track.getSettings', {});
      return {
        aspectRatio: 1.7777777778,
        deviceId: 'camera-device-1',
        facingMode: 'user',
        frameRate: 30,
        height: 720,
        resizeMode: 'none',
        width: 1280,
      };
    },
    getConstraints() {
      pushMediaLog('track.getConstraints', {});
      return {
        video: {
          facingMode: 'user',
          frameRate: { ideal: 30 },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      };
    },
    getCapabilities() {
      pushMediaLog('track.getCapabilities', {});
      return {
        aspectRatio: { max: 1.7777777778, min: 1.3333333333 },
        facingMode: ['user'],
        frameRate: { max: 30, min: 15 },
        height: { max: 1080, min: 240 },
        width: { max: 1920, min: 320 },
      };
    },
  });
  navigator.mediaDevices = {
    async enumerateDevices() {
      pushMediaLog('enumerateDevices', { scenario: mediaScenario });
      if (mediaScenario === 'camera-granted' || mediaScenario === 'camera-rich') {
        return [
          {
            deviceId: 'camera-device-1',
            kind: 'videoinput',
            label: 'Integrated Camera',
            groupId: 'group-camera-1',
            toJSON() { return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; },
          },
          {
            deviceId: 'mic-device-1',
            kind: 'audioinput',
            label: 'Built-in Microphone',
            groupId: 'group-audio-1',
            toJSON() { return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; },
          },
        ];
      }
      return [];
    },
    async getUserMedia(constraints) {
      pushMediaLog('getUserMedia', { scenario: mediaScenario, constraints });
      if (mediaScenario === 'camera-granted' || mediaScenario === 'camera-rich') {
        return new MediaStream([makeVideoTrack()]);
      }
      throw new Error('Permission denied');
    },
  };
  navigator.getUserMedia = function legacyGetUserMedia(constraints, onSuccess, onError) {
    navigator.mediaDevices.getUserMedia(constraints).then(
      (stream) => { if (typeof onSuccess === 'function') onSuccess(stream); },
      (err) => { if (typeof onError === 'function') onError(err); },
    );
  };
  navigator.webkitGetUserMedia = navigator.getUserMedia;
  navigator.mozGetUserMedia = navigator.getUserMedia;
  Object.assign(navigator, normalizePlainObject(options.navigatorOverrides));
  if (Array.isArray(options.navigatorLanguages) && options.navigatorLanguages.length > 0) {
    navigator.languages = options.navigatorLanguages.map((x) => String(x));
    navigator.language = String(options.navigatorLanguages[0]);
  }
  if (options.navigatorUserAgent) {
    navigator.userAgent = String(options.navigatorUserAgent);
    navigator.appVersion = String(options.navigatorUserAgent);
  }

  const indexedDB = {
    open(name) {
      recorder.push('call', 'indexedDB.open', { name });
      const req = {};
      setTimeout(() => {
        if (typeof req.onupgradeneeded === 'function') {
          req.onupgradeneeded({
            target: {
              result: {
                createObjectStore() {
                  return { put() {} };
                },
                close() {},
              },
            },
          });
        }
      }, 0);
      return req;
    },
    deleteDatabase() {},
  };

  class StorageEvent {}
  class Event {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      this.defaultPrevented = false;
      this.timeStamp = init.timeStamp ?? Date.now();
      Object.assign(this, init);
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
    stopPropagation() {}
    stopImmediatePropagation() {}
  }
  class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.detail = init.detail;
    }
  }
  class Worker extends EventTargetLike {
    constructor(url) {
      super();
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
      recorder.push('construct', 'Worker', { url });
    }
    postMessage(message) {
      recorder.push('call', 'Worker.postMessage', { messageType: typeof message });
      if (typeof this.onmessage === 'function') {
        setTimeout(() => this.onmessage({ data: null }), 0);
      }
    }
    terminate() {
      recorder.push('call', 'Worker.terminate', null);
    }
  }
  class MessageChannel {
    constructor() {
      const makePort = () => ({
        onmessage: null,
        postMessage(message) {
          recorder.push('call', 'MessagePort.postMessage', { messageType: typeof message });
          if (typeof this.onmessage === 'function') {
            setTimeout(() => this.onmessage({ data: message }), 0);
          }
        },
        start() {},
        close() {},
        addEventListener() {},
        removeEventListener() {},
      });
      this.port1 = makePort();
      this.port2 = makePort();
    }
  }
  class NodeList extends Array {}
  class HTMLCollection extends Array {}
  class MouseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      Object.assign(this, {
        clientX: 0,
        clientY: 0,
        pageX: 0,
        pageY: 0,
        screenX: 0,
        screenY: 0,
        movementX: 0,
        movementY: 0,
        button: 0,
        buttons: 0,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      }, init);
    }
  }
  class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      Object.assign(this, {
        pointerId: 1,
        width: 1,
        height: 1,
        pressure: this.buttons ? 0.5 : 0,
        tangentialPressure: 0,
        tiltX: 0,
        tiltY: 0,
        twist: 0,
        pointerType: 'mouse',
        isPrimary: true,
      }, init);
    }
  }
  class KeyboardEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      Object.assign(this, {
        key: '',
        code: '',
        keyCode: 0,
        which: 0,
        charCode: 0,
        repeat: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      }, init);
    }
  }
  class Touch {
    constructor(init = {}) {
      Object.assign(this, {
        identifier: 0,
        target: null,
        clientX: 0,
        clientY: 0,
        pageX: 0,
        pageY: 0,
        screenX: 0,
        screenY: 0,
        radiusX: 11,
        radiusY: 11,
        rotationAngle: 0,
        force: 0.5,
      }, init);
    }
  }
  class TouchEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.touches = init.touches || [];
      this.targetTouches = init.targetTouches || this.touches;
      this.changedTouches = init.changedTouches || this.touches;
      this.ctrlKey = !!init.ctrlKey;
      this.shiftKey = !!init.shiftKey;
      this.altKey = !!init.altKey;
      this.metaKey = !!init.metaKey;
    }
  }
  class Image {
    constructor() {
      this.width = 0;
      this.height = 0;
      this.onload = null;
      this.onerror = null;
      this._src = '';
    }
    set src(value) {
      this._src = value;
      if (typeof this.onload === 'function') setTimeout(() => this.onload({ type: 'load', target: this }), 0);
    }
    get src() {
      return this._src;
    }
  }
  class Audio {
    constructor() {
      this.currentTime = 0;
      this.duration = 0;
      this.paused = true;
      this.loop = false;
      this.muted = false;
      this.volume = 1;
      this.src = '';
      this.oncanplay = null;
      this.oncanplaythrough = null;
      this.onloadedmetadata = null;
      this.onended = null;
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    load() {
      if (typeof this.onloadedmetadata === 'function') setTimeout(() => this.onloadedmetadata({ target: this }), 0);
      if (typeof this.oncanplay === 'function') setTimeout(() => this.oncanplay({ target: this }), 0);
      if (typeof this.oncanplaythrough === 'function') setTimeout(() => this.oncanplaythrough({ target: this }), 0);
    }
    canPlayType() {
      return 'probably';
    }
    addEventListener() {}
    removeEventListener() {}
  }
  class Text extends NodeLike {
    constructor(text = '') {
      super('#text');
      this.data = String(text);
      this.nodeValue = this.data;
      this.textContent = this.data;
    }
  }
  class Range {
    constructor() {
      this.commonAncestorContainer = null;
      this.startContainer = null;
      this.endContainer = null;
      this.collapsed = true;
    }
    setStart(node) { this.startContainer = node || null; this.collapsed = false; }
    setEnd(node) { this.endContainer = node || null; this.collapsed = false; }
    setStartBefore(node) { this.startContainer = node?.parentNode || null; this.collapsed = false; }
    setEndAfter(node) { this.endContainer = node?.parentNode || null; this.collapsed = false; }
    selectNode(node) {
      this.commonAncestorContainer = node?.parentNode || null;
      this.startContainer = node || null;
      this.endContainer = node || null;
      this.collapsed = false;
    }
    selectNodeContents(node) {
      this.commonAncestorContainer = node || null;
      this.startContainer = node || null;
      this.endContainer = node || null;
      this.collapsed = false;
    }
    collapse() { this.collapsed = true; }
    cloneRange() { return new Range(); }
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
    getClientRects() { return []; }
    createContextualFragment(html) {
      const frag = new NodeLike('#fragment');
      frag.ownerDocument = document;
      frag.innerHTML = String(html || '');
      return frag;
    }
  }
  class Location {
    constructor(href = 'https://chat.z.ai/') {
      this.href = href;
      this.protocol = 'https:';
      this.host = 'chat.z.ai';
      this.hostname = 'chat.z.ai';
      this.search = '';
      this.hash = '';
      this.pathname = '/';
      this.origin = 'https://chat.z.ai';
    }
    toString() {
      return this.href;
    }
  }

  class XMLHttpRequest extends EventTargetLike {
    constructor() {
      super();
      this.readyState = 0;
      this.status = 0;
      this.responseText = '';
      this.response = '';
      this.onreadystatechange = null;
      this.onload = null;
      this.onerror = null;
    }
    open(method, url) {
      recorder.push('call', 'XMLHttpRequest.open', { method, url });
      this.method = method;
      this.url = url;
      this.readyState = 1;
    }
    setRequestHeader(name, value) {
      if (!this.headers) this.headers = {};
      this.headers[name] = value;
    }
    send(body) {
      recorder.push('call', 'XMLHttpRequest.send', { bodyType: typeof body });
      let params = parseForm(body);
      let effectiveBody = body;
      const configuredCertifyId =
        options.initialAliyunCaptchaConfig?.CertifyId ||
        options.initialAliyunCaptchaConfig?.UserCertifyId ||
        options.initialAliyunCaptchaConfig?.certifyId ||
        INIT_CERTIFY_ID ||
        null;
      if (
        params?.Action === 'VerifyCaptchaV3' &&
        configuredCertifyId &&
        (!params.CertifyId || params.CertifyId === 'null' || params.CertifyId === 'undefined')
      ) {
        params.CertifyId = configuredCertifyId;
        if (typeof params.CaptchaVerifyParam === 'string' && params.CaptchaVerifyParam) {
          try {
            const parsedVerify = JSON.parse(params.CaptchaVerifyParam);
            if (!parsedVerify.certifyId || parsedVerify.certifyId === 'null' || parsedVerify.certifyId === 'undefined') {
              parsedVerify.certifyId = configuredCertifyId;
              params.CaptchaVerifyParam = JSON.stringify(parsedVerify);
            }
          } catch {
            // ignore malformed verify payload
          }
        }
        try {
          const signFn = window.__ALIYUN_REVERSE__ && typeof window.__ALIYUN_REVERSE__.signCaptchaParams === 'function'
            ? window.__ALIYUN_REVERSE__.signCaptchaParams
            : null;
          if (signFn) {
            params.Signature = signFn(params);
          }
        } catch {
          // ignore signature refresh failures
        }
        try {
          const nextBody = new URLSearchParams();
          for (const [key, value] of Object.entries(params || {})) {
            nextBody.set(key, value == null ? '' : String(value));
          }
          effectiveBody = nextBody.toString();
        } catch {
          effectiveBody = body;
        }
      }
      xhrLog.push({
        method: this.method,
        url: this.url,
        body: effectiveBody,
        params,
        stack: options.captureXhrStacks ? String(new Error('xhr-stack').stack || '') : undefined,
      });

      const action = params.Action || '';
      
      if (options.executeLive) {
        const reqHeaders = {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://chat.z.ai',
          'Referer': '',
          'Sec-Ch-Ua': '"Google Chrome";v="147", "Not?A_Brand";v="8", "Chromium";v="147"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Linux"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site'
        };
        
        const sessionContext = options.sessionContext || global.__CAPTCHA_SESSION_CONTEXT__ || null;
        if (sessionContext?.requestHeaders && typeof sessionContext.requestHeaders === 'object') {
          Object.assign(reqHeaders, sessionContext.requestHeaders);
        }
        if (sessionContext && sessionContext.cookie) {
          reqHeaders['Cookie'] = sessionContext.cookie;
        }
        const rewriteUrl = (() => {
          const map = sessionContext?.requestUrlRewriteMap;
          if (!map || typeof map !== 'object') return this.url;
          return map[this.url] || this.url;
        })();
        const currentEntry = xhrLog[xhrLog.length - 1];
        if (currentEntry && currentEntry.body === body) {
          currentEntry.requestUrl = rewriteUrl;
          currentEntry.requestHeaders = { ...reqHeaders };
        }

        window.fetch(rewriteUrl, {
          method: this.method || 'POST',
          headers: reqHeaders,
          body: effectiveBody
        }).then(res => {
          if (sessionContext) {
            const setCookie = res.headers.get('set-cookie');
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
          this.status = res.status;
          this.responseHeaders = Object.fromEntries(res.headers.entries());
          if (currentEntry) {
            currentEntry.responseStatus = res.status;
            currentEntry.responseHeaders = this.responseHeaders;
          }
          return res.text();
        }).then(text => {
          this.readyState = 4;
          this.responseText = text;
          this.response = text;
          
          const entry = xhrLog.find(x => x.body === effectiveBody);
          if (entry) {
            entry.response = text;
            try {
              entry.responseJson = JSON.parse(text);
            } catch {}
          }

          if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
          if (typeof this.onload === 'function') this.onload({ type: 'load', target: this });
        }).catch(err => {
          this.readyState = 4;
          this.status = 0;
          this.responseText = String(err && err.stack || err);
          this.response = this.responseText;
          if (typeof this.onerror === 'function') this.onerror(err);
          if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
        });
        
        return;
      }

      this.readyState = 4;
      this.status = 200;
      let payload = { Code: 'Success', Success: true };
      if (action === 'Log1') {
        const log1ResultObject = options.log1ResultObject && typeof options.log1ResultObject === 'object'
          ? { ...options.log1ResultObject }
          : {};
        if (options.log1DeviceConfig) {
          log1ResultObject.DeviceConfig = String(options.log1DeviceConfig);
        }
        if (options.log1DeviceToken) {
          log1ResultObject.DeviceToken = String(options.log1DeviceToken);
        }
        payload = {
          RequestId: 'probe-log1-request-id',
          Message: 'success',
          Code: '200',
          Success: true,
          ResultObject: log1ResultObject,
        };
      } else if (action === 'Log2') {
        payload = options.log2Response && typeof options.log2Response === 'object'
          ? JSON.parse(JSON.stringify(options.log2Response))
          : {
            RequestId: 'probe-log2-request-id',
            Message: 'success',
            Code: 'Success',
            Success: true,
          };
      } else if (/^Init/.test(action)) {
        const configuredSyntheticInit =
          options.syntheticInitResponse && typeof options.syntheticInitResponse === 'object'
            ? JSON.parse(JSON.stringify(options.syntheticInitResponse))
            : null;
        payload = options.failSyntheticInit === true
          ? {
            RequestId: 'probe-init-request-id',
            Message: 'synthetic init disabled for stage2 analysis',
            Code: 'SYNTHETIC_INIT_DISABLED',
            LimitFlow: false,
            Success: false,
            CertifyId: null,
            StaticPath: INIT_STATIC_PATH,
            CaptchaType: 'TRACELESS',
            ...(configuredSyntheticInit || {}),
          }
          : {
            RequestId: 'probe-init-request-id',
            Message: 'success',
            Code: 'Success',
            LimitFlow: false,
            Success: true,
            CertifyId: INIT_CERTIFY_ID,
            StaticPath: INIT_STATIC_PATH,
            CaptchaType: 'TRACELESS',
            ...(configuredSyntheticInit || {}),
          };
      } else if (/^VerifyCaptcha/.test(action)) {
        const verifyResult = !!VERIFY_SECURITY_TOKEN;
        payload = {
          RequestId: 'probe-verify-request-id',
          Message: verifyResult ? 'success' : 'live verify required',
          HttpStatusCode: verifyResult ? 200 : 400,
          Code: verifyResult ? 'Success' : 'LIVE_VERIFY_REQUIRED',
          Success: verifyResult,
          Result: {
            securityToken: VERIFY_SECURITY_TOKEN,
            VerifyCode: verifyResult ? 'T001' : 'LIVE_VERIFY_REQUIRED',
            VerifyResult: verifyResult,
            certifyId: params.CertifyId || INIT_CERTIFY_ID || null,
          },
        };
      }
      this.responseText = JSON.stringify(payload);
      this.response = this.responseText;
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
      if (typeof this.onload === 'function') this.onload({ type: 'load', target: this });
    }
    abort() {}
    getAllResponseHeaders() { return ''; }
    getResponseHeader(name) {
      return this.responseHeaders?.[name.toLowerCase()] || null;
    }
  }

  function ProbedDate(...args) {
    if (!(this instanceof ProbedDate)) {
      return Date(...args);
    }
    const date = args.length ? new Date(...args) : new Date();
    Object.setPrototypeOf(date, ProbedDate.prototype);
    return date;
  }
  ProbedDate.prototype = Date.prototype;
  Object.setPrototypeOf(ProbedDate, Date);
  ProbedDate.now = function now() {
    const value = Date.now();
    try {
      const stack = String((new Error('DATE_NOW')).stack || '').slice(0, 1200);
      if (
        globalWindowRef &&
        (stack.includes('/tmp/aliyun-pe.js') ||
          stack.includes('/tmp/feilin.js') ||
          /aliyun-pe-[^/\s]+\.js/.test(stack) ||
          /feilin[^/\s]*\.js/.test(stack))
      ) {
        globalWindowRef.__DATE_NOW_LOGS__ = globalWindowRef.__DATE_NOW_LOGS__ || [];
        globalWindowRef.__DATE_NOW_LOGS__.push({ value, stack });
        if (globalWindowRef.__DATE_NOW_LOGS__.length > 400) globalWindowRef.__DATE_NOW_LOGS__.shift();
      }
    } catch (_e) {}
    return value;
  };
  ProbedDate.parse = Date.parse.bind(Date);
  ProbedDate.UTC = Date.UTC.bind(Date);

  const nativeSetTimeout = global.setTimeout.bind(global);
  const nativeClearTimeout = global.clearTimeout.bind(global);
  const nativeSetInterval = global.setInterval.bind(global);
  const nativeClearInterval = global.clearInterval.bind(global);
  let timerSeq = 1;
  const timerHandles = new Map();
  const browserSetTimeout = (fn, delay = 0, ...args) => {
    const id = timerSeq++;
    const handle = nativeSetTimeout(() => {
      timerHandles.delete(id);
      if (typeof fn === 'function') return fn(...args);
      return undefined;
    }, delay);
    timerHandles.set(id, handle);
    return id;
  };
  const browserClearTimeout = (id) => {
    const handle = timerHandles.get(id);
    if (handle) {
      nativeClearTimeout(handle);
      timerHandles.delete(id);
    }
  };
  const browserSetInterval = (fn, delay = 0, ...args) => {
    const id = timerSeq++;
    const handle = nativeSetInterval(() => {
      if (typeof fn === 'function') fn(...args);
    }, delay);
    timerHandles.set(id, handle);
    return id;
  };
  const browserClearInterval = (id) => {
    const handle = timerHandles.get(id);
    if (handle) {
      nativeClearInterval(handle);
      timerHandles.delete(id);
    }
  };

  const window = {
    document,
    navigator,
    indexedDB,
    localStorage,
    sessionStorage,
    location: new Location(locationHref),
    history: {
      length: 1,
      state: null,
      back() {},
      forward() {},
      go() {},
      pushState(_state, _title, _url) {},
      replaceState(_state, _title, _url) {},
    },
    screen: { width: 1552, height: 970, availWidth: 1552, availHeight: 970, colorDepth: 24, pixelDepth: 24 },
    innerWidth: 765,
    innerHeight: 821,
    outerWidth: 1552,
    outerHeight: 970,
    closed: false,
    devicePixelRatio: 1,
    performance: { now: () => Date.now(), memory: { jsHeapSizeLimit: 1073741824 } },
    crypto: {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i += 1) arr[i] = (Math.random() * 256) | 0;
        return arr;
      },
      randomUUID() {
        return '00000000-0000-4000-8000-000000000000';
      },
    },
    Event,
    CustomEvent,
    EventTarget: EventTargetLike,
    Element: NodeLike,
    Node: NodeLike,
    NodeList,
    HTMLCollection,
    Window: function Window() {},
    Screen: function Screen() {},
    Range,
    Attr,
    NamedNodeMap,
    HTMLElement: NodeLike,
    HTMLIFrameElement: IFrameLike,
    HTMLImageElement: Image,
    HTMLScriptElement: NodeLike,
    HTMLStyleElement: NodeLike,
    HTMLDivElement: NodeLike,
    HTMLSpanElement: NodeLike,
    HTMLButtonElement,
    HTMLCanvasElement: CanvasLike,
    Document: DocumentLike,
    Image,
    Audio,
    Text,
    MouseEvent,
    PointerEvent,
    KeyboardEvent,
    Touch,
    TouchEvent,
    MediaStream,
    MediaSource,
    DeviceMotionEvent,
    XMLHttpRequest,
    Worker,
    MessageChannel,
    Storage,
    openDatabase() { recorder.push('call', 'window.openDatabase', null); return {}; },
    open() { recorder.push('call', 'window.open', null); return null; },
    close() {
      recorder.push('call', 'window.close', null);
      this.closed = true;
      return undefined;
    },
    resizeBy() { recorder.push('call', 'window.resizeBy', null); },
    resizeTo() { recorder.push('call', 'window.resizeTo', null); },
    moveBy() { recorder.push('call', 'window.moveBy', null); },
    blur() { recorder.push('call', 'window.blur', null); },
    focus() { recorder.push('call', 'window.focus', null); },
    scroll() { recorder.push('call', 'window.scroll', null); },
    scrollBy() { recorder.push('call', 'window.scrollBy', null); },
    scrollTo() { recorder.push('call', 'window.scrollTo', null); },
    moveTo() { recorder.push('call', 'window.moveTo', null); },
    alert() {},
    confirm() { return true; },
    prompt() { return ''; },
    requestAnimationFrame(cb) { return browserSetTimeout(() => cb(Date.now()), 16); },
    cancelAnimationFrame(id) { browserClearTimeout(id); },
    webkitRequestFileSystem(_type, _size, ok) { recorder.push('call', 'window.webkitRequestFileSystem', null); ok?.(); },
    chrome: {
      app: { isInstalled: false, InstallState: {}, RunningState: {} },
      runtime: {},
      csi() { return { onloadT: Date.now(), startE: Date.now() - 10 }; },
      loadTimes() {
        return {
          connectionInfo: 'h2',
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000,
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          navigationType: 'Other',
          requestTime: Date.now() / 1000,
          startLoadTime: Date.now() / 1000,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        };
      },
      webstore: {},
    },
    CSS: {
      supports(property, value) {
        if (typeof property !== 'string') return true;
        if (property.includes('font-size-adjust')) return true;
        if (property.includes('text-transform')) return true;
        if (typeof value === 'string') return true;
        return true;
      },
    },
    CSSRule: function CSSRule() {},
    CSSCounterStyleRule: function CSSCounterStyleRule() {},
    Notification: { permission: 'granted' },
    MediaSource,
    DeviceMotionEvent,
    setTimeout: browserSetTimeout,
    clearTimeout: browserClearTimeout,
    setInterval: browserSetInterval,
    clearInterval: browserClearInterval,
    Promise,
    Blob,
    File,
    FormData,
    Math,
    Date: ProbedDate,
    JSON,
    String,
    Array,
    Object,
    RegExp,
    Number,
    Boolean,
    Error,
    TypeError,
    Symbol,
    Reflect,
    Proxy,
    ArrayBuffer,
    DataView,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    parseInt,
    parseFloat,
    isNaN,
    escape,
    unescape,
    encodeURIComponent,
    decodeURIComponent,
    Uint8Array,
    Uint8ClampedArray,
    Buffer,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    byteLikeHexPreview,
    previewValue: (value, limit) => previewValue(value, limit),
    snapshotObjectShape: (value, limit) => snapshotObjectShape(value, limit),
    detectIncognito: undefined,
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
    getComputedStyle: (element) => makeComputedStyleFor(element),
    getSelection: () => document.getSelection(),
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || String(input || '');
      recorder.push('call', 'window.fetch', {
        url,
        method: init?.method || (typeof input === 'object' ? input?.method : null) || 'GET',
        hasBody: init?.body != null,
        live: !!hostFetch,
      });
      if (!hostFetch) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({}),
          headers: new Headers(),
        };
      }
      return hostFetch(input, init);
    },
    Element: NodeLike,
    Option: function Option() {},
    History: function History() {},
    StorageEvent,
    URL,
    Location,
    URLSearchParams,
    AbortController,
    Headers,
    Request,
    Response,
    print() {},
    decodeBase64Utf8: (value, limit) => decodeBase64Utf8(value, limit),
    wordArrayToHexPreview: (value, limit) => wordArrayToHexPreview(value, limit),
    captureRsOutputDetails: (value) => captureRsOutputDetails(value),
  };
  globalWindowRef = window;
  try {
    window.document.$chrome_asyncScriptInfo = '';
    window.document.documentElement.$cdc_asdjflasutopfhvcZLmcfl_ = '';
    window.document.documentElement.fxdriver_id = '';
    window.document.documentElement.__webdriver_script_fn = '';
    window.document.documentElement.$chrome_asyncScriptInfo = '';
    window.document.documentElement.webdriver = false;
    window.document.documentElement.selenium = '';
    window.document.documentElement.driver = '';
  } catch {}
  window.__CRYPTO_TRACE_TARGETS__ = Array.isArray(options.cryptoTraceTargets)
    ? options.cryptoTraceTargets.filter((x) => typeof x === 'string' && x).slice(0, 12)
    : [];
  window.__RA_TRACE_TARGETS__ = Array.isArray(options.raTraceTargets)
    ? options.raTraceTargets.filter((x) => typeof x === 'string' && x).slice(0, 12)
    : Array.isArray(options.cryptoTraceTargets)
    ? options.cryptoTraceTargets.filter((x) => typeof x === 'string' && x).slice(0, 12)
    : [];
  Object.assign(window.screen, normalizePlainObject(options.screenOverrides));
  Object.assign(window, normalizePlainObject(options.windowOverrides));
  const windowEventTarget = new EventTargetLike();
  window.addEventListener = windowEventTarget.addEventListener.bind(windowEventTarget);
  window.removeEventListener = windowEventTarget.removeEventListener.bind(windowEventTarget);
  window.dispatchEvent = windowEventTarget.dispatchEvent.bind(windowEventTarget);
  if (window.Element && window.Element.prototype) {
    Object.defineProperty(window.Element.prototype, 'webkitRequestFullscreen', {
      value: function webkitRequestFullscreen() {},
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  window.window = window;
  window.self = window;
  window.globalThis = window;
  class Window extends EventTargetLike {}
  Object.defineProperty(Window.prototype, Symbol.toStringTag, {
    value: 'Window',
    configurable: true
  });
  window.Window = Window;
  window.Navigator = Navigator;
  window.AudioContext = AudioContext;
  window.OfflineAudioContext = OfflineAudioContext;
  window.webkitAudioContext = AudioContext;
  Object.setPrototypeOf(window, Window.prototype);
  window.FEILIN = makeMagic('window.FEILIN', recorder);
  window.__ALIYUN_CRYPT = cryptShim;
  window.dt = makeMagic('window.dt', recorder);
  const nativeArrayJoin = Array.prototype.join;
  Array.prototype.join = function patchedJoin(separator) {
    const out = nativeArrayJoin.call(this, separator);
    try {
      if (
        separator === '#' &&
        typeof out === 'string' &&
        (
          out.includes('SG_WEB') ||
          /[0-9a-f]{32}-h-\d{10,}/.test(out) ||
          out.includes('#####null')
        )
      ) {
        window.__JOIN_LOGS__ = window.__JOIN_LOGS__ || [];
        window.__JOIN_LOGS__.push({
          separator,
          parts: Array.from(this).slice(0, 20).map((x) => typeof x === 'string' ? x.slice(0, 400) : previewValue(x, 200)),
          output: out.slice(0, 1200),
          stack: String(new Error('join').stack || '').slice(0, 1200),
        });
      }
    } catch {
      // ignore join logging errors
    }
    return out;
  };
  const nativeJsonStringify = JSON.stringify;
  let jsonStringifyLogDepth = 0;
  JSON.stringify = function patchedJsonStringify(value, replacer, space) {
    const out = nativeJsonStringify.call(JSON, value, replacer, space);
    try {
      if (jsonStringifyLogDepth === 0 && value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        const looksLikeCaptchaVerifyParam =
          keys.includes('deviceToken') && keys.includes('data') && (keys.includes('sceneId') || keys.includes('certifyId'));
        const looksLikeSignedSuccessPayload =
          keys.includes('sceneId') && keys.includes('certifyId') && keys.includes('securityToken');
        if (looksLikeCaptchaVerifyParam || looksLikeSignedSuccessPayload) {
          jsonStringifyLogDepth += 1;
          const instanceRef = window.__ALIYUN_LAST_INSTANCE__ || null;
          const captchaRef =
            instanceRef?.captcha?.AliyunCaptcha ||
            instanceRef?.captcha ||
            window.__ALIYUN_LAST_CAPTCHA_INSTANCE__ ||
            null;
          window.__JSON_STRINGIFY_LOGS__ = window.__JSON_STRINGIFY_LOGS__ || [];
          window.__JSON_STRINGIFY_LOGS__.push({
            keys: keys.slice(0, 20),
            valueShape: snapshotObjectShape(value, 12),
            outputPreview: typeof out === 'string' ? out.slice(0, 2000) : String(out).slice(0, 300),
            runtimeState: extractAliyunRuntimeState(
              instanceRef,
              captchaRef,
              window.__ALIYUN_INIT_STATE__ || null,
            ),
            instanceConfig: snapshotObjectShape(instanceRef?.config, 40),
            captchaConfig: snapshotObjectShape(captchaRef?.config, 40),
            initState: snapshotObjectShape(window.__ALIYUN_INIT_STATE__, 40),
            feilinReState: snapshotObjectShape(window.__FEILIN_RE__ || window.__FEILIN_EXPORT_RE__, 40),
            stack: String(new Error('JSON_STRINGIFY').stack || '').slice(0, 1200),
            stackSourceSnippets: extractStackSourceSnippets(String(new Error('JSON_STRINGIFY').stack || ''), candidateSourceFiles, 260),
          });
          if (window.__JSON_STRINGIFY_LOGS__.length > 120) window.__JSON_STRINGIFY_LOGS__.shift();
          jsonStringifyLogDepth -= 1;
        }
      }
    } catch {
      // ignore stringify logging errors
      jsonStringifyLogDepth = 0;
    }
    return out;
  };
  const nativeBtoa = window.btoa;
  if (Array.isArray(options.stringSliceTargets) && options.stringSliceTargets.length > 0) {
    const nativeStringSlice = String.prototype.slice;
    const targets = options.stringSliceTargets
      .filter((x) => typeof x === 'string' && x)
      .slice(0, 12);
    String.prototype.slice = function patchedStringSlice(...args) {
      const raw = String(this ?? '');
      const out = nativeStringSlice.apply(raw, args);
      try {
        if (raw && raw.length >= 8 && targets.some((target) => raw === target || raw.includes(target) || target.includes(raw))) {
          window.__STRING_SLICE_LOGS__ = window.__STRING_SLICE_LOGS__ || [];
          window.__STRING_SLICE_LOGS__.push({
            raw: nativeStringSlice.call(raw, 0, 400),
            rawLength: raw.length,
            args: args.map((x) => typeof x === 'number' ? x : previewValue(x, 80)),
            output: typeof out === 'string' ? nativeStringSlice.call(out, 0, 400) : previewValue(out, 120),
            outputLength: typeof out === 'string' ? out.length : null,
            stack: String(new Error('STRING_SLICE').stack || '').slice(0, 1200),
          });
          if (window.__STRING_SLICE_LOGS__.length > 200) window.__STRING_SLICE_LOGS__.shift();
        }
      } catch {
        // ignore slice logging errors
      }
      return out;
    };
  }
  if (Array.isArray(options.stringOpTargets) && options.stringOpTargets.length > 0) {
    const nativeStringSlice = String.prototype.slice;
    const nativeStringSplit = String.prototype.split;
    const nativeStringIndexOf = String.prototype.indexOf;
    const nativeStringStartsWith = String.prototype.startsWith;
    const targets = options.stringOpTargets
      .filter((x) => typeof x === 'string' && x)
      .slice(0, 12);
    const matchesStringTarget = (raw) => (
      raw &&
      raw.length >= 4 &&
      targets.some((target) => raw === target || raw.includes(target) || target.includes(raw))
    );
    const pushStringOpLog = (entry) => {
      try {
        window.__STRING_OP_LOGS__ = window.__STRING_OP_LOGS__ || [];
        window.__STRING_OP_LOGS__.push(entry);
        if (window.__STRING_OP_LOGS__.length > 1200) window.__STRING_OP_LOGS__.shift();
      } catch {
        // ignore
      }
    };
    String.prototype.split = function patchedStringSplit(...args) {
      const raw = String(this ?? '');
      const out = nativeStringSplit.apply(raw, args);
      try {
        if (matchesStringTarget(raw)) {
          pushStringOpLog({
            op: 'split',
            raw: nativeStringSlice.call(raw, 0, 500),
            rawLength: raw.length,
            sep: typeof args[0] === 'string' ? args[0].slice(0, 120) : previewValue(args[0], 80),
            limit: args.length > 1 ? args[1] : null,
            outCount: Array.isArray(out) ? out.length : null,
            outHead: Array.isArray(out) ? out.slice(0, 8).map((x) => typeof x === 'string' ? x.slice(0, 120) : previewValue(x, 60)) : null,
            stack: String((new Error('STRING_OP_SPLIT')).stack || '').slice(0, 1200),
          });
        }
      } catch {
        // ignore split logging errors
      }
      return out;
    };
    String.prototype.indexOf = function patchedStringIndexOf(...args) {
      const raw = String(this ?? '');
      const out = nativeStringIndexOf.apply(raw, args);
      try {
        if (matchesStringTarget(raw)) {
          pushStringOpLog({
            op: 'indexOf',
            raw: nativeStringSlice.call(raw, 0, 500),
            rawLength: raw.length,
            needle: typeof args[0] === 'string' ? args[0].slice(0, 120) : previewValue(args[0], 80),
            fromIndex: args.length > 1 ? args[1] : null,
            result: out,
            stack: String((new Error('STRING_OP_INDEXOF')).stack || '').slice(0, 1200),
          });
        }
      } catch {
        // ignore indexOf logging errors
      }
      return out;
    };
    String.prototype.startsWith = function patchedStringStartsWith(...args) {
      const raw = String(this ?? '');
      const out = nativeStringStartsWith.apply(raw, args);
      try {
        if (matchesStringTarget(raw)) {
          pushStringOpLog({
            op: 'startsWith',
            raw: nativeStringSlice.call(raw, 0, 500),
            rawLength: raw.length,
            needle: typeof args[0] === 'string' ? args[0].slice(0, 120) : previewValue(args[0], 80),
            fromIndex: args.length > 1 ? args[1] : null,
            result: out,
            stack: String((new Error('STRING_OP_STARTSWITH')).stack || '').slice(0, 1200),
          });
        }
      } catch {
        // ignore startsWith logging errors
      }
      return out;
    };
  }
  if (Array.isArray(options.stringCharOpTargets) && options.stringCharOpTargets.length > 0) {
    const nativeStringSlice = String.prototype.slice;
    const nativeCharCodeAtTargeted = String.prototype.charCodeAt;
    const nativeCharAtTargeted = String.prototype.charAt;
    const targets = options.stringCharOpTargets
      .filter((x) => typeof x === 'string' && x)
      .slice(0, 12);
    const matchesCharTarget = (raw) => (
      raw &&
      raw.length >= 4 &&
      targets.some((target) => raw === target || raw.includes(target) || target.includes(raw))
    );
    const pushCharOpLog = (entry) => {
      try {
        window.__STRING_CHAR_OP_LOGS__ = window.__STRING_CHAR_OP_LOGS__ || [];
        window.__STRING_CHAR_OP_LOGS__.push(entry);
        if (window.__STRING_CHAR_OP_LOGS__.length > 4000) window.__STRING_CHAR_OP_LOGS__.shift();
      } catch {
        // ignore
      }
    };
    String.prototype.charCodeAt = function patchedTargetedCharCodeAt(index) {
      const raw = String(this ?? '');
      const out = nativeCharCodeAtTargeted.call(raw, index);
      try {
        if (matchesCharTarget(raw)) {
          pushCharOpLog({
            op: 'charCodeAt',
            raw: nativeStringSlice.call(raw, 0, 500),
            rawLength: raw.length,
            index,
            code: out,
            stack: String((new Error('STRING_CHAR_OP_CODE')).stack || '').slice(0, 1200),
          });
        }
      } catch {
        // ignore
      }
      return out;
    };
    String.prototype.charAt = function patchedTargetedCharAt(index) {
      const raw = String(this ?? '');
      const out = nativeCharAtTargeted.call(raw, index);
      try {
        if (matchesCharTarget(raw)) {
          pushCharOpLog({
            op: 'charAt',
            raw: nativeStringSlice.call(raw, 0, 500),
            rawLength: raw.length,
            index,
            ch: out,
            code: out ? out.charCodeAt(0) : null,
            stack: String((new Error('STRING_CHAR_OP_AT')).stack || '').slice(0, 1200),
          });
        }
      } catch {
        // ignore
      }
      return out;
    };
  }
  const nativeCharCodeAt = String.prototype.charCodeAt;
  String.prototype.charCodeAt = function patchedCharCodeAt(index) {
    const out = nativeCharCodeAt.call(this, index);
    try {
      const str = String(this ?? '');
      if (Array.isArray(options.stringCharOpTargets) && options.stringCharOpTargets.length > 0) {
        const charTargets = options.stringCharOpTargets
          .filter((x) => typeof x === 'string' && x)
          .slice(0, 12);
        if (
          str &&
          str.length >= 4 &&
          charTargets.some((target) => str === target || str.includes(target) || target.includes(str))
        ) {
          window.__STRING_CHAR_OP_LOGS__ = window.__STRING_CHAR_OP_LOGS__ || [];
          window.__STRING_CHAR_OP_LOGS__.push({
            op: 'charCodeAt',
            raw: str.slice(0, 500),
            rawLength: str.length,
            index,
            code: out,
            stack: String((new Error('STRING_CHAR_OP_CODE')).stack || '').slice(0, 1200),
          });
          if (window.__STRING_CHAR_OP_LOGS__.length > 4000) {
            window.__STRING_CHAR_OP_LOGS__.shift();
          }
        }
      }
      const vmN = window.__T_VM_LAST__?.n ?? null;
      if (
        vmN != null &&
        vmN > 1100 &&
        str.length >= 1 &&
        str.length <= 260
      ) {
        window.__STRING_CHARCODE_LOGS__ = window.__STRING_CHARCODE_LOGS__ || [];
        window.__STRING_CHARCODE_LOGS__.push({
          inputLen: str.length,
          inputPreview: str.slice(0, 240),
          index,
          code: out,
          n: vmN,
          opcodeWindow: window.__T_VM_LAST__?.opcodeWindow ?? null,
        });
        if (window.__STRING_CHARCODE_LOGS__.length > 5000) {
          window.__STRING_CHARCODE_LOGS__.shift();
        }
      }
    } catch {
      // ignore charCodeAt logging errors
    }
    return out;
  };
  const nativeFromCharCode = String.fromCharCode;
  String.fromCharCode = function patchedFromCharCode(...args) {
    const out = nativeFromCharCode.apply(String, args);
    try {
      const vmN = window.__T_VM_LAST__?.n ?? null;
      if (
        args.length === 1 &&
        typeof args[0] === 'number' &&
        vmN != null &&
        vmN > 1100
      ) {
        window.__STRING_FROMCHARCODE_LOGS__ = window.__STRING_FROMCHARCODE_LOGS__ || [];
        window.__STRING_FROMCHARCODE_LOGS__.push({
          arg: args[0],
          ch: out,
          code: out.charCodeAt(0),
          n: vmN,
          opcodeWindow: window.__T_VM_LAST__?.opcodeWindow ?? null,
        });
        if (window.__STRING_FROMCHARCODE_LOGS__.length > 5000) {
          window.__STRING_FROMCHARCODE_LOGS__.shift();
        }
      }
    } catch {
      // ignore fromCharCode logging errors
    }
    return out;
  };
  window.btoa = (value) => {
    try {
      const str = String(value ?? '');
      const out = nativeBtoa(str);
      if (
        str.length >= 24 ||
        str.includes('SG_WEB') ||
        str.includes('certifyId') ||
        str.includes('sceneId')
      ) {
        window.__BTOA_LOGS__ = window.__BTOA_LOGS__ || [];
        let caller = null;
        let callerSource = null;
        let callerArgs = null;
        try {
          caller = window.btoa.caller || null;
        } catch {
          caller = null;
        }
        try {
          callerSource = caller ? String(caller).slice(0, 1200) : null;
        } catch {
          callerSource = null;
        }
        try {
          callerArgs = caller?.arguments
            ? Array.from(caller.arguments).slice(0, 12).map((item) => previewValue(item, 200))
            : null;
        } catch {
          callerArgs = null;
        }
        window.__BTOA_LOGS__.push({
          inputLen: str.length,
          inputPreview: str.slice(0, 800),
          inputHexPreview: byteLikeHexPreview(Buffer.from(str, 'latin1'), 160),
          outputLength: out.length,
          outputPreview: out.slice(0, 400),
          vmState: window.__T_VM_LAST__ || null,
          callerSource,
          callerArgs,
          stack: String(new Error('btoa').stack || '').slice(0, 1200),
          stackSourceSnippets: extractStackSourceSnippets(String(new Error('btoa').stack || ''), candidateSourceFiles, 260),
        });
      }
      return out;
    } catch (err) {
      recorder.push('error', 'window.btoa', { error: String(err && err.stack || err) });
      throw err;
    }
  };
  const jsonProbeProxyCache = new WeakMap();
  const jsonProbeProxySet = new WeakSet();
  const wrapParsedProbeObject = (value, rootLabel) => {
    if (!value || typeof value !== 'object') return value;
    if (jsonProbeProxyCache.has(value)) return jsonProbeProxyCache.get(value);
    const proxy = new Proxy(value, {
      get(target, prop, receiver) {
        const nextPath = `${rootLabel}.${String(prop)}`;
        try {
          window.__PROBE_JSON_ACCESS_LOGS__ = window.__PROBE_JSON_ACCESS_LOGS__ || [];
          window.__PROBE_JSON_ACCESS_LOGS__.push({
            path: nextPath,
            valueType: typeof target[prop],
            preview: previewValue(target[prop], 200),
            stack: String(new Error('probe-json-get').stack || '').slice(0, 1200),
          });
        } catch {
          // ignore probe-only logging errors
        }
        const current = Reflect.get(target, prop, receiver);
        return wrapParsedProbeObject(current, nextPath);
      },
      ownKeys(target) {
        try {
          window.__PROBE_JSON_ACCESS_LOGS__ = window.__PROBE_JSON_ACCESS_LOGS__ || [];
          window.__PROBE_JSON_ACCESS_LOGS__.push({
            path: `${rootLabel}.[[ownKeys]]`,
            valueType: 'object',
            preview: Reflect.ownKeys(target).map(String).slice(0, 40),
            stack: String(new Error('probe-json-ownKeys').stack || '').slice(0, 1200),
          });
        } catch {
          // ignore
        }
        return Reflect.ownKeys(target);
      },
    });
    jsonProbeProxyCache.set(value, proxy);
    jsonProbeProxySet.add(proxy);
    return proxy;
  };
  const nativeJsonParse = JSON.parse.bind(JSON);
  JSON.parse = function patchedJsonParse(text, reviver) {
    const parsed = nativeJsonParse(text, reviver);
    try {
      if (typeof text === 'string' && (
        text.includes('probe-log1-request-id') ||
        text.includes('probe-log2-request-id') ||
        text.includes('probe-init-request-id') ||
        text.includes('probe-verify-request-id')
      )) {
        window.__PROBE_JSON_PARSE_LOGS__ = window.__PROBE_JSON_PARSE_LOGS__ || [];
        window.__PROBE_JSON_PARSE_LOGS__.push({
          textPreview: text.slice(0, 600),
          parsedKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 40) : [],
        });
        if (parsed && typeof parsed === 'object') {
          return wrapParsedProbeObject(parsed, '$');
        }
      }
    } catch {
      // ignore probe-only logging errors
    }
    return parsed;
  };
  const nativeObjectAssign = Object.assign.bind(Object);
  Object.assign = function patchedObjectAssign(target, ...sources) {
    try {
      const touchesAliyunRuntimeCredentials =
        hasAliyunRuntimeTraceKeys(target) ||
        !!target?.__ztoapiAliyunRuntimeProxyPath__ ||
        sources.some((source) =>
          (source && typeof source === 'object' && hasAliyunRuntimeTraceKeys(source)) ||
          jsonProbeProxySet.has(source) ||
          !!source?.__ztoapiAliyunRuntimeProxyPath__,
        );
      if (touchesAliyunRuntimeCredentials) {
        pushAliyunRuntimeCredentialLog(window, {
          stage: 'object-assign.before',
          targetPath: target?.__ztoapiAliyunRuntimeProxyPath__ || null,
          targetShape: snapshotObjectShape(target, 24),
          targetKeys: target && typeof target === 'object' ? Reflect.ownKeys(target).map(String).slice(0, 30) : [],
          sourceShapes: sources.map((source) => snapshotObjectShape(source, 16)),
          sourceKeys: sources.map((source) => source && typeof source === 'object'
            ? Reflect.ownKeys(source).map(String).slice(0, 20)
            : []),
          stack: String(new Error('ALIYUN_RUNTIME_OBJECT_ASSIGN').stack || '').slice(0, 1200),
          stackSourceSnippets: extractStackSourceSnippets(
            String(new Error('ALIYUN_RUNTIME_OBJECT_ASSIGN').stack || ''),
            candidateSourceFiles,
            260,
          ),
        });
      }
      if (
        jsonProbeProxySet.has(target) ||
        sources.some((source) => source && typeof source === 'object' && jsonProbeProxySet.has(source))
      ) {
        window.__PROBE_ASSIGN_LOGS__ = window.__PROBE_ASSIGN_LOGS__ || [];
        window.__PROBE_ASSIGN_LOGS__.push({
          targetBefore: snapshotObjectShape(target),
          sourceShapes: sources.map((source) => snapshotObjectShape(source)),
        });
        const result = nativeObjectAssign(target, ...sources);
        window.__PROBE_ASSIGN_LOGS__.push({
          targetAfter: snapshotObjectShape(target),
          resultShape: snapshotObjectShape(result),
        });
        if (touchesAliyunRuntimeCredentials) {
          pushAliyunRuntimeCredentialLog(window, {
            stage: 'object-assign.after',
            targetPath: target?.__ztoapiAliyunRuntimeProxyPath__ || null,
            targetShape: snapshotObjectShape(target, 24),
            resultShape: snapshotObjectShape(result, 24),
          });
        }
        return result;
      }
      if (touchesAliyunRuntimeCredentials) {
        const result = nativeObjectAssign(target, ...sources);
        pushAliyunRuntimeCredentialLog(window, {
          stage: 'object-assign.after',
          targetPath: target?.__ztoapiAliyunRuntimeProxyPath__ || null,
          targetShape: snapshotObjectShape(target, 24),
          resultShape: snapshotObjectShape(result, 24),
        });
        return result;
      }
    } catch {
      // ignore probe-only logging errors
    }
    return nativeObjectAssign(target, ...sources);
  };
  const umTrace = installWindowObjectTracer(window, recorder, 'um');
  const zUmTrace = installWindowObjectTracer(window, recorder, 'z_um');
  installAliyunRuntimeCredentialHooks(window, candidateSourceFiles);
  if (options.initialAliyunCaptchaConfig && options.setGlobalAliyunCaptchaConfig !== false) {
    window.AliyunCaptchaConfig = { ...options.initialAliyunCaptchaConfig };
  }
  let initAliyunCaptchaValue;
  Object.defineProperty(window, 'initAliyunCaptcha', {
    configurable: true,
    enumerable: true,
    get() {
      return initAliyunCaptchaValue;
    },
    set(value) {
      initAliyunCaptchaValue = wrapInitAliyunCaptcha(window, value, {
        mutateInitConfig: options.mutateInitAliyunCaptchaConfig === true,
      });
    },
  });
  document.defaultView = window;

  const context = {
    window,
    self: window,
    globalThis: window,
    document,
    navigator,
    location: window.location,
    history: window.history,
    localStorage,
    sessionStorage,
    indexedDB,
    screen: window.screen,
    performance: window.performance,
    Element: window.Element,
    Node: window.Node,
    NodeList: window.NodeList,
    HTMLCollection: window.HTMLCollection,
    Window: window.Window,
    Screen: window.Screen,
    Range: window.Range,
    Attr: window.Attr,
    NamedNodeMap: window.NamedNodeMap,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLCanvasElement: window.HTMLCanvasElement,
    Document: window.Document,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    Option: window.Option,
    History: window.History,
    Image: window.Image,
    Audio: window.Audio,
    Text: window.Text,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    KeyboardEvent: window.KeyboardEvent,
    Touch: window.Touch,
    TouchEvent: window.TouchEvent,
    MediaStream: window.MediaStream,
    MediaSource: window.MediaSource,
    DeviceMotionEvent: window.DeviceMotionEvent,
    XMLHttpRequest: window.XMLHttpRequest,
    AudioContext: window.AudioContext,
    OfflineAudioContext: window.OfflineAudioContext,
    webkitAudioContext: window.webkitAudioContext,
    Worker: window.Worker,
    MessageChannel: window.MessageChannel,
    Storage: window.Storage,
    EventTarget: window.EventTarget,
    Blob,
    File,
    FormData,
    Promise,
    Math,
    Date: ProbedDate,
    JSON,
    String,
    Array,
    Object,
    RegExp,
    Number,
    Boolean,
    Error,
    TypeError,
    Symbol,
    Reflect,
    Proxy,
    ArrayBuffer,
    DataView,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    parseInt,
    parseFloat,
    isNaN,
    escape,
    unescape,
    encodeURIComponent,
    decodeURIComponent,
    Uint8Array,
    Uint8ClampedArray,
    setTimeout: browserSetTimeout,
    clearTimeout: browserClearTimeout,
    setInterval: browserSetInterval,
    clearInterval: browserClearInterval,
    open: window.open,
    alert: window.alert,
    confirm: window.confirm,
    prompt: window.prompt,
    resizeBy: window.resizeBy,
    resizeTo: window.resizeTo,
    moveBy: window.moveBy,
    blur: window.blur,
    focus: window.focus,
    scroll: window.scroll,
    scrollBy: window.scrollBy,
    scrollTo: window.scrollTo,
    moveTo: window.moveTo,
    close: window.close,
    console: silentConsole,
    print() {},
    atob: window.atob,
    btoa: window.btoa,
    decodeBase64Utf8: window.decodeBase64Utf8,
    previewValue: window.previewValue,
    snapshotObjectShape: window.snapshotObjectShape,
    wordArrayToHexPreview: window.wordArrayToHexPreview,
    crypto: window.crypto,
    fetch: window.fetch,
    URL,
    Location,
    URLSearchParams,
    AbortController,
    Headers,
    Request,
    Response,
    CSS: window.CSS,
    CSSRule: window.CSSRule,
    CSSCounterStyleRule: window.CSSCounterStyleRule,
    matchMedia: window.matchMedia,
    getComputedStyle: window.getComputedStyle,
    define: undefined,
    exports: undefined,
    module: undefined,
    require: undefined,
    print() {},
  };
  return { context: vm.createContext(context), window, recorder, xhrLog, umTrace, zUmTrace, mediaDeviceLogs, consoleLogBuffer };
}

function dispatchSyntheticEvents(window, events = []) {
  if (!window?.document || !Array.isArray(events)) return;
  let previousPoint = null;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const type = String(event.type || '');
    if (!type) continue;
    let target = window.document;
    if (event.target === 'window') target = window;
    else if (event.target === 'body') target = window.document.body;
    else if (event.target === 'button') target = window.document.getElementById('chat-captcha-trigger') || window.document.body;
    else if (event.target === 'holder') target = window.document.getElementById('chat-captcha-element') || window.document.body;
    const init = {
      type,
      bubbles: event.bubbles !== false,
      cancelable: event.cancelable !== false,
      clientX: Number(event.clientX || 0),
      clientY: Number(event.clientY || 0),
      pageX: Number(event.pageX ?? event.clientX ?? 0),
      pageY: Number(event.pageY ?? event.clientY ?? 0),
      screenX: Number(event.screenX ?? event.clientX ?? 0),
      screenY: Number(event.screenY ?? event.clientY ?? 0),
      movementX: Number(event.movementX ?? (previousPoint ? Number(event.clientX || 0) - previousPoint.x : 0)),
      movementY: Number(event.movementY ?? (previousPoint ? Number(event.clientY || 0) - previousPoint.y : 0)),
      button: Number(event.button || 0),
      buttons: Number(event.buttons ?? (type === 'mouseup' ? 0 : 1)),
      pointerId: Number(event.pointerId || 1),
      pointerType: String(event.pointerType || 'mouse'),
      isPrimary: event.isPrimary !== false,
      width: Number(event.width || 1),
      height: Number(event.height || 1),
      pressure: Number(event.pressure ?? ((event.buttons ?? (type === 'mouseup' ? 0 : 1)) ? 0.5 : 0)),
      key: event.key || '',
      code: event.code || '',
      keyCode: Number(event.keyCode || 0),
      which: Number(event.which || event.keyCode || 0),
      charCode: Number(event.charCode || 0),
      ctrlKey: !!event.ctrlKey,
      shiftKey: !!event.shiftKey,
      altKey: !!event.altKey,
      metaKey: !!event.metaKey,
      timeStamp: Number(event.timeStamp || Date.now()),
      target,
    };
    if (/^pointer/.test(type)) {
      target.dispatchEvent(new window.PointerEvent(type, init));
    } else if (/^mouse|click/.test(type)) {
      target.dispatchEvent(new window.MouseEvent(type, init));
    } else if (/^key/.test(type)) {
      target.dispatchEvent(new window.KeyboardEvent(type, init));
    } else if (/^touch/.test(type)) {
      const touch = new window.Touch(init);
      target.dispatchEvent(new window.TouchEvent(type, {
        ...init,
        touches: type === 'touchend' ? [] : [touch],
        targetTouches: type === 'touchend' ? [] : [touch],
        changedTouches: [touch],
      }));
    } else {
      target.dispatchEvent(new window.Event(type, init));
    }
    previousPoint = { x: Number(event.clientX || 0), y: Number(event.clientY || 0) };
  }
}

async function runProbe(files, options = {}) {
  const asyncErrors = [];
  const onUnhandledRejection = (err) => {
    asyncErrors.push(`unhandledRejection: ${String(err && err.stack || err)}`);
  };
  const onUncaughtException = (err) => {
    asyncErrors.push(`uncaughtException: ${String(err && err.stack || err)}`);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  const cwd = process.cwd();
  const resolveExisting = (p) => {
    if (!p) return null;
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    return fs.existsSync(abs) ? abs : null;
  };
  const effectiveFiles = Array.isArray(files) && files.length > 0 ? [...files] : ['/tmp/feilin.js'];
  const defaultMappings = [
    {
      pattern: 'dynamicJS',
      file: effectiveFiles.find((file) => /aliyun-pe|dynamicJS|\/pe\./i.test(String(file))) || resolveExisting('/tmp/aliyun-pe.js'),
    },
    {
      pattern: 'FeiLin',
      file: effectiveFiles.find((file) => /feilin/i.test(String(file))) || resolveExisting('/tmp/feilin.js'),
    },
  ].filter((x) => x.file && fs.existsSync(x.file));
  const { context, window, recorder, xhrLog, umTrace, zUmTrace, mediaDeviceLogs, consoleLogBuffer } = createContext(makeRecorder(), {
    scriptMappings: [...defaultMappings, ...((options.scriptMappings || []).filter(Boolean))],
    sourceFiles: effectiveFiles,
    patchAliyunOptions: {
      exposeReverseHelpers: options.exposeReverseHelpers,
      literalSnippetPatches: Array.isArray(options.literalSnippetPatches) ? options.literalSnippetPatches : null,
      offsetSnippetPatches: Array.isArray(options.offsetSnippetPatches) ? options.offsetSnippetPatches : null,
    },
    ...options,
  });
  const initialWindowKeys = new Set(Reflect.ownKeys(window).map(String));
  const report = {
    files: effectiveFiles,
    evalOk: false,
    evalError: null,
    failedFile: null,
    missingGlobal: null,
    patchFallbacks: [],
    newWindowKeys: [],
    newWindowKeyPreview: {},
    initAliyunCaptchaType: null,
    initAliyunCaptchaPreview: null,
    ayfKeys: [],
    ayfType: null,
    ayfPreview: null,
    ayfGetDeviceTokenType: null,
    ayfGetDeviceTokenValue: null,
    ayfGetDeviceTokenValuePreview: null,
    ayfGetDeviceTokenError: null,
    scriptLoadLogs: [],
    autoInit: null,
    umExists: false,
    umKeys: [],
    zUmKeys: [],
    getTokenType: null,
    zGetTokenType: null,
    getTokenError: null,
    zGetTokenError: null,
    getTokenValue: null,
    zGetTokenValue: null,
    getTokenValuePreview: null,
    zGetTokenValuePreview: null,
    getTokenDecodedPreview: null,
    zGetTokenDecodedPreview: null,
    getTokenSourcePreview: null,
    zGetTokenSourcePreview: null,
    umCameraInfoPreview: null,
    zUmCameraInfoPreview: null,
    umObjectSnapshot: null,
    zUmObjectSnapshot: null,
    aliyunInitStateSnapshot: null,
    aliyunInitPreCollectDataSnapshot: null,
    aliyunPrecollectSnapshot: null,
    liveCheckChainState: null,
    aliyunRuntimeCredentialLogs: [],
    aliyunExtendAssignLogs: [],
    peKLogs: [],
    peDeflateLogs: [],
    btoaLogs: [],
    joinLogs: [],
    rlLogs: [],
    feilinIoLogs: [],
    feilinIuLogs: [],
    tokenPathLogs: [],
    feilinIoExposed: false,
    feilinIuExposed: false,
    ioMutationExperiment: null,
    iuMutationExperiment: null,
    manualTokenExperiment: null,
    mediaDeviceLogs: [],
    feilinSbTrace: [],
    feilinUbLogs: [],
    feilinUyLogs: [],
    feilinUuLogs: [],
    feilinUDollarLogs: [],
    feilinBeLogs: [],
    peTdCalls: [],
    peTy2Calls: [],
    peNcCalls: [],
    n0GLogs: [],
    n0PartLogs: [],
    feilinStLogs: [],
    feilinSeSnapshot: null,
    feilinSaSnapshot: null,
    feilinReSnapshot: null,
    feilinLastSessionDeriveSnapshot: null,
    feilinSessionDeriveLogs: [],
    feilinDeriveSecretBlobSnapshot: null,
    feilinDeriveSessionBlobSnapshot: null,
    probeJsonParseLogs: [],
    probeJsonAccessLogs: [],
    probeAssignLogs: [],
    extendConsumeLogs: [],
    stringOpLogs: [],
    stringCharOpLogs: [],
    extendTableExperiment: null,
    reMutationExperiment: null,
    rkMutationApplied: null,
    feilinRkSnapshotAfterMutation: null,
    feilinRsSelectorLogs: [],
    sessionIdBlobExperiment: null,
    verifyHelperExperiment: null,
    rsExperiment: null,
    rsExperimentPhases: null,
    asyncErrors: [],
    xhrLog: [],
    consoleLogs: [],
  };

  const waitForLiveXhrSettle = async ({
    timeoutMs = 4000,
    pollMs = 100,
  } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let lastSize = -1;
    let lastChangeAt = Date.now();
    while (Date.now() < deadline) {
      const size = xhrLog.length;
      if (size !== lastSize) {
        lastSize = size;
        lastChangeAt = Date.now();
      }
      const verifyEntries = xhrLog.filter((entry) => entry?.params?.Action === 'VerifyCaptchaV3');
      const hasVerifyResponse = verifyEntries.some((entry) =>
        entry && (
          entry.responseStatus != null ||
          typeof entry.response === 'string' ||
          entry.responseJson != null
        )
      );
      if (hasVerifyResponse) {
        const log3Entries = xhrLog.filter((entry) => entry?.params?.Action === 'Log3');
        const log3Settled = log3Entries.length === 0 || log3Entries.some((entry) =>
          entry && (
            entry.responseStatus != null ||
            typeof entry.response === 'string' ||
            entry.responseJson != null
          )
        );
        if (log3Settled || Date.now() - lastChangeAt >= 250) {
          break;
        }
      }
      if (verifyEntries.length > 0 && Date.now() - lastChangeAt >= 500) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };

  const shouldRunRsExperimentAt = (phase) => {
    const raw = options.rsExperimentPhase;
    if (raw == null) {
      return phase === 'after-auto-init';
    }
    if (typeof raw === 'string') {
      return raw === phase || raw === 'all';
    }
    if (Array.isArray(raw)) {
      return raw.includes(phase) || raw.includes('all');
    }
    return phase === 'after-auto-init';
  };

  const executeRsExperiment = (phaseLabel) => {
    if (typeof window.__FEILIN_RS__ !== 'function') {
      return null;
    }
    try {
      let rows = Array.isArray(options.rsExperimentInputs) ? options.rsExperimentInputs.slice() : [];
      if ((!rows || rows.length === 0) && options.rsExperimentBuiltinBestVector) {
        const liveReport = {
          n0PartLogs: Array.isArray(window.__N0_PART_LOGS__) ? window.__N0_PART_LOGS__ : [],
        };
        const vector = buildTokenVectorFromReport(liveReport);
        if (vector?.trPreview && vector?.xPrefix) {
          const lPreview = buildTokenLPreviewFromVector(vector);
          rows = [
            { label: 'best-vector-tr', arg0: vector.trPreview, arg1: lPreview, thisKind: 'undefined' },
            { label: 'best-vector-x', arg0: vector.xPrefix, arg1: lPreview, thisKind: 'undefined' },
          ];
        }
      }
      if (!rows || rows.length === 0) {
        return null;
      }
      return rows.map((row) => {
        const label = row && Object.prototype.hasOwnProperty.call(row, 'label') ? row.label : null;
        const arg0 = row && Object.prototype.hasOwnProperty.call(row, 'arg0') ? row.arg0 : undefined;
        const arg1 = row && Object.prototype.hasOwnProperty.call(row, 'arg1') ? row.arg1 : undefined;
        const thisKind = row && Object.prototype.hasOwnProperty.call(row, 'thisKind') ? row.thisKind : null;
        try {
          const rsStart = Array.isArray(window.__FEILIN_RS_LOGS__) ? window.__FEILIN_RS_LOGS__.length : 0;
          const rsInnerStart = Array.isArray(window.__FEILIN_RS_INNER_LOGS__) ? window.__FEILIN_RS_INNER_LOGS__.length : 0;
          const arg1ProxyStart = Array.isArray(window.__RS_ARG1_PROXY_LOGS__) ? window.__RS_ARG1_PROXY_LOGS__.length : 0;
          const cryptoTraceStart = Array.isArray(window.__CRYPTO_TRACE_LOGS__) ? window.__CRYPTO_TRACE_LOGS__.length : 0;
          const raTraceStart = Array.isArray(window.__FEILIN_RA20_LOGS__) ? window.__FEILIN_RA20_LOGS__.length : 0;
          let thisArg = window;
          if (thisKind === 'last-rs') thisArg = window.__FEILIN_RS_LAST_THIS__ || window;
          else if (thisKind === 'last-rx') thisArg = window.__FEILIN_RX_LAST_THIS__ || window;
          else if (thisKind === 'null') thisArg = null;
          else if (thisKind === 'undefined') thisArg = undefined;
          let effectiveArg1 = arg1;
          if (row?.wrapArg1AsStringProxy && typeof arg1 === 'string') {
            const source = new String(arg1);
            effectiveArg1 = new Proxy(source, {
              get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver);
                try {
                  window.__RS_ARG1_PROXY_LOGS__ = window.__RS_ARG1_PROXY_LOGS__ || [];
                  const propName = String(prop);
                  window.__RS_ARG1_PROXY_LOGS__.push({
                    label,
                    phase: phaseLabel,
                    prop: propName,
                    valueType: typeof value,
                    valuePreview: typeof value === 'string'
                      ? value.slice(0, 240)
                      : typeof value === 'function'
                      ? String(value).slice(0, 240)
                      : previewValue(value, 160),
                    stack: String((new Error('RS_ARG1_PROXY_GET')).stack || '').slice(0, 1200),
                  });
                  if (window.__RS_ARG1_PROXY_LOGS__.length > 2000) {
                    window.__RS_ARG1_PROXY_LOGS__.shift();
                  }
                } catch {
                  // ignore
                }
                if (typeof value === 'function') {
                  return function proxiedMethod(...methodArgs) {
                    try {
                      window.__RS_ARG1_PROXY_LOGS__ = window.__RS_ARG1_PROXY_LOGS__ || [];
                      window.__RS_ARG1_PROXY_LOGS__.push({
                        label,
                        phase: phaseLabel,
                        prop: String(prop),
                        call: true,
                        argsPreview: methodArgs.map((item) => typeof item === 'string' ? item.slice(0, 120) : previewValue(item, 80)),
                        stack: String((new Error('RS_ARG1_PROXY_CALL')).stack || '').slice(0, 1200),
                      });
                      if (window.__RS_ARG1_PROXY_LOGS__.length > 2000) {
                        window.__RS_ARG1_PROXY_LOGS__.shift();
                      }
                    } catch {
                      // ignore
                    }
                    return value.apply(target, methodArgs);
                  };
                }
                return value;
              },
            });
          }
          const rsFn = typeof window.__FEILIN_RS_ORIGINAL__ === 'function'
            ? window.__FEILIN_RS_ORIGINAL__
            : window.__FEILIN_RS__;
          const out = rsFn.apply(thisArg, [arg0, effectiveArg1]);
          let outString = null;
          try {
            outString = typeof out === 'string' ? out : String(out);
          } catch {
            outString = null;
          }
          const details = typeof window.captureRsOutputDetails === 'function'
            ? window.captureRsOutputDetails(out)
            : null;
          const rsDelta = (window.__FEILIN_RS_LOGS__ || []).slice(rsStart);
          const rsInnerDelta = (window.__FEILIN_RS_INNER_LOGS__ || []).slice(rsInnerStart);
          const arg1ProxyDelta = (window.__RS_ARG1_PROXY_LOGS__ || []).slice(arg1ProxyStart);
          const cryptoTraceDelta = (window.__CRYPTO_TRACE_LOGS__ || []).slice(cryptoTraceStart);
          const raTraceDelta = (window.__FEILIN_RA20_LOGS__ || []).slice(raTraceStart);
          const lastRsLog = rsDelta.length ? rsDelta[rsDelta.length - 1] : null;
          return {
            phase: phaseLabel,
            label,
            thisKind,
            thisType: typeof thisArg,
            thisCtor: thisArg && thisArg.constructor && thisArg.constructor.name ? thisArg.constructor.name : null,
            thisKeys: thisArg && typeof thisArg === 'object' ? Object.keys(thisArg).slice(0, 20) : null,
            arg0: typeof arg0 === 'string' ? arg0.slice(0, 400) : previewValue(arg0, 200),
            arg1Length: typeof arg1 === 'string' ? arg1.length : null,
            arg1Preview: typeof arg1 === 'string' ? arg1.slice(0, 800) : previewValue(arg1, 300),
            outputType: typeof out,
            outputPreview: typeof out === 'string' ? out.slice(0, 400) : previewValue(out, 200),
            outputString: typeof outString === 'string' ? outString.slice(0, 1200) : null,
            outputStringLength: typeof outString === 'string' ? outString.length : null,
            outputDecodedPreview: typeof outString === 'string' ? decodeBase64Utf8(outString, 400) : null,
            lastAId: lastRsLog?.lastAId ?? null,
            innerLogCount: Array.isArray(lastRsLog?.innerStages) ? lastRsLog.innerStages.length : rsInnerDelta.length,
            innerStages: Array.isArray(lastRsLog?.innerStages)
              ? lastRsLog.innerStages.slice(0, 20)
              : rsInnerDelta.map((x) => x?.stage || null).slice(0, 20),
            innerThrow: lastRsLog?.innerThrow || rsInnerDelta.find((x) => x?.stage === 'method-throw') || null,
            innerLogs: rsInnerDelta.slice(0, 20).map((entry) => ({
              stage: entry?.stage || null,
              aType: entry?.aType || null,
              aId: entry?.aId ?? null,
              aKeys: Array.isArray(entry?.aKeys) ? entry.aKeys.slice(0, 20) : null,
              aSource: typeof entry?.aSource === 'string' ? entry.aSource.slice(0, 400) : null,
              thisType: entry?.thisType || null,
              thisKeys: Array.isArray(entry?.thisKeys) ? entry.thisKeys.slice(0, 20) : null,
              methodKey: entry?.methodKey || null,
              methodType: entry?.methodType || null,
              methodSource: typeof entry?.methodSource === 'string' ? entry.methodSource.slice(0, 400) : null,
              outType: entry?.outType || null,
              outPreview: typeof entry?.outPreview === 'string' ? entry.outPreview.slice(0, 400) : previewValue(entry?.outPreview, 220),
              arg0: typeof entry?.arg0 === 'string' ? entry.arg0.slice(0, 160) : previewValue(entry?.arg0, 120),
              arg1Length: entry?.arg1Length ?? null,
              error: entry?.error || null,
            })),
            arg1ProxyLogs: arg1ProxyDelta.slice(0, 40),
            cryptoTraceLogs: cryptoTraceDelta.slice(0, 40),
            raTraceLogs: raTraceDelta.slice(0, 80),
            ...(details || {}),
          };
        } catch (err) {
          return {
            phase: phaseLabel,
            label,
            thisKind,
            arg0: typeof arg0 === 'string' ? arg0.slice(0, 400) : previewValue(arg0, 200),
            arg1: typeof arg1 === 'string' ? arg1.slice(0, 400) : previewValue(arg1, 200),
            error: String(err && err.stack || err),
          };
        }
      });
    } catch (err) {
      return { error: String(err && err.stack || err), phase: phaseLabel };
    }
  };
  try {
    for (const file of effectiveFiles) {
      const originalSource = fs.readFileSync(file, 'utf8');
      let source = patchAliyunCaptchaSource(originalSource, {
        exposeReverseHelpers: options.exposeReverseHelpers,
        literalSnippetPatches: Array.isArray(options.literalSnippetPatches) ? options.literalSnippetPatches : null,
        offsetSnippetPatches: Array.isArray(options.offsetSnippetPatches) ? options.offsetSnippetPatches : null,
      });
      try {
        new vm.Script(source, { filename: file });
      } catch (patchErr) {
        report.patchFallbacks.push({
          file,
          reason: 'patched-source-parse-failed',
          error: String(patchErr && patchErr.stack || patchErr),
        });
        source = originalSource;
      }
      vm.runInContext(source, context, { timeout: 15000, filename: file });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    wrapFeilinDeriveHelpers(window);
    report.evalOk = true;
  } catch (err) {
    report.evalError = String(err && err.stack || err);
    report.failedFile = effectiveFiles.find((file) => report.evalError.includes(file)) || null;
    const match = report.evalError.match(/ReferenceError:\s+([A-Za-z_$][\w$]*)\s+is not defined/);
    report.missingGlobal = match ? match[1] : null;
  }

  report.newWindowKeys = Reflect.ownKeys(window)
    .map(String)
    .filter((key) => !initialWindowKeys.has(key))
    .sort();
  report.newWindowKeyPreview = Object.fromEntries(
    report.newWindowKeys.slice(0, 20).map((key) => {
      const value = window[key];
      if (typeof value === 'function') return [key, { type: 'function', name: value.name || null }];
      if (value && typeof value === 'object') return [key, { type: 'object', keys: Object.keys(value).slice(0, 20) }];
      return [key, { type: typeof value, value }];
    }),
  );
  report.umExists = !!window.um;
  report.initAliyunCaptchaType = typeof window.initAliyunCaptcha;
  report.initAliyunCaptchaPreview = typeof window.initAliyunCaptcha === 'function'
    ? String(window.initAliyunCaptcha).slice(0, 300)
    : null;
  report.ayfType = typeof window.__AYF;
  report.ayfPreview = typeof window.__AYF === 'function'
    ? String(window.__AYF).slice(0, 300)
    : null;
  report.ayfKeys = window.__AYF ? Object.keys(window.__AYF) : [];
  report.ayfGetDeviceTokenType = window.__AYF ? typeof window.__AYF.getDeviceToken : null;
  report.umKeys = window.um ? Object.keys(window.um) : [];
  report.zUmKeys = window.z_um ? Object.keys(window.z_um) : [];
  report.getTokenType = window.um ? typeof window.um.getToken : null;
  report.zGetTokenType = window.z_um ? typeof window.z_um.getToken : null;
  report.getTokenSourcePreview = previewFunctionSource(window.um?.getToken);
  report.zGetTokenSourcePreview = previewFunctionSource(window.z_um?.getToken);

  if (window.um && typeof window.um.getToken === 'function') {
    try {
      const value = await Promise.resolve(window.um.getToken());
      report.getTokenValue = value;
      report.getTokenValuePreview = typeof value === 'string' ? value.slice(0, 400) : value;
      report.getTokenDecodedPreview = decodeBase64Utf8(value, 400);
    } catch (err) {
      report.getTokenError = String(err && err.stack || err);
    }
  }
  if (window.z_um && typeof window.z_um.getToken === 'function') {
    try {
      const value = await Promise.resolve(window.z_um.getToken());
      report.zGetTokenValue = value;
      report.zGetTokenValuePreview = typeof value === 'string' ? value.slice(0, 400) : value;
      report.zGetTokenDecodedPreview = decodeBase64Utf8(value, 400);
    } catch (err) {
      report.zGetTokenError = String(err && err.stack || err);
    }
  }

  async function captureNamedTokenProbe(prefix, fn) {
    if (typeof fn !== 'function') return;
    try {
      const value = await Promise.resolve(fn());
      report[`${prefix}Value`] = value;
      report[`${prefix}ValuePreview`] = typeof value === 'string' ? value.slice(0, 400) : value;
      report[`${prefix}DecodedPreview`] = decodeBase64Utf8(value, 400);
    } catch (err) {
      report[`${prefix}Error`] = String(err && err.stack || err);
    }
  }

  async function capturePostAutoInitTokenProbes() {
    wrapFeilinDeriveHelpers(window);
    await captureNamedTokenProbe('postAutoInitGetToken', window.um?.getToken?.bind(window.um));
    await captureNamedTokenProbe('postAutoInitZGetToken', window.z_um?.getToken?.bind(window.z_um));
    try {
      const certifyIdCandidates = [
        options.tokenProbeCertifyId,
        Array.isArray(xhrLog)
          ? xhrLog.find((entry) => entry?.params?.Action === 'VerifyCaptchaV3')?.params?.CertifyId || null
          : null,
        options.initialAliyunCaptchaConfig?.UserCertifyId,
        options.initialAliyunCaptchaConfig?.CertifyId,
        options.initialAliyunCaptchaConfig?.certifyId,
      ].filter((value) => typeof value === 'string' && value);
      const certifyId = certifyIdCandidates[0] || null;
      if (certifyId && window.um && typeof window.um.getToken === 'function') {
        const value = await Promise.resolve(window.um.getToken(certifyId));
        report.postAutoInitGetTokenWithCertifyIdValue = value;
        report.postAutoInitGetTokenWithCertifyIdPreview = typeof value === 'string' ? value.slice(0, 400) : value;
        report.postAutoInitGetTokenWithCertifyIdDecodedPreview = decodeBase64Utf8(value, 400);
      }
      if (certifyId && window.z_um && typeof window.z_um.getToken === 'function') {
        const value = await Promise.resolve(window.z_um.getToken(certifyId));
        report.postAutoInitZGetTokenWithCertifyIdValue = value;
        report.postAutoInitZGetTokenWithCertifyIdPreview = typeof value === 'string' ? value.slice(0, 400) : value;
        report.postAutoInitZGetTokenWithCertifyIdDecodedPreview = decodeBase64Utf8(value, 400);
      }
    } catch (err) {
      report.postAutoInitTokenProbeError = String(err && err.stack || err);
    }
  }

  async function captureTokenExecution(fn) {
    let token = null;
    let decoded = null;
    let parsed = null;
    let error = null;
    const joinStart = Array.isArray(window.__JOIN_LOGS__) ? window.__JOIN_LOGS__.length : 0;
    const rlStart = Array.isArray(window.__RL_LOGS__) ? window.__RL_LOGS__.length : 0;
    const n0Start = Array.isArray(window.__N0_G_LOGS__) ? window.__N0_G_LOGS__.length : 0;
    const n0PartStart = Array.isArray(window.__N0_PART_LOGS__) ? window.__N0_PART_LOGS__.length : 0;
    const rsStart = Array.isArray(window.__FEILIN_RS_LOGS__) ? window.__FEILIN_RS_LOGS__.length : 0;
    try {
      token = await Promise.resolve(fn());
      decoded = decodeBase64Utf8(token, 1200);
      parsed = analyzeTokenPlain(decoded);
    } catch (err) {
      error = String(err && err.stack || err);
    }
    const newJoinLogs = (window.__JOIN_LOGS__ || []).slice(joinStart);
    const newRlLogs = (window.__RL_LOGS__ || []).slice(rlStart);
    const newN0Logs = (window.__N0_G_LOGS__ || []).slice(n0Start);
    const newN0PartLogs = (window.__N0_PART_LOGS__ || []).slice(n0PartStart);
    const newRsLogs = (window.__FEILIN_RS_LOGS__ || []).slice(rsStart);
    const firstVLog = newN0PartLogs.find((entry) => entry?.name === 'v') || null;
    return {
      token,
      tokenLength: typeof token === 'string' ? token.length : null,
      tokenPreview: typeof token === 'string' ? token.slice(0, 240) : previewValue(token, 200),
      decoded,
      parsed,
      firstVLog: firstVLog ? {
        value: firstVLog.value ?? null,
        xPreview: typeof firstVLog.xPreview === 'string' ? firstVLog.xPreview.slice(0, 300) : firstVLog.xPreview,
        lPreview: typeof firstVLog.lPreview === 'string' ? firstVLog.lPreview.slice(0, 2400) : firstVLog.lPreview,
        lLength: typeof firstVLog.lLength === 'number' ? firstVLog.lLength : null,
      } : null,
      tokenJoinLogs: newJoinLogs
        .filter((entry) => typeof entry?.output === 'string' && entry.output.includes('SG_WEB'))
        .slice(-4),
      tokenRlLogs: newRlLogs
        .filter((entry) => typeof entry?.input === 'string' && entry.input.includes('SG_WEB'))
        .slice(-4),
      n0GLogs: newN0Logs
        .filter((entry) => typeof entry?.output === 'string' && entry.output.includes('SG_WEB'))
        .slice(-4),
      n0PartLogs: newN0PartLogs
        .filter((entry) => entry?.name === 'tA' || entry?.name === 'v' || entry?.name === 'B' || entry?.name === 'm')
        .slice(-12),
      rsLogs: newRsLogs.slice(-8),
      error,
    };
  }

  if (window.__AYF && typeof window.__AYF.getDeviceToken === 'function') {
    try {
      const value = await Promise.resolve(window.__AYF.getDeviceToken());
      report.ayfGetDeviceTokenValue = value;
      report.ayfGetDeviceTokenValuePreview = typeof value === 'string' ? value.slice(0, 400) : value;
    } catch (err) {
      report.ayfGetDeviceTokenError = String(err && err.stack || err);
    }
  }
  if (window.um && typeof window.um.getCameraInfo === 'function') {
    try {
      report.umCameraInfoPreview = previewValue(await Promise.resolve(window.um.getCameraInfo()), 400);
    } catch (err) {
      report.umCameraInfoPreview = { error: String(err && err.stack || err) };
    }
  }
  if (window.z_um && typeof window.z_um.getCameraInfo === 'function') {
    try {
      report.zUmCameraInfoPreview = previewValue(await Promise.resolve(window.z_um.getCameraInfo()), 400);
    } catch (err) {
      report.zUmCameraInfoPreview = { error: String(err && err.stack || err) };
    }
  }

  const injectCaptchaVerifyCallback = options.injectCaptchaVerifyCallback === true;
  if (shouldRunRsExperimentAt('pre-auto-init')) {
    report.rsExperimentPhases = report.rsExperimentPhases || {};
    report.rsExperimentPhases['pre-auto-init'] = executeRsExperiment('pre-auto-init');
    report.rsExperiment = report.rsExperimentPhases['pre-auto-init'];
  }
  if (!options.skipAutoInit && window.initAliyunCaptcha && typeof window.initAliyunCaptcha === 'function') {
    const autoInitEvents = [];
    try {
      if (window.AliyunCaptcha?.prototype) {
        const proto = window.AliyunCaptcha.prototype;
        if (typeof proto.onBizSuccess === 'function') {
          const raw = proto.onBizSuccess;
          proto.onBizSuccess = function (...args) {
            autoInitEvents.push(buildAutoInitRuntimeEvent('proto.onBizSuccess', args, this));
            return raw.apply(this, args);
          };
        }
        if (typeof proto.onBizFail === 'function') {
          const raw = proto.onBizFail;
          proto.onBizFail = function (...args) {
            autoInitEvents.push(buildAutoInitRuntimeEvent('proto.onBizFail', args, this));
            return raw.apply(this, args);
          };
        }
        if (typeof proto.startTracelessVerification === 'function') {
          const raw = proto.startTracelessVerification;
          proto.startTracelessVerification = function (...args) {
            autoInitEvents.push(buildAutoInitRuntimeEvent('proto.startTracelessVerification.before', args, this));
            const result = raw.apply(this, args);
            autoInitEvents.push(buildAutoInitRuntimeEvent('proto.startTracelessVerification.after', [], this));
            return result;
          };
        }
        if (typeof proto.refresh === 'function') {
          const raw = proto.refresh;
          proto.refresh = function (...args) {
            autoInitEvents.push(buildAutoInitRuntimeEvent('proto.refresh.before', args, this));
            const result = raw.apply(this, args);
            autoInitEvents.push(buildAutoInitRuntimeEvent('proto.refresh.after', [], this));
            return result;
          };
        }
      }
      const scaffoldNodes = ensureAliyunCaptchaScaffold(window.document);
      if (scaffoldNodes.length) {
        autoInitEvents.push({ type: 'scaffoldNodes', created: scaffoldNodes });
      }
      const holder = window.document.createElement('div');
      holder.id = 'chat-captcha-element';
      window.document.body.appendChild(holder);
      const button = window.document.createElement('button');
      button.id = 'chat-captcha-trigger';
      window.document.body.appendChild(button);
      await Promise.race([
        new Promise((resolve) => {
          let instanceRef = null;
          let triggered = false;
          const initConfig = {
            SceneId: 'didk33e0',
            mode: 'popup',
            element: '#chat-captcha-element',
            button: '#chat-captcha-trigger',
            captchaLogoImg: 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg',
            language: options.autoInitLanguage || 'en',
            timeout: 1000,
            delayBeforeSuccess: false,
            success: (e) => {
              autoInitEvents.push({
                type: 'success',
                payload: e,
                decoded: tryDecodeBase64Json(e),
              });
              resolve(null);
            },
            fail: (e) => { autoInitEvents.push({ type: 'fail', payload: e }); resolve(null); },
            onError: (e) => { autoInitEvents.push({ type: 'error', payload: String(e) }); resolve(null); },
            onClose: () => { autoInitEvents.push({ type: 'close' }); resolve(null); },
            getInstance: (e) => {
              instanceRef = e;
              window.__ALIYUN_LAST_INSTANCE__ = e || null;
              window.__ALIYUN_LAST_CAPTCHA_INSTANCE__ =
                e?.captcha?.AliyunCaptcha || e?.captcha || null;
              autoInitEvents.push({
                type: 'instance',
                keys: e ? Object.keys(e).slice(0, 20) : [],
                protoKeys: e ? Object.getOwnPropertyNames(Object.getPrototypeOf(e)).slice(0, 40) : [],
              });
              autoInitEvents.push({
                type: 'captcha-instance',
                captchaKeys: e?.captcha ? Object.keys(e.captcha).slice(0, 30) : [],
                captchaProtoKeys: e?.captcha ? Object.getOwnPropertyNames(Object.getPrototypeOf(e.captcha)).slice(0, 40) : [],
              });
              normalizeAliyunRuntimeState(
                e || null,
                e?.captcha?.AliyunCaptcha || e?.captcha || null,
                window.__ALIYUN_INIT_STATE__ || null,
              );
              autoInitEvents.push({
                type: 'instance.runtime',
                runtime: extractAliyunRuntimeState(
                  e || null,
                  e?.captcha?.AliyunCaptcha || e?.captcha || null,
                  window.__ALIYUN_INIT_STATE__ || null,
                ),
              });
              if (triggered) return;
              triggered = true;
              setTimeout(() => {
                try {
                  if (Array.isArray(options.syntheticEventsBeforeTrigger) && options.syntheticEventsBeforeTrigger.length > 0) {
                    dispatchSyntheticEvents(window, options.syntheticEventsBeforeTrigger);
                    autoInitEvents.push({
                      type: 'syntheticEventsBeforeTrigger',
                      count: options.syntheticEventsBeforeTrigger.length,
                    });
                  }
                  if (typeof instanceRef?.startTracelessVerification === 'function') {
                    autoInitEvents.push({ type: 'trigger', via: 'instance.startTracelessVerification' });
                    instanceRef.startTracelessVerification();
                    return;
                  }
                  if (typeof instanceRef?.captcha?.startTracelessVerification === 'function') {
                    autoInitEvents.push({ type: 'trigger', via: 'captcha.startTracelessVerification' });
                    instanceRef.captcha.startTracelessVerification();
                    return;
                  }
                  if (typeof e?.$button?.click === 'function') {
                    autoInitEvents.push({ type: 'trigger', via: '$button.click' });
                    e.$button.click();
                    return;
                  }
                  if (typeof e?.$button?.[0]?.click === 'function') {
                    autoInitEvents.push({ type: 'trigger', via: '$button[0].click' });
                    e.$button[0].click();
                  }
                } catch (err) {
                  autoInitEvents.push({ type: 'triggerError', error: String(err && err.stack || err) });
                }
              }, 10);
            },
          };
          if (options.autoInitConfig && typeof options.autoInitConfig === 'object') {
            Object.assign(initConfig, options.autoInitConfig);
          }
          if (options.initialAliyunCaptchaConfig && typeof options.initialAliyunCaptchaConfig === 'object') {
            Object.assign(initConfig, options.initialAliyunCaptchaConfig);
          }
          applyAliyunSgRuntimeOverrides(initConfig);
          autoInitEvents.push({
            type: 'initConfig.beforeInit',
            upLangType: initConfig?.upLang == null ? null : typeof initConfig.upLang,
            upLangValue: previewValue(initConfig?.upLang, 800),
            windowUpLangType: window.UP_LANG == null ? null : typeof window.UP_LANG,
            windowUpLangValue: previewValue(window.UP_LANG, 800),
            payload: snapshotObjectShape(initConfig, 40),
          });
          if (injectCaptchaVerifyCallback) {
            initConfig.captchaVerifyCallback = async (payload, done) => {
              let parsedPayload = payload;
              if (typeof payload === 'string') {
                try {
                  parsedPayload = JSON.parse(payload);
                } catch {
                  parsedPayload = payload;
                }
              }
              autoInitEvents.push({
                type: 'captchaVerifyCallback',
                payloadKeys: parsedPayload && typeof parsedPayload === 'object' ? Object.keys(parsedPayload).slice(0, 30) : [],
                payload: previewValue(parsedPayload, 4000),
                doneType: typeof done,
                instanceConfig: snapshotObjectShape(instanceRef?.config),
                captchaConfig: snapshotObjectShape(
                  instanceRef?.captcha?.AliyunCaptcha?.config || instanceRef?.captcha?.config,
                ),
              });
              return parsedPayload?.certifyId ?? null;
            };
          }
          window.initAliyunCaptcha(initConfig);
        }),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      report.autoInit = autoInitEvents;
      await capturePostAutoInitTokenProbes();
      if (options.executeLive) {
        await waitForLiveXhrSettle({
          timeoutMs: Number.isFinite(options.liveXhrWaitTimeoutMs)
            ? Math.max(500, Number(options.liveXhrWaitTimeoutMs))
            : 4000,
        });
      }
    } catch (err) {
      report.autoInit = [{ type: 'throw', error: String(err && err.stack || err) }];
    }
  }
  if (shouldRunRsExperimentAt('after-auto-init')) {
    report.rsExperimentPhases = report.rsExperimentPhases || {};
    report.rsExperimentPhases['after-auto-init'] = executeRsExperiment('after-auto-init');
    report.rsExperiment = report.rsExperimentPhases['after-auto-init'];
  }

  report.xhrLog = xhrLog.slice(0, 20);
  report.consoleLogs = consoleLogBuffer.slice(0, 200);
  report.asyncErrors = asyncErrors.slice(0, 20);
  report.recorderSample = recorder.all().slice(0, 200);
  report.windowTraceCalls = Array.isArray(window.__trace_calls) ? window.__trace_calls.slice(0, 200) : [];
  report.scriptLoadLogs = Array.isArray(window.__SCRIPT_LOAD_LOGS__) ? window.__SCRIPT_LOAD_LOGS__.slice(0, 200) : [];
  report.selectorLogs = Array.isArray(window.__SELECTOR_LOGS__) ? window.__SELECTOR_LOGS__.slice(0, 500) : [];
  report.nodeAccessLogs = Array.isArray(window.__NODE_ACCESS_LOGS__) ? window.__NODE_ACCESS_LOGS__.slice(0, 500) : [];
  report.documentAccessLogs = Array.isArray(window.__DOCUMENT_ACCESS_LOGS__) ? window.__DOCUMENT_ACCESS_LOGS__.slice(0, 300) : [];
  report.umObjectSnapshot = umTrace?.snapshot?.() || snapshotObjectShape(window.um);
  report.zUmObjectSnapshot = zUmTrace?.snapshot?.() || snapshotObjectShape(window.z_um);
  report.aliyunInitStateSnapshot = snapshotObjectShape(window.__ALIYUN_INIT_STATE__);
  report.aliyunInitPreCollectDataSnapshot = snapshotObjectShape(window.__ALIYUN_INIT_STATE__?.preCollectData);
  report.aliyunPrecollectSnapshot = snapshotObjectShape(window.__ALIYUN_PRECOLLECT_SNAPSHOT__);
  report.liveCheckChainState = buildLiveCheckChainState(window, xhrLog, {
    autoInitEvents: report.autoInit,
  });
  const feilinReState = window.__FEILIN_RE__ || window.__FEILIN_EXPORT_RE__ || null;
  report.feilinDeviceDataEntries = snapshotOrderedEntries(feilinReState?.deviceData, 260);
  report.aliyunVerifyHelpersSnapshot = snapshotObjectShape(window.__ALIYUN_VERIFY_HELPERS__);
  report.aliyunVerifyHelpersSource = window.__ALIYUN_VERIFY_HELPERS__ ? {
    K: previewFunctionSource(window.__ALIYUN_VERIFY_HELPERS__.K, 1600),
    tC: previewFunctionSource(window.__ALIYUN_VERIFY_HELPERS__.tC, 1600),
    DDeflate: previewFunctionSource(window.__ALIYUN_VERIFY_HELPERS__.D?.deflate, 2400),
  } : null;
  if (Array.isArray(options.verifyHelperExperimentInputs) && window.__ALIYUN_VERIFY_HELPERS__) {
    try {
      const { K, tC } = window.__ALIYUN_VERIFY_HELPERS__;
      report.verifyHelperExperiment = options.verifyHelperExperimentInputs.map((input) => {
        const text = String(input ?? '');
        let transformed = null;
        let encoded = null;
        let error = null;
        try {
          transformed = typeof tC === 'function' ? tC(text) : null;
          encoded = typeof K === 'function' ? K(text) : null;
        } catch (err) {
          error = String(err && err.stack || err);
        }
        return {
          input: text,
          transformedType: typeof transformed,
          transformedTag: transformed ? Object.prototype.toString.call(transformed) : null,
          transformedLen: transformed && typeof transformed.length === 'number' ? transformed.length : null,
          transformedHexPreview: byteLikeHexPreview(transformed, 128),
          transformedByteSample: transformed && typeof transformed.length === 'number'
            ? Array.prototype.slice.call(transformed, 0, 48)
            : null,
          encodedPreview: typeof encoded === 'string' ? encoded.slice(0, 400) : previewValue(encoded, 200),
          encodedLength: typeof encoded === 'string' ? encoded.length : null,
          error,
        };
      });
    } catch (err) {
      report.verifyHelperExperiment = { error: String(err && err.stack || err) };
    }
  }
  report.peKLogs = Array.isArray(window.__PE_K_LOGS__) ? window.__PE_K_LOGS__.slice(0, 40) : [];
  report.peKOutputLogs = Array.isArray(window.__PE_K_OUTPUT_LOGS__) ? window.__PE_K_OUTPUT_LOGS__.slice(0, 40) : [];
  report.peDeflateLogs = Array.isArray(window.__PE_DEFLATE_LOGS__) ? window.__PE_DEFLATE_LOGS__.slice(0, 40) : [];
  report.verifyDataCallsiteLogs = Array.isArray(window.__VERIFY_DATA_CALLSITE_LOGS__)
    ? window.__VERIFY_DATA_CALLSITE_LOGS__.slice(0, 40)
    : [];
  report.verifyGCallsiteLogs = Array.isArray(window.__VERIFY_G_CALLSITE_LOGS__)
    ? window.__VERIFY_G_CALLSITE_LOGS__.slice(0, 80)
    : [];
  report.verifyVmContext = window.__VERIFY_VM_CONTEXT__ || null;
  report.tVmCalls = Array.isArray(window.__T_VM_CALLS__) ? window.__T_VM_CALLS__.slice(0, 40) : [];
  report.tVmLast = window.__T_VM_LAST__ || null;
  report.tVmInitSnapshot = window.__T_VM_INIT_SNAPSHOT__ || null;
  report.tVm1020Snapshots = Array.isArray(window.__T_VM_1020_SNAPSHOTS__)
    ? window.__T_VM_1020_SNAPSHOTS__.slice(0, 400)
    : [];
  report.tVm74EntryLogs = Array.isArray(window.__T_VM_74_ENTRY_LOGS__) ? window.__T_VM_74_ENTRY_LOGS__.slice(0, 40) : [];
  report.tVmApplyLogs = Array.isArray(window.__T_VM_APPLY_LOGS__) ? window.__T_VM_APPLY_LOGS__.slice(0, 80) : [];
  report.tVmAssignLogs = Array.isArray(window.__T_VM_ASSIGN_LOGS__) ? window.__T_VM_ASSIGN_LOGS__.slice(0, 8000) : [];
  report.tVmTrace = Array.isArray(window.__T_VM_TRACE__) ? window.__T_VM_TRACE__.slice(0, 4000) : [];
  report.tVmGetLogs = Array.isArray(window.__T_VM_GET_LOGS__) ? window.__T_VM_GET_LOGS__.slice(0, 80) : [];
  report.btoaLogs = Array.isArray(window.__BTOA_LOGS__) ? window.__BTOA_LOGS__.slice(0, 80) : [];
  report.jsonStringifyLogs = Array.isArray(window.__JSON_STRINGIFY_LOGS__)
    ? window.__JSON_STRINGIFY_LOGS__.slice(0, 120)
    : [];
  report.aliyunRuntimeCredentialLogs = Array.isArray(window.__ALIYUN_RUNTIME_CREDENTIAL_LOGS__)
    ? window.__ALIYUN_RUNTIME_CREDENTIAL_LOGS__.slice(0, 160)
    : [];
  report.aliyunExtendAssignLogs = Array.isArray(window.__ALIYUN_EXTEND_ASSIGN_LOGS__)
    ? window.__ALIYUN_EXTEND_ASSIGN_LOGS__.slice(0, 160)
    : [];
  report.peTyLogs = Array.isArray(window.__PE_TY_LOGS__) ? window.__PE_TY_LOGS__.slice(0, 120) : [];
  report.peTyReturns = Array.isArray(window.__PE_TY_RETURNS__) ? window.__PE_TY_RETURNS__.slice(0, 120) : [];
  report.peTs74Logs = Array.isArray(window.__PE_TS74_LOGS__) ? window.__PE_TS74_LOGS__.slice(0, 80) : [];
  report.peTs75Logs = Array.isArray(window.__PE_TS75_LOGS__) ? window.__PE_TS75_LOGS__.slice(0, 80) : [];
  report.wordArrayToStringLogs = Array.isArray(window.__WORD_ARRAY_TOSTRING_LOGS__)
    ? window.__WORD_ARRAY_TOSTRING_LOGS__.slice(0, 120)
    : [];
  report.wordArrayConcatLogs = Array.isArray(window.__WORD_ARRAY_CONCAT_LOGS__)
    ? window.__WORD_ARRAY_CONCAT_LOGS__.slice(0, 120)
    : [];
  report.base64StringifyLogs = Array.isArray(window.__BASE64_STRINGIFY_LOGS__)
    ? window.__BASE64_STRINGIFY_LOGS__.slice(0, 120)
    : [];
  report.base64ParseLogs = Array.isArray(window.__BASE64_PARSE_LOGS__)
    ? window.__BASE64_PARSE_LOGS__.slice(0, 120)
    : [];
  report.hexParseLogs = Array.isArray(window.__HEX_PARSE_LOGS__)
    ? window.__HEX_PARSE_LOGS__.slice(0, 120)
    : [];
  report.aesEncryptToStringLogs = Array.isArray(window.__AES_ENCRYPT_TOSTRING_LOGS__)
    ? window.__AES_ENCRYPT_TOSTRING_LOGS__.slice(0, 120)
    : [];
  report.stringCharCodeLogs = Array.isArray(window.__STRING_CHARCODE_LOGS__)
    ? window.__STRING_CHARCODE_LOGS__.slice(0, 5000)
    : [];
  report.stringFromCharCodeLogs = Array.isArray(window.__STRING_FROMCHARCODE_LOGS__)
    ? window.__STRING_FROMCHARCODE_LOGS__.slice(0, 5000)
    : [];
  report.stringSliceLogs = Array.isArray(window.__STRING_SLICE_LOGS__)
    ? window.__STRING_SLICE_LOGS__.slice(0, 200)
    : [];
  report.initAliyunCaptchaCalls = Array.isArray(window.__INIT_ALIYUN_CAPTCHA_CALLS__)
    ? window.__INIT_ALIYUN_CAPTCHA_CALLS__.slice(0, 60)
    : [];
  report.stringOpLogs = Array.isArray(window.__STRING_OP_LOGS__)
    ? window.__STRING_OP_LOGS__.slice(0, 1200)
    : [];
  report.stringCharOpLogs = Array.isArray(window.__STRING_CHAR_OP_LOGS__)
    ? window.__STRING_CHAR_OP_LOGS__.slice(0, 4000)
    : [];
  report.joinLogs = Array.isArray(window.__JOIN_LOGS__) ? window.__JOIN_LOGS__.slice(0, 80) : [];
  report.rlLogs = Array.isArray(window.__RL_LOGS__) ? window.__RL_LOGS__.slice(0, 80) : [];
  report.feilinIoLogs = Array.isArray(window.__FEILIN_IO_LOGS__) ? window.__FEILIN_IO_LOGS__.slice(0, 80) : [];
  report.feilinIuLogs = Array.isArray(window.__FEILIN_IU_LOGS__) ? window.__FEILIN_IU_LOGS__.slice(0, 80) : [];
  report.tokenPathLogs = Array.isArray(window.__TOKEN_PATH_LOGS__) ? window.__TOKEN_PATH_LOGS__.slice(0, 80) : [];
  report.feilinIoExposed = typeof window.__FEILIN_IO__ === 'function';
  report.feilinIuExposed = typeof window.__FEILIN_IU__ === 'function';
  if (options.ioMutationExperiment && typeof window.__FEILIN_IO__ === 'function') {
    try {
      const firstIoLog = Array.isArray(window.__FEILIN_IO_LOGS__) ? window.__FEILIN_IO_LOGS__[0] : null;
      const baseObject = firstIoLog?.args?.[0];
      const baseFlag = firstIoLog?.args?.[1];
      if (baseObject && typeof baseObject === 'object') {
        const baseEncoded = window.__FEILIN_IO__(baseObject, baseFlag);
        const baseSeed = decodeBase64Utf8(baseEncoded, 1200);
        const changes = [];
        for (const key of Object.keys(baseObject)) {
          const original = baseObject[key];
          let mutatedValue = original;
          if (typeof original === 'string') {
            mutatedValue = original ? `${original}__io_probe__` : `__io_probe_${key}__`;
          } else if (typeof original === 'number') {
            mutatedValue = original + 1;
          } else if (typeof original === 'boolean') {
            mutatedValue = !original;
          } else if (original == null) {
            mutatedValue = `__io_probe_${key}__`;
          } else {
            continue;
          }
          const mutatedObject = { ...baseObject, [key]: mutatedValue };
          const encoded = window.__FEILIN_IO__(mutatedObject, baseFlag);
          const decoded = decodeBase64Utf8(encoded, 1200);
          if (decoded !== baseSeed) {
            changes.push({
              key,
              originalType: typeof original,
              originalPreview: previewValue(original, 200),
              mutatedPreview: previewValue(mutatedValue, 200),
              decoded,
            });
          }
        }
        report.ioMutationExperiment = {
          baseFlag: previewValue(baseFlag, 100),
          baseSeed,
          changedCount: changes.length,
          changedKeys: changes.slice(0, 120),
        };
      }
    } catch (err) {
      report.ioMutationExperiment = { error: String(err && err.stack || err) };
    }
  }
  if (options.iuMutationExperiment && typeof window.__FEILIN_IU__ === 'function') {
    try {
      const firstIuLog = Array.isArray(window.__FEILIN_IU_LOGS__) ? window.__FEILIN_IU_LOGS__[0] : null;
      const baseObject = firstIuLog?.args?.[0];
      if (baseObject && typeof baseObject === 'object') {
        const baseEncoded = window.__FEILIN_IU__(baseObject, null, null, true);
        const baseToken = decodeBase64Utf8(baseEncoded, 1200);
        const changes = [];
        for (const key of Object.keys(baseObject)) {
          const original = baseObject[key];
          let mutatedValue = original;
          if (typeof original === 'string') {
            mutatedValue = original ? `${original}__iu_probe__` : `__iu_probe_${key}__`;
          } else if (typeof original === 'number') {
            mutatedValue = original + 1;
          } else if (typeof original === 'boolean') {
            mutatedValue = !original;
          } else if (original == null) {
            mutatedValue = `__iu_probe_${key}__`;
          } else {
            continue;
          }
          const mutatedObject = { ...baseObject, [key]: mutatedValue };
          const encoded = window.__FEILIN_IU__(mutatedObject, null, null, true);
          const decoded = decodeBase64Utf8(encoded, 1200);
          if (decoded !== baseToken) {
            changes.push({
              key,
              originalType: typeof original,
              originalPreview: previewValue(original, 200),
              mutatedPreview: previewValue(mutatedValue, 200),
              decoded,
            });
          }
        }
        report.iuMutationExperiment = {
          baseToken,
          changedCount: changes.length,
          changedKeys: changes.slice(0, 120),
        };
      }
    } catch (err) {
      report.iuMutationExperiment = { error: String(err && err.stack || err) };
    }
  }
  if (options.manualTokenExperiment) {
    try {
      const firstIoLog = Array.isArray(window.__FEILIN_IO_LOGS__) ? window.__FEILIN_IO_LOGS__[0] : null;
      const firstIuLog = Array.isArray(window.__FEILIN_IU_LOGS__) ? window.__FEILIN_IU_LOGS__[0] : null;
      const ioObject = firstIoLog?.args?.[0];
      const ioFlag = firstIoLog?.args?.[1];
      const iuObject = firstIuLog?.args?.[0];
      const variants = [
        { label: 'undefined', value: undefined },
        { label: 'null', value: null },
        { label: 'false', value: false },
        { label: 'true', value: true },
        { label: '0', value: 0 },
        { label: '1', value: 1 },
        { label: '501', value: 501 },
        { label: '513', value: 513 },
        { label: '"501"', value: '501' },
        { label: '"513"', value: '513' },
      ];
      const ioVariants = [];
      const iuVariants = [];
      if (typeof window.__FEILIN_IO__ === 'function' && ioObject && typeof ioObject === 'object') {
        for (const variant of variants) {
          let encoded;
          try {
            encoded = window.__FEILIN_IO__(ioObject, variant.value);
            ioVariants.push({
              label: variant.label,
              argType: typeof variant.value,
              encodedPreview: typeof encoded === 'string' ? encoded.slice(0, 400) : previewValue(encoded, 200),
              decodedPreview: decodeBase64Utf8(encoded, 1200),
            });
          } catch (err) {
            ioVariants.push({
              label: variant.label,
              argType: typeof variant.value,
              error: String(err && err.stack || err),
            });
          }
        }
      }
      if (typeof window.__FEILIN_IU__ === 'function' && iuObject && typeof iuObject === 'object') {
        for (const variant of variants) {
          let encoded;
          try {
            encoded = window.__FEILIN_IU__(iuObject, null, null, variant.value);
            iuVariants.push({
              label: variant.label,
              argType: typeof variant.value,
              encodedPreview: typeof encoded === 'string' ? encoded.slice(0, 400) : previewValue(encoded, 200),
              decodedPreview: decodeBase64Utf8(encoded, 1200),
            });
          } catch (err) {
            iuVariants.push({
              label: variant.label,
              argType: typeof variant.value,
              error: String(err && err.stack || err),
            });
          }
        }
      }
  report.manualTokenExperiment = {
        baseIoFlag: previewValue(ioFlag, 100),
        ioVariants,
        iuVariants,
      };
    } catch (err) {
      report.manualTokenExperiment = { error: String(err && err.stack || err) };
    }
  }
  if (options.extendTableExperiment) {
    try {
      const baseLog = (window.__EXTEND_CONSUME_LOGS__ || []).find((x) => x && x.stage === 'base' && x.arg === 71);
      const reTable = window.__FEILIN_RE__;
      const siFn = window.__FEILIN_SI__;
      let activeTable = null;
      if (Array.isArray(reTable) && baseLog && typeof baseLog.arg === 'number') {
        const hit = reTable.find((entry) => Array.isArray(entry) && entry.length > 50 && entry[baseLog.arg] != null);
        if (hit) activeTable = hit;
      }
      if (!activeTable && Array.isArray(reTable)) {
        activeTable = reTable.find((entry) => Array.isArray(entry) && entry.some((value) => value != null)) || null;
      }
      if (activeTable && typeof siFn === 'function') {
        const rows = [];
        for (let idx = 0; idx < activeTable.length; idx += 1) {
          const raw = activeTable[idx];
          if (raw == null) continue;
          let decoded = null;
          let error = null;
          try {
            const maybe = siFn(raw);
            if (maybe && typeof maybe === 'object' && typeof maybe.toString === 'function') {
              decoded = maybe.toString();
            } else {
              decoded = String(maybe);
            }
          } catch (err) {
            error = String(err && err.stack || err);
          }
          rows.push({
            idx,
            rawType: typeof raw,
            rawPreview: typeof raw === 'string' ? raw.slice(0, 160) : previewValue(raw, 120),
            decoded: typeof decoded === 'string' ? decoded.slice(0, 240) : decoded,
            error,
          });
        }
        report.extendTableExperiment = {
          tableLength: activeTable.length,
          populatedCount: rows.length,
          rows: rows.slice(0, 200),
        };
      } else {
        report.extendTableExperiment = {
          missingTable: !activeTable,
          reType: typeof reTable,
          siType: typeof siFn,
        };
      }
    } catch (err) {
      report.extendTableExperiment = { error: String(err && err.stack || err) };
    }
  }
  if (options.reMutationExperiment) {
    try {
      const cfg = window.__FEILIN_RE__;
      const tokenFn = window.um?.getToken;
      if (cfg && typeof cfg === 'object' && typeof tokenFn === 'function') {
        const original = {
          secretKey: cfg.secretKey,
          sessionId: cfg.sessionId,
          deviceData: cfg.deviceData,
          DeviceToken: cfg.DeviceToken,
          DeviceConfig: cfg.DeviceConfig,
        };
        const decodedDeviceToken = decodeBase64Utf8(cfg.DeviceToken, 1200);
        const plainDeviceSessionId = cfg.deviceConfig?.sessionId ?? cfg.deviceData?.deviceConfig?.sessionId ?? null;
        const variants = [
          ['secretKey', null],
          ['secretKey', 'RE_PROBE_SECRET'],
          ['sessionId', null],
          ['sessionId', 'RE_PROBE_SESSION'],
          ['sessionId', original.secretKey],
          ['sessionId', decodedDeviceToken],
          ['sessionId', plainDeviceSessionId],
          ['DeviceToken', null],
          ['DeviceToken', 'RE_PROBE_DEVICE_TOKEN'],
          ['DeviceConfig', null],
          ['DeviceConfig', 'RE_PROBE_DEVICE_CONFIG'],
          ['deviceData', null],
          ['deviceData', {}],
        ];
        const rows = [];
        for (const [field, nextValue] of variants) {
          cfg.secretKey = original.secretKey;
          cfg.sessionId = original.sessionId;
          cfg.deviceData = original.deviceData;
          cfg.DeviceToken = original.DeviceToken;
          cfg.DeviceConfig = original.DeviceConfig;
          cfg[field] = nextValue;
          let token = null;
          let decoded = null;
          let error = null;
          try {
            token = await Promise.resolve(tokenFn.call(window.um));
            decoded = decodeBase64Utf8(token, 1200);
          } catch (err) {
            error = String(err && err.stack || err);
          }
          rows.push({
            field,
            assignedType: typeof nextValue,
            assignedPreview: previewValue(nextValue, 200),
            tokenPreview: typeof token === 'string' ? token.slice(0, 240) : previewValue(token, 200),
            decoded,
            error,
          });
        }
        cfg.secretKey = original.secretKey;
        cfg.sessionId = original.sessionId;
        cfg.deviceData = original.deviceData;
        cfg.DeviceToken = original.DeviceToken;
        cfg.DeviceConfig = original.DeviceConfig;
        report.reMutationExperiment = {
          original: {
            secretKey: previewValue(original.secretKey, 200),
            sessionId: previewValue(original.sessionId, 200),
            deviceDataShape: snapshotObjectShape(original.deviceData),
            DeviceToken: previewValue(original.DeviceToken, 200),
            DeviceConfig: previewValue(original.DeviceConfig, 200),
          },
          rows,
        };
      } else {
        report.reMutationExperiment = {
          cfgType: typeof cfg,
          tokenFnType: typeof tokenFn,
        };
      }
    } catch (err) {
      report.reMutationExperiment = { error: String(err && err.stack || err) };
    }
  }
  if (Array.isArray(options.deviceDataOverrideExperimentInputs)) {
    try {
      const cfg = window.__FEILIN_RE__;
      const tokenFn = window.um?.getToken;
      if (cfg && typeof cfg === 'object' && cfg.deviceData && typeof cfg.deviceData === 'object' && typeof tokenFn === 'function') {
        const originalDeviceData = cfg.deviceData;
        const originalShallow = { ...originalDeviceData };
        const rows = [];
        for (const input of options.deviceDataOverrideExperimentInputs) {
          const label = input && Object.prototype.hasOwnProperty.call(input, 'label') ? input.label : null;
          const overrides = input && typeof input.overrides === 'object' && !Array.isArray(input.overrides)
            ? input.overrides
            : {};
          cfg.deviceData = { ...originalShallow, ...overrides };
          const result = await captureTokenExecution(() => tokenFn.call(window.um));
          rows.push({
            label,
            overrideKeys: Object.keys(overrides),
            overridePreview: Object.fromEntries(
              Object.entries(overrides).slice(0, 20).map(([key, value]) => [key, previewValue(value, 220)]),
            ),
            deviceDataEntries: snapshotOrderedEntries(cfg.deviceData, 260),
            ...result,
          });
        }
        cfg.deviceData = originalDeviceData;
        report.deviceDataOverrideExperiment = {
          originalEntries: snapshotOrderedEntries(originalShallow, 260),
          rows,
        };
      } else {
        report.deviceDataOverrideExperiment = {
          cfgType: typeof cfg,
          tokenFnType: typeof tokenFn,
          hasDeviceData: !!cfg?.deviceData,
        };
      }
    } catch (err) {
      report.deviceDataOverrideExperiment = { error: String(err && err.stack || err) };
    }
  }
  if (Array.isArray(options.deviceObjectOverrideExperimentInputs)) {
    try {
      const rows = [];
      const originalCvs = window._aliyun_device_cvs;
      const originalIfr = window._aliyun_device_ifr;
      const tokenFn = window.um?.getToken;
      if (typeof tokenFn === 'function') {
        for (const input of options.deviceObjectOverrideExperimentInputs) {
          const label = input && Object.prototype.hasOwnProperty.call(input, 'label') ? input.label : null;
          const mode = input && Object.prototype.hasOwnProperty.call(input, 'mode') ? input.mode : 'replace';
          const nextCvs = input && Object.prototype.hasOwnProperty.call(input, 'cvs') ? input.cvs : originalCvs;
          const nextIfr = input && Object.prototype.hasOwnProperty.call(input, 'ifr') ? input.ifr : originalIfr;
          if (mode === 'assign') {
            if (originalCvs && typeof originalCvs === 'object' && nextCvs && typeof nextCvs === 'object') {
              Object.assign(originalCvs, nextCvs);
              window._aliyun_device_cvs = originalCvs;
            } else {
              window._aliyun_device_cvs = nextCvs;
            }
            if (originalIfr && typeof originalIfr === 'object' && nextIfr && typeof nextIfr === 'object') {
              Object.assign(originalIfr, nextIfr);
              window._aliyun_device_ifr = originalIfr;
            } else {
              window._aliyun_device_ifr = nextIfr;
            }
          } else {
            window._aliyun_device_cvs = nextCvs;
            window._aliyun_device_ifr = nextIfr;
          }
          const result = await captureTokenExecution(() => tokenFn.call(window.um));
          rows.push({
            label,
            mode,
            cvsShape: snapshotObjectShape(window._aliyun_device_cvs, 30),
            ifrShape: snapshotObjectShape(window._aliyun_device_ifr, 30),
            ...result,
          });
          window._aliyun_device_cvs = originalCvs;
          window._aliyun_device_ifr = originalIfr;
        }
        report.deviceObjectOverrideExperiment = {
          baseline: {
            cvsShape: snapshotObjectShape(originalCvs, 30),
            ifrShape: snapshotObjectShape(originalIfr, 30),
          },
          rows,
        };
      } else {
        report.deviceObjectOverrideExperiment = { tokenFnType: typeof tokenFn };
      }
    } catch (err) {
      report.deviceObjectOverrideExperiment = { error: String(err && err.stack || err) };
    }
  }
  if (options.sessionIdBlobExperiment || options.customSessionIdBlobBase64) {
    try {
      const cfg = window.__FEILIN_RE__;
      const tokenFn = window.um?.getToken;
      const secretBuf = decodeBase64Buffer(cfg?.secretKey);
      const sessionBuf = decodeBase64Buffer(cfg?.sessionId);
      if (cfg && typeof cfg === 'object' && typeof tokenFn === 'function' && secretBuf && sessionBuf) {
        const originalSessionId = cfg.sessionId;
        const sessionLen = sessionBuf.length;
        const zeroTailFrom = (offset) => {
          const next = Buffer.from(sessionBuf);
          if (offset < next.length) next.fill(0, offset);
          return next;
        };
        const randomTailFrom = (offset) => {
          const next = Buffer.from(sessionBuf);
          if (offset < next.length) crypto.randomBytes(next.length - offset).copy(next, offset);
          return next;
        };
        const replaceByte = (offset, value) => {
          const next = Buffer.from(sessionBuf);
          if (offset >= 0 && offset < next.length) next[offset] = value;
          return next;
        };
        const secretPlusZeroTail = () => {
          const next = Buffer.alloc(sessionLen);
          secretBuf.copy(next, 0, 0, Math.min(secretBuf.length, next.length));
          return next;
        };
        const callToken = async () => {
          let token = null;
          let decoded = null;
          let parsed = null;
          let error = null;
          const beStart = Array.isArray(window.__FEILIN_BE_LOGS__) ? window.__FEILIN_BE_LOGS__.length : 0;
          const uyStart = Array.isArray(window.__FEILIN_UY_LOGS__) ? window.__FEILIN_UY_LOGS__.length : 0;
          const joinStart = Array.isArray(window.__JOIN_LOGS__) ? window.__JOIN_LOGS__.length : 0;
          const rlStart = Array.isArray(window.__RL_LOGS__) ? window.__RL_LOGS__.length : 0;
          const n0Start = Array.isArray(window.__N0_G_LOGS__) ? window.__N0_G_LOGS__.length : 0;
          const n0PartStart = Array.isArray(window.__N0_PART_LOGS__) ? window.__N0_PART_LOGS__.length : 0;
          try {
            token = await Promise.resolve(tokenFn.call(window.um));
            decoded = decodeBase64Utf8(token, 1200);
            parsed = analyzeTokenPlain(decoded);
          } catch (err) {
            error = String(err && err.stack || err);
          }
          const newBeLogs = (window.__FEILIN_BE_LOGS__ || []).slice(beStart);
          const newUyLogs = (window.__FEILIN_UY_LOGS__ || []).slice(uyStart);
          const newJoinLogs = (window.__JOIN_LOGS__ || []).slice(joinStart);
          const newRlLogs = (window.__RL_LOGS__ || []).slice(rlStart);
          const newN0Logs = (window.__N0_G_LOGS__ || []).slice(n0Start);
          const newN0PartLogs = (window.__N0_PART_LOGS__ || []).slice(n0PartStart);
          let directRxAfterToken = null;
          try {
            const lastTA = [...newN0PartLogs].reverse().find((entry) => entry?.name === 'tA');
            const rxFn = window.__FEILIN_RX__;
            const rxThis = window.__FEILIN_RX_LAST_THIS__ || window;
            if (lastTA && typeof rxFn === 'function' && typeof lastTA.trPreview === 'string' && typeof lastTA.CPreview === 'string') {
              const out = rxFn.call(rxThis, lastTA.trPreview, lastTA.CPreview);
              directRxAfterToken = {
                trPreview: lastTA.trPreview,
                cPreview: lastTA.CPreview,
                output: typeof out === 'string' ? out.slice(0, 300) : previewValue(out, 300),
                thisType: typeof rxThis,
                thisKeys: rxThis && typeof rxThis === 'object' ? Object.keys(rxThis).slice(0, 20) : null,
              };
            }
          } catch (err) {
            directRxAfterToken = { error: String(err && err.stack || err) };
          }
          const uyReturn = (() => {
            for (let idx = newUyLogs.length - 1; idx >= 0; idx -= 1) {
              const item = newUyLogs[idx];
              if (item?.stage === 'return') return previewValue(item.value, 400);
            }
            return null;
          })();
          return {
            tokenPreview: typeof token === 'string' ? token.slice(0, 240) : previewValue(token, 200),
            decoded,
            parsed,
            intermediates: {
              uyReturn,
              ce: pickRecentBeOutput(newBeLogs, 'function ce()'),
              ci: pickRecentBeOutput(newBeLogs, 'function ci()'),
              o6: pickRecentBeOutput(newBeLogs, 'function o6()'),
            },
            tokenJoinLogs: newJoinLogs
              .filter((entry) => typeof entry?.output === 'string' && entry.output.includes('SG_WEB'))
              .slice(-4),
            tokenRlLogs: newRlLogs
              .filter((entry) => typeof entry?.input === 'string' && entry.input.includes('SG_WEB'))
              .slice(-4),
            n0GLogs: newN0Logs
              .filter((entry) => typeof entry?.output === 'string' && entry.output.includes('SG_WEB'))
              .slice(-4),
            n0PartLogs: newN0PartLogs
              .filter((entry) => entry?.name === 'tA' || entry?.name === 'B' || entry?.name === 'm')
              .slice(-8),
            directRxAfterToken,
            error,
          };
        };
        const variants = [
          { label: 'flip-byte-0', build: () => replaceByte(0, sessionBuf[0] ^ 0xff) },
          { label: 'flip-byte-31', build: () => replaceByte(31, sessionBuf[Math.min(31, sessionLen - 1)] ^ 0xff) },
          { label: 'flip-byte-32', build: () => replaceByte(32, sessionBuf[Math.min(32, sessionLen - 1)] ^ 0xff) },
          { label: 'flip-last-byte', build: () => replaceByte(sessionLen - 1, sessionBuf[sessionLen - 1] ^ 0xff) },
          { label: 'zero-tail-32', build: () => zeroTailFrom(32) },
          { label: 'zero-tail-48', build: () => zeroTailFrom(48) },
          { label: 'random-tail-32', build: () => randomTailFrom(32) },
          { label: 'random-tail-48', build: () => randomTailFrom(48) },
          { label: 'secret-plus-zero-tail', build: () => secretPlusZeroTail() },
        ];
        if (options.customSessionIdBlobBase64) {
          const customBuf = decodeBase64Buffer(options.customSessionIdBlobBase64);
          if (customBuf) {
            variants.push({
              label: 'custom-sessionid',
              build: () => Buffer.from(customBuf),
            });
          }
        }
        const baseline = await callToken();
        const rows = [];
        const activeVariants = options.sessionIdBlobExperiment ? variants : variants.filter((v) => v.label === 'custom-sessionid');
        for (const variant of activeVariants) {
          const nextBuf = variant.build();
          cfg.sessionId = nextBuf.toString('base64');
          const result = await callToken();
          rows.push({
            label: variant.label,
            sessionIdBase64Preview: cfg.sessionId.slice(0, 200),
            sessionIdHexPreview: hexPreview(nextBuf, 48),
            sharedPrefixWithSecret: sharedPrefixLength(secretBuf, nextBuf),
            ...result,
          });
        }
        cfg.sessionId = originalSessionId;
        report.sessionIdBlobExperiment = {
          secretKeyBytes: secretBuf.length,
          sessionIdBytes: sessionBuf.length,
          sharedPrefixBytes: sharedPrefixLength(secretBuf, sessionBuf),
          secretKeyHexPreview: hexPreview(secretBuf, 48),
          sessionIdHexPreview: hexPreview(sessionBuf, 64),
          baseline,
          rows,
        };
        if (options.customSessionIdBlobBase64) {
          report.customSessionIdBlobResult = rows.find((row) => row.label === 'custom-sessionid') || null;
        }
      } else {
        report.sessionIdBlobExperiment = {
          cfgType: typeof cfg,
          tokenFnType: typeof tokenFn,
          hasSecretKey: Boolean(secretBuf),
          hasSessionId: Boolean(sessionBuf),
        };
      }
    } catch (err) {
      report.sessionIdBlobExperiment = { error: String(err && err.stack || err) };
    }
  }
  if (options.directRxSessionIdBase64) {
    try {
      const tokenFn = window.um?.getToken;
      if (typeof tokenFn === 'function') {
        try {
          await Promise.resolve(tokenFn.call(window.um));
        } catch {
          // warmup only
        }
      }
      const rxFn = window.__FEILIN_RX__;
      const rxThis = window.__FEILIN_RX_LAST_THIS__ || window;
      const tr = options.directRxTr || 'FqJB6iRNVYdEGpwb';
      if (typeof rxFn === 'function') {
        const cfg = window.__FEILIN_RE__;
        const originalSessionId = cfg && typeof cfg === 'object' ? cfg.sessionId : undefined;
        try {
          if (cfg && typeof cfg === 'object') {
            cfg.sessionId = options.directRxSessionIdBase64;
          }
          const second = rxFn.call(rxThis, tr, options.directRxSessionIdBase64);
          report.directRxSessionResult = {
            tr,
            second: typeof second === 'string' ? second : previewValue(second, 300),
            thisType: typeof rxThis,
            thisKeys: rxThis && typeof rxThis === 'object' ? Object.keys(rxThis).slice(0, 20) : null,
            hadCfg: !!cfg,
          };
        } finally {
          if (cfg && typeof cfg === 'object') {
            cfg.sessionId = originalSessionId;
          }
        }
      } else {
        report.directRxSessionResult = {
          rxType: typeof rxFn,
        };
      }
    } catch (err) {
      report.directRxSessionResult = { error: String(err && err.stack || err) };
    }
  }
  report.mediaDeviceLogs = Array.isArray(mediaDeviceLogs) ? mediaDeviceLogs.slice(0, 80) : [];
  report.cryptoTraceLogs = Array.isArray(window.__CRYPTO_TRACE_LOGS__) ? window.__CRYPTO_TRACE_LOGS__.slice(0, 1200) : [];
  report.raTraceLogs = Array.isArray(window.__FEILIN_RA20_LOGS__) ? window.__FEILIN_RA20_LOGS__.slice(0, 2400) : [];
  report.feilinSbTrace = Array.isArray(window.__FEILIN_SB_TRACE__) ? window.__FEILIN_SB_TRACE__.slice(0, 40) : [];
  report.feilinUbLogs = Array.isArray(window.__FEILIN_UB_LOGS__) ? window.__FEILIN_UB_LOGS__.slice(0, 40) : [];
  report.feilinUbArg100Logs = Array.isArray(window.__FEILIN_UB_ARG100_LOGS__)
    ? window.__FEILIN_UB_ARG100_LOGS__.slice(0, 80)
    : [];
  report.feilinUbErrorLogs = Array.isArray(window.__FEILIN_UB_ERROR_LOGS__)
    ? window.__FEILIN_UB_ERROR_LOGS__.slice(0, 80)
    : [];
  report.feilinUyLogs = Array.isArray(window.__FEILIN_UY_LOGS__) ? window.__FEILIN_UY_LOGS__.slice(0, 40) : [];
  report.feilinSessionHelperLogs = Array.isArray(window.__FEILIN_SESSION_HELPER_LOGS__)
    ? window.__FEILIN_SESSION_HELPER_LOGS__.slice(0, 80)
    : [];
  report.feilinUuLogs = Array.isArray(window.__FEILIN_UU_LOGS__) ? window.__FEILIN_UU_LOGS__.slice(0, 40) : [];
  report.feilinUDollarLogs = Array.isArray(window.__FEILIN_U_DOLLAR_LOGS__) ? window.__FEILIN_U_DOLLAR_LOGS__.slice(0, 40) : [];
  report.feilinBeLogs = Array.isArray(window.__FEILIN_BE_LOGS__) ? window.__FEILIN_BE_LOGS__.slice(0, 60) : [];
  report.peTdCalls = Array.isArray(window.__PE_TD_CALLS__) ? window.__PE_TD_CALLS__.slice(0, 120) : [];
  report.peTcCalls = Array.isArray(window.__PE_TC_CALLS__) ? window.__PE_TC_CALLS__.slice(0, 120) : [];
  report.peChainCalls = Array.isArray(window.__PE_CHAIN_CALLS__) ? window.__PE_CHAIN_CALLS__.slice(0, 240) : [];
  report.peDirectFnCalls = Array.isArray(window.__PE_DIRECT_FN_CALLS__) ? window.__PE_DIRECT_FN_CALLS__.slice(0, 240) : [];
  report.peTy2Calls = Array.isArray(window.__PE_TY2_CALLS__) ? window.__PE_TY2_CALLS__.slice(0, 120) : [];
  report.peNcCalls = Array.isArray(window.__PE_NC_CALLS__) ? window.__PE_NC_CALLS__.slice(0, 120) : [];
  report.peTs74Logs = Array.isArray(window.__PE_TS74_LOGS__) ? window.__PE_TS74_LOGS__.slice(0, 80) : [];
  report.peTs75Logs = Array.isArray(window.__PE_TS75_LOGS__) ? window.__PE_TS75_LOGS__.slice(0, 80) : [];
  report.peTsReturnLogs = Array.isArray(window.__PE_TS_RETURN_LOGS__) ? window.__PE_TS_RETURN_LOGS__.slice(0, 160) : [];
  report.peTs74ChainLogs = Array.isArray(window.__PE_TS74_CHAIN_LOGS__)
    ? window.__PE_TS74_CHAIN_LOGS__.slice(0, 160)
    : [];
  report.peTs74ReturnInlineLogs = Array.isArray(window.__PE_TS74_RETURN_INLINE_LOGS__)
    ? window.__PE_TS74_RETURN_INLINE_LOGS__.slice(0, 160)
    : [];
  report.dateNowLogs = Array.isArray(window.__DATE_NOW_LOGS__) ? window.__DATE_NOW_LOGS__.slice(-200) : [];
  report.preidVLogs = Array.isArray(window.__PREID_V_LOGS__) ? window.__PREID_V_LOGS__.slice(0, 120) : [];
  report.preidNgLogs = Array.isArray(window.__PREID_NG_LOGS__) ? window.__PREID_NG_LOGS__.slice(0, 120) : [];
  report.feilinRsLogs = Array.isArray(window.__FEILIN_RS_LOGS__) ? window.__FEILIN_RS_LOGS__.slice(0, 160) : [];
  report.feilinSvLogs = Array.isArray(window.__FEILIN_SV_LOGS__) ? window.__FEILIN_SV_LOGS__.slice(0, 80) : [];
  report.feilinPLogs = Array.isArray(window.__FEILIN_P_LOGS__) ? window.__FEILIN_P_LOGS__.slice(0, 160) : [];
  report.feilinUmRealSetLogs = Array.isArray(window.__FEILIN_UM_REAL_SET_LOGS__)
    ? window.__FEILIN_UM_REAL_SET_LOGS__.slice(0, 80)
    : [];
  report.feilinRsInnerLogs = Array.isArray(window.__FEILIN_RS_INNER_LOGS__) ? window.__FEILIN_RS_INNER_LOGS__.slice(0, 160) : [];
  report.feilinRsSelectorLogs = Array.isArray(window.__FEILIN_RS_SELECTOR_LOGS__)
    ? window.__FEILIN_RS_SELECTOR_LOGS__.slice(0, 200)
    : [];
  report.feilinRxLogs = Array.isArray(window.__FEILIN_RX_LOGS__) ? window.__FEILIN_RX_LOGS__.slice(0, 120) : [];
  report.stringDecoderLogs = Array.isArray(window.__STRING_DECODER_LOGS__) ? window.__STRING_DECODER_LOGS__.slice(0, 400) : [];
  report.feilinRkAccessLogs = Array.isArray(window.__FEILIN_RK_ACCESS_LOGS__)
    ? window.__FEILIN_RK_ACCESS_LOGS__.slice(0, 200)
    : [];
  report.preidExprLogs = Array.isArray(window.__PREID_EXPR_LOGS__) ? window.__PREID_EXPR_LOGS__.slice(0, 160) : [];
  report.preidHRealLogs = Array.isArray(window.__PREID_H_REAL_LOGS__) ? window.__PREID_H_REAL_LOGS__.slice(0, 120) : [];
  report.n0GLogs = Array.isArray(window.__N0_G_LOGS__) ? window.__N0_G_LOGS__.slice(0, 40) : [];
  report.n0PartLogs = Array.isArray(window.__N0_PART_LOGS__) ? window.__N0_PART_LOGS__.slice(0, 60) : [];
  report.feilinStLogs = Array.isArray(window.__FEILIN_ST_LOGS__) ? window.__FEILIN_ST_LOGS__.slice(0, 40) : [];
  report.feilinSeSnapshot = snapshotObjectShape(window.__FEILIN_SE__);
  report.feilinSaSnapshot = snapshotObjectShape(window.__FEILIN_SA__);
  report.feilinReSnapshot = snapshotObjectShape(feilinReState);
  report.feilinRaSnapshot = snapshotObjectShape(window.__FEILIN_RA__);
  report.feilinRkSnapshot = snapshotObjectShape(window.__FEILIN_RK__);
  report.feilinRmSnapshot = snapshotObjectShape(window.__FEILIN_RM__);
  report.feilinRoSnapshot = snapshotObjectShape(window.__FEILIN_RO__);
  report.feilinRuSnapshot = snapshotObjectShape(window.__FEILIN_RU__);
  report.feilinRnSnapshot = snapshotObjectShape(window.__FEILIN_RN__);
  report.aliyunDeviceCvsSnapshot = snapshotObjectShape(window._aliyun_device_cvs);
  report.aliyunDeviceIfrSnapshot = snapshotObjectShape(window._aliyun_device_ifr);
  report.feilinLastSessionDeriveSnapshot = snapshotObjectShape(window.__FEILIN_LAST_SESSION_DERIVE__);
  report.feilinSessionDeriveLogs = Array.isArray(window.__FEILIN_SESSION_DERIVE_LOGS__)
    ? window.__FEILIN_SESSION_DERIVE_LOGS__.slice(0, 40)
    : [];
  report.feilinDeriveHelperCalls = Array.isArray(window.__FEILIN_DERIVE_HELPER_CALLS__)
    ? window.__FEILIN_DERIVE_HELPER_CALLS__.slice(0, 120)
    : [];
  report.feilinDeriveSecretBlobSnapshot = snapshotObjectShape(window.__FEILIN_DERIVE_SECRET_BLOB__);
  report.feilinDeriveSessionBlobSnapshot = snapshotObjectShape(window.__FEILIN_DERIVE_SESSION_BLOB__);
  report.probeJsonParseLogs = Array.isArray(window.__PROBE_JSON_PARSE_LOGS__) ? window.__PROBE_JSON_PARSE_LOGS__.slice(0, 80) : [];
  report.probeJsonAccessLogs = Array.isArray(window.__PROBE_JSON_ACCESS_LOGS__) ? window.__PROBE_JSON_ACCESS_LOGS__.slice(0, 200) : [];
  report.probeAssignLogs = Array.isArray(window.__PROBE_ASSIGN_LOGS__) ? window.__PROBE_ASSIGN_LOGS__.slice(0, 80) : [];
  report.stage2OffsetLogs = {
    tokenFallback: sanitizeLogRows(window.__STAGE2_TOKEN_FALLBACK_LOGS__, 80, 800),
    vmApply: sanitizeLogRows(window.__STAGE2_VM_APPLY_LOGS__, 120, 800),
    dataBuild: sanitizeLogRows(window.__STAGE2_DATA_BUILD_LOGS__, 120, 800),
    finalJson: sanitizeLogRows(window.__STAGE2_FINAL_JSON_LOGS__, 80, 800),
    initState: sanitizeLogRows(window.__STAGE2_INIT_STATE_LOGS__, 120, 800),
    callbackFlow: sanitizeLogRows(window.__STAGE2_CALLBACK_FLOW_LOGS__, 120, 800),
    localFallback: sanitizeLogRows(window.__STAGE2_LOCAL_FALLBACK_LOGS__, 120, 800),
    dnFlow: sanitizeLogRows(window.__STAGE2_DN_FLOW_LOGS__, 120, 800),
    peBizSuccess: sanitizeLogRows(window.__STAGE2_PE_BIZ_SUCCESS_LOGS__, 120, 800),
  };
  report.extendConsumeLogs = Array.isArray(window.__EXTEND_CONSUME_LOGS__) ? window.__EXTEND_CONSUME_LOGS__.slice(0, 120) : [];
  if (options.postLiveInitStateProbe && typeof options.postLiveInitStateProbe === 'object') {
    try {
      applyLiveDeviceConfigProbe(window, options.postLiveInitStateProbe);
      report.postLiveInitStateSnapshot = {
        feilinRe: snapshotObjectShape(window.__FEILIN_RE__ || window.__FEILIN_EXPORT_RE__),
        aliyunInitState: snapshotObjectShape(window.__ALIYUN_INIT_STATE__),
        instanceConfig: snapshotObjectShape(window.__ALIYUN_LAST_INSTANCE__?.config),
      };
      const certifyId = typeof options.postLiveInitStateProbe.certifyId === 'string'
        ? options.postLiveInitStateProbe.certifyId
        : null;
      if (certifyId && window.um && typeof window.um.getToken === 'function') {
        report.postLiveInitStateUmToken = await captureTokenExecution(() => window.um.getToken(certifyId));
      }
      if (certifyId && window.z_um && typeof window.z_um.getToken === 'function') {
        report.postLiveInitStateZUmToken = await captureTokenExecution(() => window.z_um.getToken(certifyId));
      }
    } catch (err) {
      report.postLiveInitStateProbeError = String(err && err.stack || err);
    }
  }
  if (Array.isArray(options.reMutationExperimentInputs) && window.__FEILIN_RE__ && typeof window.__FEILIN_RE__ === 'object') {
    try {
      report.reMutationApplied = options.reMutationExperimentInputs.map((row) => {
        const path = Array.isArray(row?.path) ? row.path.map(String) : null;
        const value = row && Object.prototype.hasOwnProperty.call(row, 'value') ? row.value : undefined;
        if (!path || !path.length) return { ok: false, error: 'missing path' };
        const ok = setPathValue(window.__FEILIN_RE__, path, value);
        return {
          ok,
          path,
          valuePreview: previewValue(value, 300),
        };
      });
      report.feilinReSnapshotAfterMutation = snapshotObjectShape(window.__FEILIN_RE__);
    } catch (err) {
      report.reMutationApplied = { error: String(err && err.stack || err) };
    }
  }
  if (Array.isArray(options.rkMutationExperimentInputs) && window.__FEILIN_RK__ && typeof window.__FEILIN_RK__ === 'object') {
    try {
      report.rkMutationApplied = options.rkMutationExperimentInputs.map((row) => {
        const path = Array.isArray(row?.path) ? row.path.map(String) : null;
        const value = row && Object.prototype.hasOwnProperty.call(row, 'value') ? row.value : undefined;
        if (!path || !path.length) return { ok: false, error: 'missing path' };
        const ok = setPathValue(window.__FEILIN_RK__, path, value);
        return {
          ok,
          path,
          valuePreview: previewValue(value, 300),
        };
      });
      report.feilinRkSnapshotAfterMutation = snapshotObjectShape(window.__FEILIN_RK__);
    } catch (err) {
      report.rkMutationApplied = { error: String(err && err.stack || err) };
    }
  }
  if (Array.isArray(options.tyExperimentInputs) && typeof window.__PE_TY__ === 'function') {
    try {
      report.tyExperiment = options.tyExperimentInputs.map((row) => {
        const arg0 = row && Object.prototype.hasOwnProperty.call(row, 'arg0') ? row.arg0 : undefined;
        const arg1 = row && Object.prototype.hasOwnProperty.call(row, 'arg1') ? row.arg1 : undefined;
        try {
          const out = window.__PE_TY__(arg0, arg1);
          return {
            arg0: typeof arg0 === 'string' ? arg0.slice(0, 400) : previewValue(arg0, 200),
            arg1: typeof arg1 === 'string' ? arg1.slice(0, 400) : previewValue(arg1, 200),
            outputType: typeof out,
            outputPreview: typeof out === 'string' ? out.slice(0, 400) : previewValue(out, 200),
          };
        } catch (err) {
          return {
            arg0: typeof arg0 === 'string' ? arg0.slice(0, 400) : previewValue(arg0, 200),
            arg1: typeof arg1 === 'string' ? arg1.slice(0, 400) : previewValue(arg1, 200),
            error: String(err && err.stack || err),
          };
        }
      });
    } catch (err) {
      report.tyExperiment = { error: String(err && err.stack || err) };
    }
  }
  if (options.rsExperimentPhase == null && Array.isArray(options.rsExperimentInputs) && typeof window.__FEILIN_RS__ === 'function') {
    try {
      report.rsExperiment = options.rsExperimentInputs.map((row) => {
        const label = row && Object.prototype.hasOwnProperty.call(row, 'label') ? row.label : null;
        const arg0 = row && Object.prototype.hasOwnProperty.call(row, 'arg0') ? row.arg0 : undefined;
        const arg1 = row && Object.prototype.hasOwnProperty.call(row, 'arg1') ? row.arg1 : undefined;
        const thisKind = row && Object.prototype.hasOwnProperty.call(row, 'thisKind') ? row.thisKind : null;
        try {
          const rsStart = Array.isArray(window.__FEILIN_RS_LOGS__) ? window.__FEILIN_RS_LOGS__.length : 0;
          const rsInnerStart = Array.isArray(window.__FEILIN_RS_INNER_LOGS__) ? window.__FEILIN_RS_INNER_LOGS__.length : 0;
          const arg1ProxyStart = Array.isArray(window.__RS_ARG1_PROXY_LOGS__) ? window.__RS_ARG1_PROXY_LOGS__.length : 0;
          const cryptoTraceStart = Array.isArray(window.__CRYPTO_TRACE_LOGS__) ? window.__CRYPTO_TRACE_LOGS__.length : 0;
          const raTraceStart = Array.isArray(window.__FEILIN_RA20_LOGS__) ? window.__FEILIN_RA20_LOGS__.length : 0;
          let thisArg = window;
          if (thisKind === 'last-rs') thisArg = window.__FEILIN_RS_LAST_THIS__ || window;
          else if (thisKind === 'last-rx') thisArg = window.__FEILIN_RX_LAST_THIS__ || window;
          else if (thisKind === 'null') thisArg = null;
          else if (thisKind === 'undefined') thisArg = undefined;
          let effectiveArg1 = arg1;
          if (row?.wrapArg1AsStringProxy && typeof arg1 === 'string') {
            const source = new String(arg1);
            effectiveArg1 = new Proxy(source, {
              get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver);
                try {
                  window.__RS_ARG1_PROXY_LOGS__ = window.__RS_ARG1_PROXY_LOGS__ || [];
                  const propName = String(prop);
                  window.__RS_ARG1_PROXY_LOGS__.push({
                    label,
                    prop: propName,
                    valueType: typeof value,
                    valuePreview: typeof value === 'string'
                      ? value.slice(0, 240)
                      : typeof value === 'function'
                      ? String(value).slice(0, 240)
                      : previewValue(value, 160),
                    stack: String((new Error('RS_ARG1_PROXY_GET')).stack || '').slice(0, 1200),
                  });
                  if (window.__RS_ARG1_PROXY_LOGS__.length > 2000) {
                    window.__RS_ARG1_PROXY_LOGS__.shift();
                  }
                } catch {
                  // ignore
                }
                if (typeof value === 'function') {
                  return function proxiedMethod(...methodArgs) {
                    try {
                      window.__RS_ARG1_PROXY_LOGS__ = window.__RS_ARG1_PROXY_LOGS__ || [];
                      window.__RS_ARG1_PROXY_LOGS__.push({
                        label,
                        prop: String(prop),
                        call: true,
                        argsPreview: methodArgs.map((item) => typeof item === 'string' ? item.slice(0, 120) : previewValue(item, 80)),
                        stack: String((new Error('RS_ARG1_PROXY_CALL')).stack || '').slice(0, 1200),
                      });
                      if (window.__RS_ARG1_PROXY_LOGS__.length > 2000) {
                        window.__RS_ARG1_PROXY_LOGS__.shift();
                      }
                    } catch {
                      // ignore
                    }
                    return value.apply(target, methodArgs);
                  };
                }
                return value;
              },
            });
          }
          const rsFn = typeof window.__FEILIN_RS_ORIGINAL__ === 'function'
            ? window.__FEILIN_RS_ORIGINAL__
            : window.__FEILIN_RS__;
          const out = rsFn.apply(thisArg, [arg0, effectiveArg1]);
          let outString = null;
          try {
            outString = typeof out === 'string' ? out : String(out);
          } catch {
            outString = null;
          }
          const details = typeof window.captureRsOutputDetails === 'function'
            ? window.captureRsOutputDetails(out)
            : null;
          const rsDelta = (window.__FEILIN_RS_LOGS__ || []).slice(rsStart);
          const rsInnerDelta = (window.__FEILIN_RS_INNER_LOGS__ || []).slice(rsInnerStart);
          const arg1ProxyDelta = (window.__RS_ARG1_PROXY_LOGS__ || []).slice(arg1ProxyStart);
          const cryptoTraceDelta = (window.__CRYPTO_TRACE_LOGS__ || []).slice(cryptoTraceStart);
          const raTraceDelta = (window.__FEILIN_RA20_LOGS__ || []).slice(raTraceStart);
          const lastRsLog = rsDelta.length ? rsDelta[rsDelta.length - 1] : null;
          return {
            label,
            thisKind,
            thisType: typeof thisArg,
            thisCtor: thisArg && thisArg.constructor && thisArg.constructor.name ? thisArg.constructor.name : null,
            thisKeys: thisArg && typeof thisArg === 'object' ? Object.keys(thisArg).slice(0, 20) : null,
            arg0: typeof arg0 === 'string' ? arg0.slice(0, 400) : previewValue(arg0, 200),
            arg1Length: typeof arg1 === 'string' ? arg1.length : null,
            arg1Preview: typeof arg1 === 'string' ? arg1.slice(0, 800) : previewValue(arg1, 300),
            outputType: typeof out,
            outputPreview: typeof out === 'string' ? out.slice(0, 400) : previewValue(out, 200),
            outputString: typeof outString === 'string' ? outString.slice(0, 1200) : null,
            outputStringLength: typeof outString === 'string' ? outString.length : null,
            outputDecodedPreview: typeof outString === 'string' ? decodeBase64Utf8(outString, 400) : null,
            lastAId: lastRsLog?.lastAId ?? null,
            innerLogCount: Array.isArray(lastRsLog?.innerStages) ? lastRsLog.innerStages.length : rsInnerDelta.length,
            innerStages: Array.isArray(lastRsLog?.innerStages)
              ? lastRsLog.innerStages.slice(0, 20)
              : rsInnerDelta.map((x) => x?.stage || null).slice(0, 20),
            innerThrow: lastRsLog?.innerThrow || rsInnerDelta.find((x) => x?.stage === 'method-throw') || null,
            innerLogs: rsInnerDelta.slice(0, 20).map((entry) => ({
              stage: entry?.stage || null,
              aType: entry?.aType || null,
              aId: entry?.aId ?? null,
              aKeys: Array.isArray(entry?.aKeys) ? entry.aKeys.slice(0, 20) : null,
              aSource: typeof entry?.aSource === 'string' ? entry.aSource.slice(0, 400) : null,
              thisType: entry?.thisType || null,
              thisKeys: Array.isArray(entry?.thisKeys) ? entry.thisKeys.slice(0, 20) : null,
              methodKey: entry?.methodKey || null,
              methodType: entry?.methodType || null,
              methodSource: typeof entry?.methodSource === 'string' ? entry.methodSource.slice(0, 400) : null,
              outType: entry?.outType || null,
              outPreview: typeof entry?.outPreview === 'string' ? entry.outPreview.slice(0, 400) : previewValue(entry?.outPreview, 220),
              arg0: typeof entry?.arg0 === 'string' ? entry.arg0.slice(0, 160) : previewValue(entry?.arg0, 120),
              arg1Length: typeof entry?.arg1Length === 'number' ? entry.arg1Length : null,
              arg1Head: typeof entry?.arg1Head === 'string' ? entry.arg1Head.slice(0, 280) : previewValue(entry?.arg1Head, 160),
              error: entry?.error || null,
            })),
            arg1ProxyLogs: arg1ProxyDelta.slice(0, 80).map((entry) => ({
              label: entry?.label || null,
              prop: entry?.prop || null,
              call: !!entry?.call,
              valueType: entry?.valueType || null,
              valuePreview: entry?.valuePreview || null,
              argsPreview: entry?.argsPreview || null,
              stack: typeof entry?.stack === 'string' ? entry.stack.split('\n').slice(0, 4) : null,
            })),
            cryptoTraceLogs: cryptoTraceDelta.slice(0, 240).map((entry) => ({
              stage: entry?.stage || null,
              inputLength: entry?.inputLength ?? null,
              inputPreview: typeof entry?.inputPreview === 'string' ? entry.inputPreview.slice(0, 240) : null,
              sourceBytes: entry?.sourceBytes ?? null,
              sourceUtf8Preview: typeof entry?.sourceUtf8Preview === 'string' ? entry.sourceUtf8Preview.slice(0, 240) : null,
              sourceHexPreview: typeof entry?.sourceHexPreview === 'string' ? entry.sourceHexPreview.slice(0, 240) : null,
              keyBytes: entry?.keyBytes ?? null,
              keyHexPreview: typeof entry?.keyHexPreview === 'string' ? entry.keyHexPreview.slice(0, 120) : null,
              ivBytes: entry?.ivBytes ?? null,
              ivHexPreview: typeof entry?.ivHexPreview === 'string' ? entry.ivHexPreview.slice(0, 120) : null,
              cipherSigBytes: entry?.cipherSigBytes ?? null,
              cipherHexPreview: typeof entry?.cipherHexPreview === 'string' ? entry.cipherHexPreview.slice(0, 160) : null,
              stack: typeof entry?.stack === 'string' ? entry.stack.split('\n').slice(0, 5) : null,
            })),
            raTraceLogs: raTraceDelta.slice(0, 400).map((entry) => ({
              stage: entry?.stage || null,
              step: entry?.step ?? null,
              opcode: entry?.opcode ?? null,
              i: entry?.i ?? null,
              arg0: typeof entry?.arg0 === 'string' ? entry.arg0.slice(0, 220) : previewValue(entry?.arg0, 120),
              arg1Length: entry?.arg1Length ?? null,
              arg1Head: typeof entry?.arg1Head === 'string' ? entry.arg1Head.slice(0, 240) : previewValue(entry?.arg1Head, 120),
              nType: entry?.nType || null,
              nPreview: typeof entry?.nPreview === 'string' ? entry.nPreview.slice(0, 220) : previewValue(entry?.nPreview, 120),
              sType: entry?.sType || null,
              sPreview: typeof entry?.sPreview === 'string' ? entry.sPreview.slice(0, 220) : previewValue(entry?.sPreview, 120),
              fType: entry?.fType || null,
              fPreview: typeof entry?.fPreview === 'string' ? entry.fPreview.slice(0, 220) : previewValue(entry?.fPreview, 120),
              lType: entry?.lType || null,
              lPreview: typeof entry?.lPreview === 'string' ? entry.lPreview.slice(0, 220) : previewValue(entry?.lPreview, 120),
              MType: entry?.MType || null,
              MPreview: typeof entry?.MPreview === 'string' ? entry.MPreview.slice(0, 220) : previewValue(entry?.MPreview, 120),
              O: entry?.O ?? null,
              ta: entry?.ta ?? null,
              returnType: entry?.returnType || null,
              returnPreview: typeof entry?.returnPreview === 'string' ? entry.returnPreview.slice(0, 220) : previewValue(entry?.returnPreview, 120),
            })),
            ...(details || {}),
          };
        } catch (err) {
          return {
            label,
            thisKind,
            arg0: typeof arg0 === 'string' ? arg0.slice(0, 400) : previewValue(arg0, 200),
            arg1Length: typeof arg1 === 'string' ? arg1.length : null,
            arg1Preview: typeof arg1 === 'string' ? arg1.slice(0, 800) : previewValue(arg1, 300),
            error: String(err && err.stack || err),
          };
        }
      });
    } catch (err) {
      report.rsExperiment = { error: String(err && err.stack || err) };
    }
  }
  if (options.rsAidReplayExperiment && window.__FEILIN_RS_FN_REGISTRY__ && typeof window.__FEILIN_RS__ === 'function') {
    try {
      const rsLogs = Array.isArray(window.__FEILIN_RS_LOGS__) ? window.__FEILIN_RS_LOGS__ : [];
      const pickSample = (predicate) => rsLogs.find((row) => {
        try {
          return predicate(row);
        } catch {
          return false;
        }
      }) || null;
      const successSample = pickSample((row) =>
        typeof row?.outputString === 'string' &&
        row.outputString !== 'null' &&
        Array.isArray(row.innerStages) &&
        row.innerStages.includes('after-method') &&
        typeof row.arg0 === 'string' &&
        typeof row.arg1 === 'string');
      const nullSample = pickSample((row) =>
        row?.outputString === 'null' &&
        Array.isArray(row.innerStages) &&
        !row.innerStages.includes('after-method') &&
        typeof row.arg0 === 'string' &&
        typeof row.arg1 === 'string');
      const chooseThisArg = (kind) => {
        if (kind === 'last-rs') return window.__FEILIN_RS_LAST_THIS__ || window;
        if (kind === 'last-rx') return window.__FEILIN_RX_LAST_THIS__ || window;
        if (kind === 'null') return null;
        if (kind === 'undefined') return undefined;
        return window;
      };
      const replayWithAid = (aid, label, sample, thisKind = 'undefined', argsMode = 'array') => {
        if (!aid || !sample) return { label, aid: aid ?? null, missing: true };
        const fn = window.__FEILIN_RS_FN_REGISTRY__[aid];
        if (typeof fn !== 'function') {
          return { label, aid, missingFunction: true };
        }
        const thisArg = chooseThisArg(thisKind);
        const runtimeArgs = argsMode === 'arguments'
          ? (function() { return arguments; })(sample.arg0, sample.arg1)
          : [sample.arg0, sample.arg1];
        try {
          const out = fn.apply(thisArg, runtimeArgs);
          let outString = null;
          try {
            outString = typeof out === 'string' ? out : String(out);
          } catch {
            outString = null;
          }
          return {
            label,
            aid,
            thisKind,
            argsMode,
            arg0: sample.arg0.slice(0, 160),
            arg1Length: sample.arg1.length,
            arg1Head: sample.arg1.slice(0, 280),
            outputType: typeof out,
            outputString: typeof outString === 'string' ? outString.slice(0, 1200) : null,
            outputDecodedPreview: typeof outString === 'string' ? decodeBase64Utf8(outString, 300) : null,
          };
        } catch (err) {
          return {
            label,
            aid,
            thisKind,
            argsMode,
            arg0: sample.arg0.slice(0, 160),
            arg1Length: sample.arg1.length,
            arg1Head: sample.arg1.slice(0, 280),
            error: String(err && err.stack || err),
          };
        }
      };
      report.rsAidReplayExperiment = {
        successSample: successSample ? {
          aid: successSample.lastAId ?? null,
          arg0: successSample.arg0.slice(0, 160),
          arg1Length: successSample.arg1.length,
          arg1Head: successSample.arg1.slice(0, 280),
          outputString: successSample.outputString.slice(0, 160),
        } : null,
        nullSample: nullSample ? {
          aid: nullSample.lastAId ?? null,
          arg0: nullSample.arg0.slice(0, 160),
          arg1Length: nullSample.arg1.length,
          arg1Head: nullSample.arg1.slice(0, 280),
          outputString: nullSample.outputString,
        } : null,
        rows: [
          replayWithAid(successSample?.lastAId ?? null, 'success-aid/success-input[array]', successSample, 'undefined', 'array'),
          replayWithAid(successSample?.lastAId ?? null, 'success-aid/success-input[arguments]', successSample, 'undefined', 'arguments'),
          replayWithAid(successSample?.lastAId ?? null, 'success-aid/null-input[array]', nullSample, 'undefined', 'array'),
          replayWithAid(successSample?.lastAId ?? null, 'success-aid/null-input[arguments]', nullSample, 'undefined', 'arguments'),
          replayWithAid(nullSample?.lastAId ?? null, 'null-aid/success-input[array]', successSample, 'undefined', 'array'),
          replayWithAid(nullSample?.lastAId ?? null, 'null-aid/success-input[arguments]', successSample, 'undefined', 'arguments'),
          replayWithAid(nullSample?.lastAId ?? null, 'null-aid/null-input[array]', nullSample, 'undefined', 'array'),
          replayWithAid(nullSample?.lastAId ?? null, 'null-aid/null-input[arguments]', nullSample, 'undefined', 'arguments'),
        ],
      };
    } catch (err) {
      report.rsAidReplayExperiment = { error: String(err && err.stack || err) };
    }
  }
  report.documentCookie = window.document?.cookie || '';
  report.localStorageSnapshot = typeof window.localStorage?._dump === 'function' ? window.localStorage._dump() : {};
  report.sessionStorageSnapshot = typeof window.sessionStorage?._dump === 'function' ? window.sessionStorage._dump() : {};
  process.off('unhandledRejection', onUnhandledRejection);
  process.off('uncaughtException', onUncaughtException);
  return report;
}

async function main() {
  const files = process.argv.slice(2);
  const report = await runProbe(files);
  console.log(JSON.stringify(report, null, 2));
  setTimeout(() => process.exit(0), 10);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  module.exports = {
    applyAliyunSgRuntimeOverrides,
    applyLiveDeviceConfigProbe,
    createContext,
    byteLikeHexPreview,
    encodeFinalCaptchaVerifyParam,
    ensureAliyunCaptchaScaffold,
    normalizeAliyunRuntimeState,
    patchAliyunCaptchaSource,
    previewValue,
    runProbe,
    tryDecodeBase64Json,
    wordArrayToHexPreview,
  };
}
