#!/usr/bin/env node
const fs = require('fs');
const vm = require('vm');
const {
  createContext,
  applyAliyunSgRuntimeOverrides,
  applyLiveDeviceConfigProbe,
  normalizeAliyunRuntimeState,
  ensureAliyunCaptchaScaffold,
  patchAliyunCaptchaSource,
} = require('./probe_feilin_runtime');
const {
  parseTokenPlain,
  computeFifthSegment,
  verifyTokenPlain,
  buildFullToken,
  normalizeToBrowserLikeInitToken,
} = require('./feilin_local_token');
const { buildTokenLPreviewFromVector } = require('./aliyun_token_vector');
const { encodeDeviceConfigParts } = require('./aliyun_local_reverse');

function decodeBase64Utf8(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function isLikelyBase64(value) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
  } catch {
    return false;
  }
}

function patchFeilinForExports(source) {
  let out = patchAliyunCaptchaSource(source, {});
  const rxStart = out.indexOf('function rx(t,r){');
  const rxEnd = out.indexOf('function rI(t){', rxStart);
  if (rxStart >= 0 && rxEnd > rxStart && !out.includes('window.__FEILIN_RX__=rx;')) {
    out = out.slice(0, rxEnd) + 'window.__FEILIN_RX__=rx;' + out.slice(rxEnd);
  }
  if (!out.includes('window.__FEILIN_EXPORT_RE__=re;')) {
    out = out.replace(
      'function sb(t,r,e){',
      'window.__FEILIN_EXPORT_RE__=typeof re!=="undefined"?re:void 0;function sb(t,r,e){',
    );
  }
  return out;
}

function mergePlainObjects(base, override) {
  const out = { ...(base && typeof base === 'object' ? base : {}) };
  if (!override || typeof override !== 'object') return out;
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergePlainObjects(out[key], value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

const DEFAULT_FEILIN_APP_KEY = '3795d28242a11619bc25f786f84e53d4';
const DEFAULT_FEILIN_RS_SEED = 'FqJB6iRNVYdEGpwb';
const DEFAULT_SV_LOGS = ['10-0', '11-50', '20-56', '23-202', '30-209', '60-215', '61-292', '70-298', '71-323', '80-323', '81-328'];

function randomHex(bytes = 16) {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < bytes * 2; i += 1) {
    out += chars[(Math.random() * 16) | 0];
  }
  return out;
}

function isSaneSecondSegment(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}-h-\d{10,16}-[0-9a-f]{32}$/i.test(value);
}

function buildSyntheticLog1DeviceConfig(now = Date.now()) {
  const appKey = DEFAULT_FEILIN_APP_KEY;
  const sessionId = `${appKey}-h-${now}-${randomHex(16)}`;
  const wrap = (value) => value ? Buffer.from(String(value), 'utf8').toString('base64') : '';
  return encodeDeviceConfigParts([
    wrap(appKey),
    wrap('513'),
    sessionId,
    '3.25.0',
    wrap(''),
    wrap(''),
    wrap(''),
    String(now),
    '1.2.3.4',
  ]);
}

class FeilinVmRuntime {
  constructor({ feilinPath = '/tmp/feilin.js', dynamicPath = '/tmp/aliyun-pe.js', loaderPath = '/tmp/AliyunCaptcha.js' } = {}) {
    this.paths = { feilinPath, dynamicPath, loaderPath };
    const {
      initialAliyunCaptchaConfig = { region: 'cn', prefix: 'no8xfe' },
      setGlobalAliyunCaptchaConfig = true,
      documentCookie = null,
      localStorageSeed = null,
      sessionStorageSeed = null,
      cookieSeed = null,
      navigatorOverrides = null,
      screenOverrides = null,
      navigatorLanguages = null,
      windowOverrides = null,
      referrer = null,
      locationHref = null,
      mediaScenario = null,
      log1DeviceConfig = null,
      log1ResultObject = null,
      patchAliyunOptions = {},
      captureXhrStacks = false,
      executeLive = false,
      sessionContext = null,
    } = arguments[0] || {};
    const { context, window, umTrace, zUmTrace, xhrLog, mediaDeviceLogs } = createContext({ push() {}, all() { return []; } }, {
      setGlobalAliyunCaptchaConfig,
      initialAliyunCaptchaConfig,
      documentCookie,
      localStorageSeed,
      sessionStorageSeed,
      cookieSeed,
      navigatorOverrides,
      screenOverrides,
      navigatorLanguages,
      windowOverrides,
      referrer,
      locationHref,
      mediaScenario,
      log1DeviceConfig,
      log1ResultObject,
      patchAliyunOptions,
      captureXhrStacks,
      executeLive,
      sessionContext,
    });
    this.context = context;
    this.window = window;
    this.umTrace = umTrace || null;
    this.zUmTrace = zUmTrace || null;
    this.xhrLog = xhrLog || [];
    this.mediaDeviceLogs = mediaDeviceLogs || [];
    this.lastAutoInitEvents = [];
    this.initialAliyunCaptchaConfig = initialAliyunCaptchaConfig;
    this.syntheticLog1DeviceConfig = log1DeviceConfig || null;
    this.patchAliyunOptions = patchAliyunOptions && typeof patchAliyunOptions === 'object'
      ? patchAliyunOptions
      : {};
    this._load();
  }

  _load() {
    const { feilinPath, dynamicPath, loaderPath } = this.paths;
    const scripts = [
      [feilinPath, patchFeilinForExports(fs.readFileSync(feilinPath, 'utf8'))],
      [dynamicPath, patchAliyunCaptchaSource(fs.readFileSync(dynamicPath, 'utf8'), this.patchAliyunOptions)],
      [loaderPath, patchAliyunCaptchaSource(fs.readFileSync(loaderPath, 'utf8'), this.patchAliyunOptions)],
    ];
    for (const [file, source] of scripts) {
      vm.runInContext(source, this.context, { timeout: 15000, filename: file });
    }
    this.refreshExports();
    if (typeof this.rx !== 'function') {
      throw new Error('failed to expose rx from Feilin bundle');
    }
    if (typeof this.ra !== 'function') {
      throw new Error('failed to expose ra from Feilin bundle');
    }
    if (!this.re || typeof this.re !== 'object') {
      throw new Error('failed to expose re/session config from Feilin bundle');
    }
  }

  refreshExports() {
    this.rx = this.window.__FEILIN_RX__;
    this.ra = this.window.__FEILIN_RA__;
    this.rs = this.window.__FEILIN_RS__ || this.window.__FEILIN_RS_ORIGINAL__;
    this.re = this.window.__FEILIN_RE__ || this.window.__FEILIN_EXPORT_RE__;
    this.sb = this.window.__FEILIN_SB__ || null;
    this.seFn = this.window.__FEILIN_SE_FN__ || null;
    this.svFn = this.window.__FEILIN_SV_FN__ || null;
    this.io = this.window.__FEILIN_IO__ || null;
    this.iu = this.window.__FEILIN_IU__ || null;
    this.ub = this.window.__FEILIN_UB__ || this.window.ub || null;
    this.uY = this.window.__FEILIN_UY__ || this.window.uY || null;
    this.st = this.window.__FEILIN_ST__ || this.window.st || null;
    this.deriveSecretBlob = this.window.__FEILIN_DERIVE_SECRET_BLOB__ || null;
    this.deriveSessionBlob = this.window.__FEILIN_DERIVE_SESSION_BLOB__ || null;
    return this;
  }

  async ready(waitMs = 300, options = {}) {
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.um = this.window.um;
    this.refreshExports();
    if (!this.um || typeof this.um.getToken !== 'function') {
      throw new Error('window.um.getToken unavailable');
    }
    if (options.bootstrapAutoInit) {
      await this.bootstrapAliyunCaptcha(options.bootstrapAutoInit === true ? {} : options.bootstrapAutoInit);
    }
    return this;
  }

  static async create(options = {}) {
    const runtime = new FeilinVmRuntime(options);
    await runtime.ready(300, options);
    return runtime;
  }

  getSessionId() {
    return typeof this.re.sessionId === 'string' ? this.re.sessionId : null;
  }

  setSessionId(sessionIdBase64) {
    if (typeof sessionIdBase64 !== 'string' || !sessionIdBase64) {
      throw new Error('sessionIdBase64 must be a non-empty string');
    }
    this.re.sessionId = sessionIdBase64;
  }

  async computeToken() {
    const fallbackDeviceToken = () => {
      const browserLike = this.getBrowserLikeInitDeviceToken();
      if (browserLike?.encoded && browserLike?.parsed?.second && isSaneSecondSegment(browserLike.parsed.second)) {
        return {
          source: browserLike.browserLikeFrom || browserLike.preferredFrom || browserLike.source || 're.DeviceToken',
          encoded: browserLike.encoded,
          plain: browserLike.plain,
          parsed: browserLike.parsed,
        };
      }
      return null;
    };
    const candidates = [];
    if (this.window.um && typeof this.window.um.getToken === 'function') {
      candidates.push({ label: 'um.getToken', fn: () => this.window.um.getToken.call(this.window.um) });
    }
    if (this.window.z_um && typeof this.window.z_um.getToken === 'function') {
      candidates.push({ label: 'z_um.getToken', fn: () => this.window.z_um.getToken.call(this.window.z_um) });
    }
    const certifyId = Array.isArray(this.xhrLog)
      ? this.xhrLog.find((entry) => entry?.params?.Action === 'VerifyCaptchaV3')?.params?.CertifyId || null
      : null;
    if (certifyId && this.window.um && typeof this.window.um.getToken === 'function') {
      candidates.push({ label: 'um.getToken(certifyId)', fn: () => this.window.um.getToken.call(this.window.um, certifyId) });
    }
    if (certifyId && this.window.z_um && typeof this.window.z_um.getToken === 'function') {
      candidates.push({ label: 'z_um.getToken(certifyId)', fn: () => this.window.z_um.getToken.call(this.window.z_um, certifyId) });
    }
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const encoded = await Promise.resolve(candidate.fn());
        const plain = decodeBase64Utf8(encoded);
        const parsed = parseTokenPlain(plain);
        if (typeof encoded === 'string' && encoded && isSaneSecondSegment(parsed?.second || '')) {
          return { source: candidate.label, encoded, plain, parsed };
        }
        if (typeof encoded === 'string' && encoded) {
          const fallback = fallbackDeviceToken();
          if (fallback) {
            return fallback;
          }
          return { source: candidate.label, encoded, plain, parsed };
        }
      } catch (error) {
        lastError = error;
      }
    }
    const fallback = fallbackDeviceToken();
    if (fallback) {
      return fallback;
    }
    if (lastError) {
      throw lastError;
    }
    return { source: null, encoded: '', plain: null, parsed: null };
  }

  _normalizeTokenCandidate(encoded, source = null) {
    const plain = decodeBase64Utf8(encoded);
    const parsed = parseTokenPlain(plain);
    return {
      source,
      encoded: typeof encoded === 'string' ? encoded : null,
      plain,
      parsed,
      isBase64: isLikelyBase64(encoded),
      isReadableInitToken: !!(plain && plain.startsWith('SG_WEB#')),
    };
  }

  getRuntimeDeviceToken() {
    const encoded =
      this.re?.DeviceToken ||
      this.window.__FEILIN_RE__?.DeviceToken ||
      this.window.__FEILIN_EXPORT_RE__?.DeviceToken ||
      null;
    return this._normalizeTokenCandidate(encoded, 're.DeviceToken');
  }

  buildInitDeviceTokenCandidate(secondSegment = null) {
    const second =
      secondSegment ||
      this.re?.deviceConfig?.sessionId ||
      this.window.__FEILIN_RE__?.deviceConfig?.sessionId ||
      this.window.__FEILIN_EXPORT_RE__?.deviceConfig?.sessionId ||
      null;
    if (typeof second !== 'string' || !second) {
      return {
        source: 'deviceConfig.sessionId',
        encoded: null,
        plain: null,
        parsed: null,
        verify: null,
        isBase64: false,
        isReadableInitToken: false,
      };
    }
    const plain = buildFullToken(second);
    return {
      source: 'deviceConfig.sessionId',
      encoded: Buffer.from(plain, 'utf8').toString('base64'),
      plain,
      parsed: parseTokenPlain(plain),
      verify: verifyTokenPlain(plain),
      isBase64: true,
      isReadableInitToken: true,
    };
  }

  normalizeInitDeviceTokenCandidate(candidate, source = null) {
    const plain = candidate?.plain;
    const parsed = candidate?.parsed || parseTokenPlain(plain);
    if (!parsed?.second) {
      return {
        ...(candidate || {}),
        source: source || candidate?.source || null,
        normalizedFrom: null,
        verify: candidate?.verify || null,
      };
    }
    if (parsed.prefix === 'SG_WEB') {
      return {
        ...(candidate || {}),
        source: source || candidate?.source || null,
        normalizedFrom: null,
        verify: candidate?.verify || verifyTokenPlain(plain),
      };
    }
    const normalized = normalizeToBrowserLikeInitToken(plain);
    return {
      source: source || candidate?.source || null,
      encoded: normalized?.normalizedPlain ? Buffer.from(normalized.normalizedPlain, 'utf8').toString('base64') : null,
      plain: normalized?.normalizedPlain || null,
      parsed: normalized?.normalizedPlain ? parseTokenPlain(normalized.normalizedPlain) : null,
      verify: normalized?.verify || null,
      isBase64: true,
      isReadableInitToken: true,
      normalizedFrom: normalized?.normalizedFrom || parsed.prefix || 'unknown',
      original: candidate || null,
    };
  }

  getPreferredDeviceToken() {
    const runtime = this.getRuntimeDeviceToken();
    if (runtime.isReadableInitToken) {
      return { ...runtime, preferredFrom: 'runtime' };
    }
    const synthesized = this.buildInitDeviceTokenCandidate();
    if (synthesized.isReadableInitToken) {
      return { ...synthesized, preferredFrom: 'deviceConfig.sessionId' };
    }
    return { ...runtime, preferredFrom: runtime.encoded ? 'runtime-fallback' : null };
  }

  getBrowserLikeInitDeviceToken() {
    const preferred = this.getPreferredDeviceToken();
    if (preferred?.isReadableInitToken) {
      return { ...preferred, browserLikeFrom: preferred.preferredFrom || preferred.source || null };
    }
    const normalizedRuntime = this.normalizeInitDeviceTokenCandidate(this.getRuntimeDeviceToken(), 're.DeviceToken');
    if (normalizedRuntime?.isReadableInitToken) {
      return { ...normalizedRuntime, browserLikeFrom: 'normalize-runtime-token' };
    }
    const synthesized = this.buildInitDeviceTokenCandidate();
    return { ...synthesized, browserLikeFrom: synthesized?.plain ? 'synthesized-from-deviceConfig.sessionId' : null };
  }

  async bootstrapAliyunCaptcha(options = {}) {
    const window = this.window;
    const events = [];
    this.lastAutoInitEvents = events;
    if (typeof window.initAliyunCaptcha !== 'function') {
      return { ok: false, reason: 'initAliyunCaptcha unavailable', events };
    }
    const previewValue = (value, limit = 400) => {
      if (typeof value === 'string') return value.slice(0, limit);
      if (value == null) return value;
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return String(value).slice(0, limit);
      }
    };
    const holderId = options.elementId || 'chat-captcha-element';
    const buttonId = options.buttonId || 'chat-captcha-trigger';
    const liveProbeConfig = {
      certifyId:
        options.initialAliyunCaptchaConfig?.CertifyId ||
        options.initialAliyunCaptchaConfig?.UserCertifyId ||
        options.initialAliyunCaptchaConfig?.certifyId ||
        this.initialAliyunCaptchaConfig?.CertifyId ||
        this.initialAliyunCaptchaConfig?.UserCertifyId ||
        this.initialAliyunCaptchaConfig?.certifyId ||
        null,
      deviceConfigRaw:
        options.initialAliyunCaptchaConfig?.DeviceConfig ||
        this.initialAliyunCaptchaConfig?.DeviceConfig ||
        null,
      deviceConfig:
        options.initialAliyunCaptchaConfig?.deviceConfig ||
        this.initialAliyunCaptchaConfig?.deviceConfig ||
        null,
      deviceToken:
        options.initialAliyunCaptchaConfig?.DeviceToken ||
        this.initialAliyunCaptchaConfig?.DeviceToken ||
        null,
    };
    try {
      const scaffoldNodes = ensureAliyunCaptchaScaffold(window.document);
      if (scaffoldNodes.length) {
        events.push({ type: 'scaffoldNodes', created: scaffoldNodes });
      }
      if (window.AliyunCaptcha?.prototype) {
        const proto = window.AliyunCaptcha.prototype;
        if (typeof proto.onBizSuccess === 'function' && !proto.__feilinVmPatchedOnBizSuccess) {
          const raw = proto.onBizSuccess;
          proto.onBizSuccess = function (...args) {
            events.push({ type: 'proto.onBizSuccess', args: args.map((x) => previewValue(x, 4000)) });
            return raw.apply(this, args);
          };
          proto.__feilinVmPatchedOnBizSuccess = true;
        }
        if (typeof proto.onBizFail === 'function' && !proto.__feilinVmPatchedOnBizFail) {
          const raw = proto.onBizFail;
          proto.onBizFail = function (...args) {
            events.push({ type: 'proto.onBizFail', args: args.map((x) => previewValue(x, 4000)) });
            return raw.apply(this, args);
          };
          proto.__feilinVmPatchedOnBizFail = true;
        }
      }
      let holder = window.document.getElementById(holderId);
      if (!holder) {
        holder = window.document.createElement('div');
        holder.id = holderId;
        window.document.body.appendChild(holder);
      }
      let button = window.document.getElementById(buttonId);
      if (!button) {
        button = window.document.createElement('button');
        button.id = buttonId;
        window.document.body.appendChild(button);
      }
      await Promise.race([
        new Promise((resolve) => {
          let instanceRef = null;
          let triggered = false;
          const initConfig = {
            SceneId: 'didk33e0',
            mode: 'popup',
            element: `#${holderId}`,
            button: `#${buttonId}`,
            captchaLogoImg: 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg',
            language: 'en',
            timeout: 1000,
            delayBeforeSuccess: false,
            success: (e) => {
              events.push({ type: 'success', payload: previewValue(e, 4000) });
              resolve(null);
            },
            fail: (e) => { events.push({ type: 'fail', payload: previewValue(e, 4000) }); resolve(null); },
            onError: (e) => { events.push({ type: 'error', payload: String(e) }); resolve(null); },
            onClose: () => { events.push({ type: 'close' }); resolve(null); },
            getInstance: (e) => {
              instanceRef = e;
              normalizeAliyunRuntimeState(
                e || null,
                e?.captcha?.AliyunCaptcha || e?.captcha || null,
                window.__ALIYUN_INIT_STATE__ || initConfig,
              );
              applyLiveDeviceConfigProbe(window, liveProbeConfig);
              events.push({
                type: 'instance',
                keys: e ? Object.keys(e).slice(0, 20) : [],
                protoKeys: e ? Object.getOwnPropertyNames(Object.getPrototypeOf(e)).slice(0, 40) : [],
              });
              events.push({
                type: 'captcha-instance',
                captchaKeys: e?.captcha ? Object.keys(e.captcha).slice(0, 30) : [],
                captchaProtoKeys: e?.captcha ? Object.getOwnPropertyNames(Object.getPrototypeOf(e.captcha)).slice(0, 40) : [],
              });
              events.push({
                type: 'instance.injected-live-config',
                certifyId: liveProbeConfig.certifyId || null,
                hasDeviceConfigRaw: !!liveProbeConfig.deviceConfigRaw,
                hasDeviceToken: !!liveProbeConfig.deviceToken,
              });
              if (triggered) return;
              triggered = true;
              setTimeout(() => {
                try {
                  if (Array.isArray(options.syntheticEventsBeforeTrigger) && options.syntheticEventsBeforeTrigger.length > 0) {
                    for (const row of options.syntheticEventsBeforeTrigger) {
                      const type = row?.type || 'mousemove';
                      window.dispatchEvent(new window.Event(type, { bubbles: true }));
                    }
                    events.push({ type: 'syntheticEventsBeforeTrigger', count: options.syntheticEventsBeforeTrigger.length });
                  }
                  if (typeof instanceRef?.startTracelessVerification === 'function') {
                    events.push({ type: 'trigger', via: 'instance.startTracelessVerification' });
                    instanceRef.startTracelessVerification();
                    return;
                  }
                  if (typeof instanceRef?.captcha?.startTracelessVerification === 'function') {
                    events.push({ type: 'trigger', via: 'captcha.startTracelessVerification' });
                    instanceRef.captcha.startTracelessVerification();
                    return;
                  }
                  if (typeof e?.$button?.click === 'function') {
                    events.push({ type: 'trigger', via: '$button.click' });
                    e.$button.click();
                    return;
                  }
                  if (typeof e?.$button?.[0]?.click === 'function') {
                    events.push({ type: 'trigger', via: '$button[0].click' });
                    e.$button[0].click();
                    return;
                  }
                  events.push({ type: 'trigger', via: 'none' });
                } catch (err) {
                  events.push({ type: 'triggerError', error: String(err && err.stack || err) });
                }
              }, options.triggerDelayMs ?? 10);
            },
          };
          if (options.injectCaptchaVerifyCallback !== false) {
            initConfig.captchaVerifyCallback = async (payload, done) => {
              let parsedPayload = payload;
              if (typeof payload === 'string') {
                try {
                  parsedPayload = JSON.parse(payload);
                } catch {
                  parsedPayload = payload;
                }
              }
              const callbackCertifyId =
                parsedPayload?.certifyId ??
                instanceRef?.config?.CertifyId ??
                instanceRef?.config?.certifyId ??
                instanceRef?.config?.UserCertifyId ??
                initConfig?.CertifyId ??
                initConfig?.certifyId ??
                initConfig?.UserCertifyId ??
                liveProbeConfig.certifyId ??
                null;
              const probeToken = async (label, fn) => {
                if (typeof fn !== 'function') return null;
                try {
                  const value = await Promise.resolve(fn());
                  const plain = decodeBase64Utf8(value);
                  return {
                    label,
                    valuePreview: typeof value === 'string' ? value.slice(0, 240) : value,
                    plainPreview: typeof plain === 'string' ? plain.slice(0, 320) : plain,
                  };
                } catch (error) {
                  return { label, error: String(error && error.stack || error) };
                }
              };
              events.push({
                type: 'captchaVerifyCallback',
                payloadKeys: parsedPayload && typeof parsedPayload === 'object' ? Object.keys(parsedPayload).slice(0, 30) : [],
                payload: parsedPayload,
                doneType: typeof done,
                instanceConfigKeys: instanceRef?.config ? Object.keys(instanceRef.config).slice(0, 30) : [],
                captchaConfigKeys: instanceRef?.captcha?.AliyunCaptcha?.config
                  ? Object.keys(instanceRef.captcha.AliyunCaptcha.config).slice(0, 30)
                  : instanceRef?.captcha?.config
                  ? Object.keys(instanceRef.captcha.config).slice(0, 30)
                  : [],
                callbackTokenProbes: [
                  await probeToken('um.getToken()', () => window.um?.getToken?.call(window.um)),
                  await probeToken('z_um.getToken()', () => window.z_um?.getToken?.call(window.z_um)),
                  callbackCertifyId
                    ? await probeToken('um.getToken(certifyId)', () => window.um?.getToken?.call(window.um, callbackCertifyId))
                    : null,
                  callbackCertifyId
                    ? await probeToken('z_um.getToken(certifyId)', () => window.z_um?.getToken?.call(window.z_um, callbackCertifyId))
                    : null,
                ].filter(Boolean),
              });
              return (
                callbackCertifyId
              );
            };
          }
          if (options.autoInitConfig && typeof options.autoInitConfig === 'object') {
            Object.assign(initConfig, options.autoInitConfig);
          }
          if (options.initialAliyunCaptchaConfig && typeof options.initialAliyunCaptchaConfig === 'object') {
            Object.assign(initConfig, options.initialAliyunCaptchaConfig);
          } else if (this.initialAliyunCaptchaConfig && typeof this.initialAliyunCaptchaConfig === 'object') {
            Object.assign(initConfig, this.initialAliyunCaptchaConfig);
          }
          applyAliyunSgRuntimeOverrides(initConfig);
          window.initAliyunCaptcha(initConfig);
        }),
        new Promise((resolve) => setTimeout(resolve, options.timeoutMs ?? 1500)),
      ]);
      this.um = window.um;
      this.refreshExports();
      try {
        await this.computeToken();
      } catch (error) {
        events.push({ type: 'postAutoInit.computeToken.error', error: String(error && error.stack || error) });
      }
      return { ok: true, events };
    } catch (error) {
      events.push({ type: 'throw', error: String(error && error.stack || error) });
      return { ok: false, error: String(error && error.stack || error), events };
    }
  }

  async computeTokenForSession(sessionIdBase64) {
    this.refreshExports();
    const original = this.getSessionId();
    this.setSessionId(sessionIdBase64);
    try {
      return await this.computeToken();
    } finally {
      if (original) this.re.sessionId = original;
    }
  }

  async computeSecondSegmentForSession(sessionIdBase64) {
    const result = await this.computeTokenForSession(sessionIdBase64);
    return result?.parsed?.second || null;
  }

  async computeTokenByDirectRx(sessionIdBase64, tr = 'FqJB6iRNVYdEGpwb') {
    const original = this.getSessionId();
    this.setSessionId(sessionIdBase64);
    try {
      const second = this.rx(tr, sessionIdBase64);
      if (!second) {
        return { second, full: null, verify: null };
      }
      const fifth = computeFifthSegment(second);
      const full = `SG_WEB#${second}##0#${fifth}`;
      return {
        second,
        full,
        verify: verifyTokenPlain(full),
      };
    } finally {
      if (original) this.re.sessionId = original;
    }
  }

  deriveSessionIdBlobForSecond(secondSegment, options = {}) {
    this.refreshExports();
    const sessionSeed =
      options.sessionSeed ||
      this.window.__FEILIN_SESSION_DERIVE_LOGS__?.slice?.(-1)?.[0]?.reSessionPreview ||
      this.window.__FEILIN_SESSION_DERIVE_LOGS__?.slice?.(-1)?.[0]?.reSecretPreview ||
      DEFAULT_FEILIN_RS_SEED;
    const plain = typeof secondSegment === 'string' ? secondSegment : null;
    if (!sessionSeed || !plain) {
      throw new Error('missing sessionSeed or secondSegment');
    }
    let sessionId = null;
    if (typeof this.deriveSessionBlob === 'function') {
      sessionId = this.deriveSessionBlob(sessionSeed, plain);
    } else if (typeof this.rs === 'function') {
      const rsThis = Object.prototype.hasOwnProperty.call(this.window, '__FEILIN_RS_LAST_THIS__')
        ? this.window.__FEILIN_RS_LAST_THIS__
        : undefined;
      sessionId = this.rs.apply(rsThis, [sessionSeed, plain]);
    } else if (typeof this.deriveSecretBlob === 'function') {
      sessionId = this.deriveSecretBlob(sessionSeed, plain);
    } else {
      throw new Error('deriveSessionBlob / rs function unavailable');
    }
    return {
      sessionSeed,
      secondSegment: plain,
      sessionId,
      token: sessionId ? this._normalizeTokenCandidate(Buffer.from(buildFullToken(plain), 'utf8').toString('base64'), 'derived-second') : null,
    };
  }

  bindRa(opcode, thisArg = undefined) {
    if (typeof opcode !== 'number') {
      throw new Error('opcode must be a number');
    }
    return this.ra.bind(thisArg, opcode);
  }

  callRa(opcode, args = [], thisArg = undefined) {
    const fn = this.bindRa(opcode, thisArg);
    return fn.apply(thisArg, Array.isArray(args) ? args : [args]);
  }

  replayRa20(arg0, arg1, thisArg = undefined) {
    return this.callRa(20, [arg0, arg1], thisArg);
  }

  replayRs(arg0, arg1, thisArg = undefined) {
    if (typeof this.rs !== 'function') {
      throw new Error('rS function unavailable');
    }
    const effectiveThis = arguments.length >= 3
      ? thisArg
      : (Object.prototype.hasOwnProperty.call(this.window, '__FEILIN_RS_LAST_THIS__')
        ? this.window.__FEILIN_RS_LAST_THIS__
        : undefined);
    return this.rs.apply(effectiveThis, [arg0, arg1]);
  }

  callNamedFunction(name, args = [], thisArg = this.window) {
    const target = this[name];
    if (typeof target !== 'function') {
      throw new Error(`${name} function unavailable`);
    }
    const argList = Array.isArray(args) ? args : [args];
    return target.apply(thisArg, argList);
  }

  callIo(deviceObject, code = 501, thisArg = this.window) {
    return this.callNamedFunction('io', [deviceObject, code], thisArg);
  }

  callIu(deviceObject, arg1 = null, arg2 = null, arg3 = true, thisArg = this.window) {
    return this.callNamedFunction('iu', [deviceObject, arg1, arg2, arg3], thisArg);
  }

  callUy(thisArg = this.window) {
    return this.callNamedFunction('uY', [], thisArg);
  }

  callSt(thisArg = this.window) {
    return this.callNamedFunction('st', [], thisArg);
  }

  promoteRealGetTokenFromSb() {
    const sb = this.window.__FEILIN_SB__ || this.sb;
    if (typeof sb !== 'function') {
      throw new Error('FEILIN sb export unavailable');
    }
    if (!this.window.um || typeof this.window.um !== 'object') {
      throw new Error('window.um unavailable');
    }
    this.window.um.getToken = sb;
    this.um = this.window.um;
    this.sb = sb;
    return {
      ok: true,
      getTokenSource: String(this.window.um.getToken).slice(0, 300),
    };
  }

  callSe(args = [], thisArg = this.window) {
    const fn = this.window.__FEILIN_SE_FN__ || this.seFn;
    if (typeof fn !== 'function') throw new Error('FEILIN se export unavailable');
    return fn.apply(thisArg, Array.isArray(args) ? args : [args]);
  }

  callSv(args = [], thisArg = this.window) {
    const fn = this.window.__FEILIN_SV_FN__ || this.svFn;
    if (typeof fn !== 'function') throw new Error('FEILIN sv export unavailable');
    return fn.apply(thisArg, Array.isArray(args) ? args : [args]);
  }

  buildMinimalSvInitArg(overrides = {}) {
    const now = Date.now();
    const baseAppKey =
      overrides?.deviceConfig?.key ||
      this.re?.appKey ||
      this.window.__FEILIN_EXPORT_RE__?.appKey ||
      DEFAULT_FEILIN_APP_KEY;
    const baseSessionId =
      overrides?.deviceConfig?.sessionId ||
      `${baseAppKey}-h-${now}-${randomHex(16)}`;
    const base = {
      logs: DEFAULT_SV_LOGS.slice(),
      deviceConfig: {
        key: baseAppKey,
        switch: 513,
        sessionId: baseSessionId,
        version: '3.25.0',
        pluginElements: '',
        pluginResource: '',
        globalVariable: '',
        timestamp: String(now),
        ip: '1.2.3.4',
      },
      captchaVerifyCallback() {},
      onBizResultCallback() {},
      success() {},
      fail() {},
      onError() {},
      onClose() {},
    };
    return mergePlainObjects(base, overrides);
  }

  callSvInit(overrides = {}, thisArg = this.window) {
    const initArg = this.buildMinimalSvInitArg(overrides);
    this.window.__FEILIN_LAST_SV_INIT_ARG__ = initArg;
    const out = this.callSv([initArg], thisArg);
    if (!this.window.__FEILIN_RE__ && this.re) {
      this.window.__FEILIN_RE__ = this.re;
    }
    if (this.window.__FEILIN_EXPORT_RE__ && !this.window.__FEILIN_RE__) {
      this.window.__FEILIN_RE__ = this.window.__FEILIN_EXPORT_RE__;
    }
    if (this.window.__FEILIN_EXPORT_RE__ && typeof this.window.__FEILIN_EXPORT_RE__ === 'object') {
      this.re = this.window.__FEILIN_EXPORT_RE__;
    }
    return out;
  }

  getWarmupFunctionSnapshot() {
    return {
      io: typeof this.io,
      iu: typeof this.iu,
      ub: typeof this.ub,
      uY: typeof this.uY,
      st: typeof this.st,
      sb: typeof this.sb,
      seFn: typeof this.seFn,
      svFn: typeof this.svFn,
    };
  }

  getWindowObjectTraceSnapshot(name = 'um') {
    if (name === 'um' && this.umTrace?.snapshot) return this.umTrace.snapshot();
    if (name === 'z_um' && this.zUmTrace?.snapshot) return this.zUmTrace.snapshot();
    return null;
  }

  snapshotInterestingState() {
    const window = this.window;
    const pickShape = (value) => {
      if (!value || typeof value !== 'object') return null;
      const keys = Reflect.ownKeys(value).map(String).slice(0, 30);
      const preview = {};
      for (const key of keys.slice(0, 12)) {
        try {
          const current = value[key];
          preview[key] = typeof current === 'function'
            ? { type: 'function', source: String(current).slice(0, 200) }
            : { type: typeof current, value: current == null ? current : String(current).slice(0, 200) };
        } catch (error) {
          preview[key] = { error: String(error && error.stack || error) };
        }
      }
      return { keys, preview };
    };
    return {
      umTrace: this.getWindowObjectTraceSnapshot('um'),
      zUmTrace: this.getWindowObjectTraceSnapshot('z_um'),
      runtimeDeviceToken: this.getRuntimeDeviceToken(),
      preferredDeviceToken: this.getPreferredDeviceToken(),
      browserLikeInitDeviceToken: this.getBrowserLikeInitDeviceToken(),
      umShape: pickShape(window.um),
      zUmShape: pickShape(window.z_um),
      aliyunInitState: pickShape(window.__ALIYUN_INIT_STATE__),
      aliyunPrecollect: pickShape(window.__ALIYUN_PRECOLLECT_SNAPSHOT__),
      feilinRe: pickShape(window.__FEILIN_RE__),
      feilinLastSvInitArg: pickShape(window.__FEILIN_LAST_SV_INIT_ARG__),
      localStorageKeys: typeof window.localStorage?.length === 'number'
        ? Array.from({ length: Math.min(window.localStorage.length, 20) }, (_, idx) => {
          try { return window.localStorage.key(idx); } catch { return null; }
        })
        : [],
    };
  }

  runWarmupSequence(steps = [], options = {}) {
    const sequence = Array.isArray(steps) ? steps : [];
    const defaultThisArg = Object.prototype.hasOwnProperty.call(options, 'thisArg') ? options.thisArg : this.window;
    const outputs = [];
    for (const rawStep of sequence) {
      const step = typeof rawStep === 'string' ? { name: rawStep } : { ...(rawStep || {}) };
      const name = step.name || 'unknown';
      const args = Array.isArray(step.args) ? step.args : [];
      const thisArg = Object.prototype.hasOwnProperty.call(step, 'thisArg') ? step.thisArg : defaultThisArg;
      try {
        const value = name === 'svInit'
          ? this.callSvInit(args[0] || {}, thisArg)
          : this.callNamedFunction(name, args, thisArg);
        outputs.push({
          name,
          ok: true,
          valueType: typeof value,
          valuePreview: typeof value === 'string' ? value.slice(0, 400) : null,
        });
      } catch (error) {
        outputs.push({
          name,
          ok: false,
          error: String(error && error.stack || error),
        });
      }
    }
    return outputs;
  }

  debugReplayRs(arg0, arg1, thisArg = undefined) {
    const selectorStart = Array.isArray(this.window.__FEILIN_RS_SELECTOR_LOGS__)
      ? this.window.__FEILIN_RS_SELECTOR_LOGS__.length
      : 0;
    const rsStart = Array.isArray(this.window.__FEILIN_RS_LOGS__)
      ? this.window.__FEILIN_RS_LOGS__.length
      : 0;
    const innerStart = Array.isArray(this.window.__FEILIN_RS_INNER_LOGS__)
      ? this.window.__FEILIN_RS_INNER_LOGS__.length
      : 0;
    const cryptoStart = Array.isArray(this.window.__CRYPTO_TRACE_LOGS__)
      ? this.window.__CRYPTO_TRACE_LOGS__.length
      : 0;
    const raStart = Array.isArray(this.window.__FEILIN_RA20_LOGS__)
      ? this.window.__FEILIN_RA20_LOGS__.length
      : 0;
    const output = this.replayRa20(arg0, arg1, thisArg);
    return {
      output,
      selectorLogs: (this.window.__FEILIN_RS_SELECTOR_LOGS__ || []).slice(selectorStart),
      rsLogs: (this.window.__FEILIN_RS_LOGS__ || []).slice(rsStart),
      innerLogs: (this.window.__FEILIN_RS_INNER_LOGS__ || []).slice(innerStart),
      cryptoTraceLogs: (this.window.__CRYPTO_TRACE_LOGS__ || []).slice(cryptoStart),
      raTraceLogs: (this.window.__FEILIN_RA20_LOGS__ || []).slice(raStart),
    };
  }

  computeThirdSegment(arg0, arg1, thisArg = undefined) {
    if (typeof arg0 !== 'string' || !arg0) {
      throw new Error('arg0 must be a non-empty string');
    }
    if (typeof arg1 !== 'string' || !arg1) {
      throw new Error('arg1 must be a non-empty string');
    }
    const output = this.replayRs(arg0, arg1, thisArg);
    let outputString = null;
    try {
      outputString = typeof output === 'string' ? output : String(output);
    } catch {
      outputString = null;
    }
    return {
      arg0,
      arg0Length: arg0.length,
      arg1Length: arg1.length,
      output,
      outputType: typeof output,
      outputString,
      ok: typeof outputString === 'string' && outputString !== 'null',
    };
  }

  computeThirdSegmentViaRs(arg0, arg1, thisArg = undefined) {
    if (typeof arg0 !== 'string' || !arg0) {
      throw new Error('arg0 must be a non-empty string');
    }
    if (typeof arg1 !== 'string' || !arg1) {
      throw new Error('arg1 must be a non-empty string');
    }
    const output = this.replayRs(arg0, arg1, thisArg);
    let outputString = null;
    try {
      outputString = typeof output === 'string' ? output : String(output);
    } catch {
      outputString = null;
    }
    return {
      arg0,
      arg0Length: arg0.length,
      arg1Length: arg1.length,
      output,
      outputType: typeof output,
      outputString,
      ok: typeof outputString === 'string' && outputString !== 'null',
    };
  }

  computeThirdSegmentDebug(arg0, arg1, thisArg = undefined) {
    if (typeof arg0 !== 'string' || !arg0) {
      throw new Error('arg0 must be a non-empty string');
    }
    if (typeof arg1 !== 'string' || !arg1) {
      throw new Error('arg1 must be a non-empty string');
    }
    const debug = this.debugReplayRs(arg0, arg1, thisArg);
    let outputString = null;
    try {
      outputString = typeof debug.output === 'string' ? debug.output : String(debug.output);
    } catch {
      outputString = null;
    }
    return {
      arg0,
      arg0Length: arg0.length,
      arg1Length: arg1.length,
      output: debug.output,
      outputType: typeof debug.output,
      outputString,
      ok: typeof outputString === 'string' && outputString !== 'null',
      selectorLogs: debug.selectorLogs,
      rsLogs: debug.rsLogs,
      innerLogs: debug.innerLogs,
      cryptoTraceLogs: debug.cryptoTraceLogs,
      raTraceLogs: debug.raTraceLogs,
    };
  }

  computeThirdSegmentFromVector(vector, options = {}) {
    const arg0 = options.arg0 || vector?.xPrefix || null;
    const arg1 = options.arg1 || buildTokenLPreviewFromVector(vector, options.patch || {});
    const mode = options.mode || 'ra20';
    return {
      arg0,
      arg1,
      arg1Length: typeof arg1 === 'string' ? arg1.length : null,
      replay: mode === 'rs'
        ? this.computeThirdSegmentViaRs(arg0, arg1, options.thisArg)
        : this.computeThirdSegment(arg0, arg1, options.thisArg),
    };
  }

  computeTokenFromVector(vector, options = {}) {
    const second = options.second || vector?.second || null;
    if (typeof second !== 'string' || !second) {
      throw new Error('vector.second must be a non-empty string');
    }
    const third = this.computeThirdSegmentFromVector(vector, options).replay;
    const fifth = computeFifthSegment(second);
    const full = `SG_WEB#${second}#${third.outputString || ''}#0#${fifth}`;
    return {
      second,
      third: third.outputString || null,
      fifth,
      full,
      verify: verifyTokenPlain(full),
      thirdReplay: third,
    };
  }

  inspectRaBinding(opcode, thisArg = undefined) {
    const bound = this.bindRa(opcode, thisArg);
    return {
      opcode,
      raName: this.ra && this.ra.name ? this.ra.name : null,
      raLength: this.ra && typeof this.ra.length === 'number' ? this.ra.length : null,
      raSource: typeof this.ra === 'function' ? String(this.ra).slice(0, 400) : null,
      boundType: typeof bound,
      boundName: bound && bound.name ? bound.name : null,
      boundLength: bound && typeof bound.length === 'number' ? bound.length : null,
      boundSource: typeof bound === 'function' ? String(bound).slice(0, 400) : null,
    };
  }
}

async function main() {
  const [, , sessionIdBase64] = process.argv;
  if (!sessionIdBase64) {
    console.error('usage: feilin_vm_runtime.js <sessionIdBase64>');
    process.exit(1);
  }
  const runtime = await FeilinVmRuntime.create();
  const token = await runtime.computeTokenForSession(sessionIdBase64);
  const direct = await runtime.computeTokenByDirectRx(sessionIdBase64);
  console.log(JSON.stringify({
    token,
    direct,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
} else {
  module.exports = {
    FeilinVmRuntime,
    applyAliyunSgRuntimeOverrides,
    decodeBase64Utf8,
    normalizeAliyunRuntimeState,
    patchFeilinForExports,
  };
}
