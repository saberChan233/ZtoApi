#!/usr/bin/env node

const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

const DEFAULT_FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];
const DEFAULT_LOADER = '/tmp/AliyunCaptcha.js';

const baseMouseSeq = [
  { type: 'mousemove', clientX: 10, clientY: 10 },
  { type: 'mousemove', clientX: 20, clientY: 14 },
  { type: 'mousemove', clientX: 32, clientY: 18 },
  { type: 'mousedown', clientX: 35, clientY: 20, buttons: 1 },
  { type: 'mousemove', clientX: 60, clientY: 22, buttons: 1 },
  { type: 'mousemove', clientX: 90, clientY: 24, buttons: 1 },
  { type: 'mouseup', clientX: 95, clientY: 25, buttons: 0 },
  { type: 'mousemove', clientX: 120, clientY: 40 },
  { type: 'mousemove', clientX: 160, clientY: 55 },
  { type: 'mousemove', clientX: 200, clientY: 70 },
];

const basePointerSeq = [
  { type: 'pointermove', clientX: 10, clientY: 10, pointerType: 'mouse', buttons: 0 },
  { type: 'pointermove', clientX: 20, clientY: 14, pointerType: 'mouse', buttons: 0 },
  { type: 'pointerdown', clientX: 35, clientY: 20, pointerType: 'mouse', buttons: 1, pressure: 0.5 },
  { type: 'pointermove', clientX: 60, clientY: 22, pointerType: 'mouse', buttons: 1, pressure: 0.5 },
  { type: 'pointermove', clientX: 90, clientY: 24, pointerType: 'mouse', buttons: 1, pressure: 0.5 },
  { type: 'pointerup', clientX: 95, clientY: 25, pointerType: 'mouse', buttons: 0, pressure: 0 },
];

const keySeq = [
  { type: 'keydown', key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16, target: 'window' },
  { type: 'keyup', key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16, target: 'window' },
  { type: 'keydown', key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, target: 'window' },
  { type: 'keyup', key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, target: 'window' },
];

function parseArgs(argv = process.argv.slice(2)) {
  const onlyRaw = getArg(argv, '--only', '');
  const limitRaw = getArg(argv, '--limit', '');
  return {
    only: onlyRaw
      ? new Set(onlyRaw.split(',').map((item) => item.trim()).filter(Boolean))
      : null,
    limit: limitRaw ? Number(limitRaw) : null,
  };
}

function getArg(argv, name, fallback = null) {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  return argv[idx + 1] ?? fallback;
}

function buildVariants() {
  return [
    {
      name: 'baseline',
      options: {},
    },
    {
      name: 'normalize-verify-token',
      options: { normalizeVerifyToken: true },
    },
    {
      name: 'force-callback-mode',
      options: { forceCallbackMode: true },
    },
    {
      name: 'no-global-config',
      options: { setGlobalConfig: false },
    },
    {
      name: 'no-live-init',
      options: { executeLiveInit: false },
    },
    {
      name: 'doc-mouse-plus-keys',
      options: { syntheticEvents: [...baseMouseSeq, ...keySeq] },
    },
    {
      name: 'doc-pointer-plus-keys',
      options: { syntheticEvents: [...basePointerSeq, ...keySeq] },
    },
    {
      name: 'storage-cookie-seeded',
      options: {
        localStorageSeed: {
          UM_distinctid: 'probe-um-local-storage',
          captcha_probe_device_id: 'probe-device-id',
        },
        sessionStorageSeed: {
          captcha_probe_session_id: 'probe-session-id',
        },
        cookieSeed: {
          UM_distinctid: 'probe-um-cookie',
          captcha_probe_cookie: 'probe-cookie',
        },
        documentCookie: 'captcha_probe_cookie=probe-cookie; UM_distinctid=probe-um-cookie',
      },
    },
    {
      name: 'browser-env-overrides',
      options: {
        locationHref: 'https://chat.z.ai/',
        referrer: 'https://chat.z.ai/',
        navigatorOverrides: {
          language: 'en-US',
          languages: ['en-US', 'en'],
          platform: 'Win32',
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          webdriver: false,
          hardwareConcurrency: 8,
          deviceMemory: 8,
        },
        screenOverrides: {
          width: 1920,
          height: 1080,
          availWidth: 1920,
          availHeight: 1040,
          colorDepth: 24,
          pixelDepth: 24,
        },
        windowOverrides: {
          innerWidth: 1440,
          innerHeight: 900,
          outerWidth: 1440,
          outerHeight: 980,
          devicePixelRatio: 1,
        },
      },
    },
    {
      name: 'no-synthetic-log1-device-config',
      options: {
        syntheticLog1DeviceConfig: null,
      },
    },
    {
      name: 'io-mutation',
      options: { ioMutationExperiment: true },
    },
    {
      name: 'iu-mutation',
      options: { iuMutationExperiment: true },
    },
    {
      name: 'manual-token',
      options: { manualTokenExperiment: true },
    },
    {
      name: 're-mutation',
      options: { reMutationExperiment: true },
    },
    {
      name: 'sessionid-blob',
      options: { sessionIdBlobExperiment: true },
    },
    {
      name: 'combined-hardening',
      options: {
        normalizeVerifyToken: true,
        syntheticEvents: [...basePointerSeq, ...baseMouseSeq.slice(3, 7), ...keySeq],
        localStorageSeed: {
          UM_distinctid: 'probe-um-combined',
          captcha_probe_device_id: 'probe-device-id-combined',
        },
        sessionStorageSeed: {
          captcha_probe_session_id: 'probe-session-id-combined',
        },
        cookieSeed: {
          captcha_probe_cookie: 'probe-cookie-combined',
        },
        documentCookie: 'captcha_probe_cookie=probe-cookie-combined',
        locationHref: 'https://chat.z.ai/',
        referrer: 'https://chat.z.ai/',
        navigatorOverrides: {
          language: 'en-US',
          languages: ['en-US', 'en'],
          platform: 'Win32',
          webdriver: false,
        },
        screenOverrides: {
          width: 1920,
          height: 1080,
          availWidth: 1920,
          availHeight: 1040,
          colorDepth: 24,
          pixelDepth: 24,
        },
      },
    },
  ];
}

function summarizeResult(name, startedAt, out, options) {
  return {
    name,
    durationMs: Date.now() - startedAt,
    optionsSummary: {
      normalizeVerifyToken: !!options.normalizeVerifyToken,
      forceCallbackMode: !!options.forceCallbackMode,
      setGlobalConfig: options.setGlobalConfig !== false,
      executeLiveInit: options.executeLiveInit !== false,
      syntheticEventsCount: Array.isArray(options.syntheticEvents) ? options.syntheticEvents.length : 0,
      hasDocumentCookie: !!options.documentCookie,
      hasLocalStorageSeed: !!options.localStorageSeed,
      hasSessionStorageSeed: !!options.sessionStorageSeed,
      hasCookieSeed: !!options.cookieSeed,
      hasNavigatorOverrides: !!options.navigatorOverrides,
      hasScreenOverrides: !!options.screenOverrides,
      hasWindowOverrides: !!options.windowOverrides,
      ioMutationExperiment: !!options.ioMutationExperiment,
      iuMutationExperiment: !!options.iuMutationExperiment,
      manualTokenExperiment: !!options.manualTokenExperiment,
      reMutationExperiment: !!options.reMutationExperiment,
      sessionIdBlobExperiment: !!options.sessionIdBlobExperiment,
      hasSyntheticLog1DeviceConfig: options.syntheticLog1DeviceConfig !== null,
    },
    init: {
      status: out?.liveInit?.status ?? null,
      code: out?.liveInit?.bodyJson?.Code ?? null,
      certifyId: out?.liveInit?.bodyJson?.CertifyId ?? null,
    },
    verify: {
      status: out?.liveVerify?.status ?? null,
      code: out?.liveVerify?.bodyJson?.Code ?? null,
      verifyCode: out?.liveVerify?.bodyJson?.Result?.VerifyCode ?? null,
      verifyResult: out?.liveVerify?.bodyJson?.Result?.VerifyResult ?? null,
      hasSecurityToken: !!out?.liveVerify?.bodyJson?.Result?.securityToken,
      securityTokenPreview: out?.liveVerify?.bodyJson?.Result?.securityToken
        ? String(out.liveVerify.bodyJson.Result.securityToken).slice(0, 48)
        : null,
    },
    payload: {
      hasSynthesizedFromLiveVerify: !!out?.synthesizedFromLiveVerify?.captcha_verify_param,
      hasSynthesizedFromSecurityToken: !!out?.synthesizedFromSecurityToken?.captcha_verify_param,
      successPayload: !!out?.successPayload?.captcha_verify_param,
    },
    runtime: {
      deviceTokenPreview: out?.deviceTokenPreview ? String(out.deviceTokenPreview).slice(0, 96) : null,
      normalizedVerifyTokenPreview: out?.normalizedVerifyTokenPreview
        ? String(out.normalizedVerifyTokenPreview).slice(0, 96)
        : null,
      umSeedPreview: out?.btoaInteresting?.umSeedPreview
        ? String(out.btoaInteresting.umSeedPreview).slice(0, 96)
        : null,
      initTokenPlainPreview: out?.btoaInteresting?.initTokenPlainPreview
        ? String(out.btoaInteresting.initTokenPlainPreview).slice(0, 96)
        : null,
      verifyTokenPlainPreview: out?.btoaInteresting?.verifyTokenPlainPreview
        ? String(out.btoaInteresting.verifyTokenPlainPreview).slice(0, 96)
        : null,
      xhrActions: Array.isArray(out?.xhrActions) ? out.xhrActions : [],
      asyncErrors: Array.isArray(out?.asyncErrors) ? out.asyncErrors.slice(0, 3) : [],
      localStorageKeys: out?.localStorageSnapshot ? Object.keys(out.localStorageSnapshot) : [],
      sessionStorageKeys: out?.sessionStorageSnapshot ? Object.keys(out.sessionStorageSnapshot) : [],
      documentCookie: out?.documentCookie || null,
    },
    replaySeed: {
      hasCompact: !!out?.localReplayCompactSeed,
      hasLive: !!out?.localReplayLiveSeed,
      hasMinimal: !!out?.localReplayMinimalLiveSeed,
      hasUltraMinimal: !!out?.localReplayUltraMinimalLiveSeed,
      compactBytes: out?.localReplayCompactSeed
        ? Buffer.byteLength(JSON.stringify(out.localReplayCompactSeed), 'utf8')
        : 0,
      liveBytes: out?.localReplayLiveSeed
        ? Buffer.byteLength(JSON.stringify(out.localReplayLiveSeed), 'utf8')
        : 0,
      minimalBytes: out?.localReplayMinimalLiveSeed
        ? Buffer.byteLength(JSON.stringify(out.localReplayMinimalLiveSeed), 'utf8')
        : 0,
      ultraMinimalBytes: out?.localReplayUltraMinimalLiveSeed
        ? Buffer.byteLength(JSON.stringify(out.localReplayUltraMinimalLiveSeed), 'utf8')
        : 0,
    },
  };
}

async function runVariant(variant) {
  const startedAt = Date.now();
  const options = {
    files: DEFAULT_FILES,
    loaderPath: DEFAULT_LOADER,
    executeLive: true,
    ...variant.options,
  };
  try {
    const out = await solveCaptcha(options);
    return summarizeResult(variant.name, startedAt, out, options);
  } catch (error) {
    return {
      name: variant.name,
      durationMs: Date.now() - startedAt,
      error: String(error && error.stack || error),
      optionsSummary: {
        normalizeVerifyToken: !!options.normalizeVerifyToken,
        forceCallbackMode: !!options.forceCallbackMode,
        setGlobalConfig: options.setGlobalConfig !== false,
        executeLiveInit: options.executeLiveInit !== false,
      },
    };
  }
}

async function main() {
  const args = parseArgs();
  let variants = buildVariants();
  if (args.only && args.only.size > 0) {
    variants = variants.filter((variant) => args.only.has(variant.name));
  }
  if (Number.isFinite(args.limit) && args.limit > 0) {
    variants = variants.slice(0, args.limit);
  }
  const rows = [];
  for (const variant of variants) {
    rows.push(await runVariant(variant));
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    variantCount: rows.length,
    rows,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
