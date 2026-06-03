#!/usr/bin/env node
const fs = require('fs');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');
const { buildLatestBrowserProfile } = require('./browserless_aliyun_captcha_solver');
const { buildRuntimeSeed, executeFormRequest, refreshSignedCaptchaParams } = require('./aliyun_light_rolling_chain');
const { ensureAliyunBundleFiles } = require('./aliyun_bundle_bootstrap');

function hasFlag(name) {
  return process.argv.includes(name);
}

function parseOutputPath() {
  const idx = process.argv.indexOf('--out');
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function buildStage2Patches() {
  return [
    {
      match: 'x.V=function(t,n){return t(n)}',
      replace: 'x.V=function(t,n){var __ret=x.V.__raw?x.V.__raw(t,n):t(n);window.__X_V_CALL_LOGS__=window.__X_V_CALL_LOGS__||[],window.__X_V_CALL_LOGS__.push({fnName:t&&t.name||null,fnSource:typeof t==="function"?String(t).slice(0,280):null,argPreview:typeof n==="string"?n.slice(0,280):n&&typeof n==="object"?Object.keys(n).slice(0,20):n,resultPreview:typeof __ret==="string"?__ret.slice(0,320):__ret&&typeof __ret==="object"?Object.keys(__ret).slice(0,20):__ret,stack:String((new Error("X_V_CALL")).stack||"").slice(0,1200)}),window.__X_V_CALL_LOGS__.length>500&&window.__X_V_CALL_LOGS__.shift();return __ret},x.V.__raw=function(t,n){return t(n)}',
    },
    {
      match: 'x.s=function(t,n,e){return t(n,e)}',
      replace: 'x.s=function(t,n,e){var __ret=t(n,e);if((typeof __ret==="string"&&(__ret.indexOf("SG_WEB")>=0||__ret.length>=120))||(typeof n==="string"&&n.indexOf("SG_WEB")>=0)||(typeof e==="string"&&e.indexOf("SG_WEB")>=0)){window.__X_S_CALL_LOGS__=window.__X_S_CALL_LOGS__||[],window.__X_S_CALL_LOGS__.push({fnName:t&&t.name||null,fnSource:typeof t==="function"?String(t).slice(0,280):null,arg0Preview:typeof n==="string"?n.slice(0,280):n&&typeof n==="object"?Object.keys(n).slice(0,20):n,arg1Preview:typeof e==="string"?e.slice(0,280):e&&typeof e==="object"?Object.keys(e).slice(0,20):e,resultPreview:typeof __ret==="string"?__ret.slice(0,420):__ret,stack:String((new Error("X_S_CALL")).stack||"").slice(0,1200)}),window.__X_S_CALL_LOGS__.length>120&&window.__X_S_CALL_LOGS__.shift()}return __ret}',
    },
    {
      match: 'x.d=function(t){return t()}',
      replace: 'x.d=function(t){var __ret=t();if(typeof __ret==="string"&&(__ret.indexOf("SG_WEB")>=0||__ret.length>=120)){window.__X_D_CALL_LOGS__=window.__X_D_CALL_LOGS__||[],window.__X_D_CALL_LOGS__.push({fnName:t&&t.name||null,fnSource:typeof t==="function"?String(t).slice(0,280):null,resultPreview:__ret.slice(0,420),stack:String((new Error("X_D_CALL")).stack||"").slice(0,1200)}),window.__X_D_CALL_LOGS__.length>120&&window.__X_D_CALL_LOGS__.shift()}return __ret}',
    },
    {
      match: 'x.M=function(t,n,e,r,i){return t(n,e,r,i)}',
      replace: 'x.M=function(t,n,e,r,i){var __ret=t(n,e,r,i);if((typeof __ret==="string"&&(__ret.indexOf("SG_WEB")>=0||__ret.length>=120))||(typeof n==="string"&&n.indexOf("SG_WEB")>=0)||(typeof e==="string"&&e.indexOf("SG_WEB")>=0)||(typeof r==="string"&&r.indexOf("SG_WEB")>=0)||(typeof i==="string"&&i.indexOf("SG_WEB")>=0)){window.__X_M_CALL_LOGS__=window.__X_M_CALL_LOGS__||[],window.__X_M_CALL_LOGS__.push({fnName:t&&t.name||null,fnSource:typeof t==="function"?String(t).slice(0,280):null,argsPreview:[n,e,r,i].map(function(v){return typeof v==="string"?v.slice(0,220):v&&typeof v==="object"?Object.keys(v).slice(0,20):v}),resultPreview:typeof __ret==="string"?__ret.slice(0,420):__ret,stack:String((new Error("X_M_CALL")).stack||"").slice(0,1200)}),window.__X_M_CALL_LOGS__.length>120&&window.__X_M_CALL_LOGS__.shift()}return __ret}',
    },
    {
      match: 'y=function(t){er._extend(kn({},t)),Dn({SceneId:o,DeviceToken:er.DeviceToken},er,n,c,p,d)}',
      replace: 'y=function(t){window.__STAGE2_DN_FLOW_LOGS__=window.__STAGE2_DN_FLOW_LOGS__||[],window.__STAGE2_DN_FLOW_LOGS__.push({stage:"reinit-before-extend",sceneId:o||null,inputKeys:t&&typeof t==="object"?Object.keys(t).slice(0,20):null,erCertifyId:er.CertifyId||er.certifyId||er.UserCertifyId||null,erDeviceToken:typeof er.DeviceToken==="string"?er.DeviceToken.slice(0,240):er.DeviceToken}),window.__STAGE2_DN_FLOW_LOGS__.length>200&&window.__STAGE2_DN_FLOW_LOGS__.shift(),er._extend(kn({},t)),window.__STAGE2_DN_FLOW_LOGS__.push({stage:"reinit-before-dn",sceneId:o||null,erCertifyId:er.CertifyId||er.certifyId||er.UserCertifyId||null,erDeviceToken:typeof er.DeviceToken==="string"?er.DeviceToken.slice(0,240):er.DeviceToken}),window.__STAGE2_DN_FLOW_LOGS__.length>200&&window.__STAGE2_DN_FLOW_LOGS__.shift(),Dn({SceneId:o,DeviceToken:er.DeviceToken},er,n,c,p,d)}',
    },
    {
      match: 'er._extend({reInitCaptcha:y}),r.next=1,Dn({SceneId:o},er,n,c,p,d);',
      replace: 'er._extend({reInitCaptcha:y}),window.__STAGE2_DN_FLOW_LOGS__=window.__STAGE2_DN_FLOW_LOGS__||[],window.__STAGE2_DN_FLOW_LOGS__.push({stage:"initial-before-dn",sceneId:o||null,erCertifyId:er.CertifyId||er.certifyId||er.UserCertifyId||null,erDeviceToken:typeof er.DeviceToken==="string"?er.DeviceToken.slice(0,240):er.DeviceToken}),window.__STAGE2_DN_FLOW_LOGS__.length>200&&window.__STAGE2_DN_FLOW_LOGS__.shift(),r.next=1,Dn({SceneId:o},er,n,c,p,d);',
    },
    {
      match: 'return f&&l&&(t.CertifyId=f),p&&(o?t.UserCertifyId=p:t.UserCheckString=p),De._extend({_prefix:y}),{action:d,_prefix:y}}',
      replace: 'return window.__STAGE2_INIT_STATE_LOGS__=window.__STAGE2_INIT_STATE_LOGS__||[],window.__STAGE2_INIT_STATE_LOGS__.push({stage:"rn-before-return",sceneId:t.SceneId||null,certifyId:t.CertifyId||null,userCertifyId:t.UserCertifyId||null,deviceToken:typeof t.DeviceToken==="string"?t.DeviceToken.slice(0,240):t.DeviceToken,isFromTraceless:!!l,configCertifyId:f||null}),window.__STAGE2_INIT_STATE_LOGS__.length>160&&window.__STAGE2_INIT_STATE_LOGS__.shift(),f&&l&&(t.CertifyId=f),p&&(o?t.UserCertifyId=p:t.UserCheckString=p),De._extend({_prefix:y}),{action:d,_prefix:y}}',
    },
    {
      match: 'c={sceneId:n,certifyId:i,deviceToken:o||yr(),failover:"T"},u=M()(e),ln!==u&&(c.err=e,ln=u),!r.captchaVerifyCallback||"function"!=typeof r.captchaVerifyCallback){t.next=3;break}return t.next=1,r.captchaVerifyCallback(M()(c),hn.bind(r));',
      replace: 'c={sceneId:n,certifyId:i,deviceToken:o||yr(),failover:"T"},window.__STAGE2_CALLBACK_FLOW_LOGS__=window.__STAGE2_CALLBACK_FLOW_LOGS__||[],window.__STAGE2_CALLBACK_FLOW_LOGS__.push({stage:"pn-before-callback",sceneId:n||null,certifyId:i||null,sourceDeviceTokenPreview:typeof o==="string"?o.slice(0,240):o,generatedDeviceTokenPreview:typeof c.deviceToken==="string"?c.deviceToken.slice(0,320):c.deviceToken,hasCallback:!!r.captchaVerifyCallback}),u=M()(e),ln!==u&&(c.err=e,ln=u),!r.captchaVerifyCallback||"function"!=typeof r.captchaVerifyCallback){t.next=3;break}return t.next=1,r.captchaVerifyCallback(M()(c),hn.bind(r));',
    },
    {
      match: 'if(null!=(a=t.sent)&&"string"==typeof a)return t.abrupt("return",a);',
      replace: 'if(window.__STAGE2_CALLBACK_FLOW_LOGS__=window.__STAGE2_CALLBACK_FLOW_LOGS__||[],window.__STAGE2_CALLBACK_FLOW_LOGS__.push({stage:"pn-after-callback",callbackResultType:typeof(a=t.sent),callbackResultPreview:typeof a==="string"?a.slice(0,400):a}),window.__STAGE2_CALLBACK_FLOW_LOGS__.length>160&&window.__STAGE2_CALLBACK_FLOW_LOGS__.shift(),null!=(a)&&"string"==typeof a)return t.abrupt("return",a);',
    },
    {
      match: 'case 1:!(m=t.sent).Success||m.LimitFlow||m.LimitedFlowToken?(m.LimitedFlowToken?m.CertifyId=m.LimitedFlowToken:m.CertifyId||(m.CertifyId=dr().substring(0,5)),xr("cId",m.CertifyId),n(Ee.ACTION_STATE.FAIL,m)):(e._extend({log:on}),xr("cId",m.CertifyId),!e.isFromTraceless&&De._extend({initialRequestTime:Date.now(),overTime:!1}),m.DeviceConfig&&void 0===Ie.DeviceConfig&&Ie._extend({DeviceConfig:m.DeviceConfig}),en(m.DeviceConfig,y,u,"captcha"),x=be(m,e),n(Ee.ACTION_STATE.SUCCESS,x));',
      replace: 'case 1:window.__STAGE2_INIT_STATE_LOGS__=window.__STAGE2_INIT_STATE_LOGS__||[],window.__STAGE2_INIT_STATE_LOGS__.push({stage:"init-response",success:!!(m=t.sent).Success,limitFlow:!!m.LimitFlow,limitedFlowToken:m.LimitedFlowToken||null,certifyId:m.CertifyId||null,deviceConfigPreview:typeof m.DeviceConfig==="string"?m.DeviceConfig.slice(0,280):m.DeviceConfig,isFromTraceless:!!e.isFromTraceless,runtimeDeviceConfigPresent:void 0!==Ie.DeviceConfig}),window.__STAGE2_INIT_STATE_LOGS__.length>160&&window.__STAGE2_INIT_STATE_LOGS__.shift(),!m.Success||m.LimitFlow||m.LimitedFlowToken?(m.LimitedFlowToken?m.CertifyId=m.LimitedFlowToken:m.CertifyId||(m.CertifyId=dr().substring(0,5)),xr("cId",m.CertifyId),n(Ee.ACTION_STATE.FAIL,m)):(e._extend({log:on}),xr("cId",m.CertifyId),!e.isFromTraceless&&De._extend({initialRequestTime:Date.now(),overTime:!1}),m.DeviceConfig&&void 0===Ie.DeviceConfig&&Ie._extend({DeviceConfig:m.DeviceConfig}),window.__STAGE2_INIT_STATE_LOGS__.push({stage:"init-success-commit",certifyId:m.CertifyId||null,deviceConfigPreview:typeof m.DeviceConfig==="string"?m.DeviceConfig.slice(0,280):m.DeviceConfig,runtimeDeviceConfigPresent:void 0!==Ie.DeviceConfig}),window.__STAGE2_INIT_STATE_LOGS__.length>160&&window.__STAGE2_INIT_STATE_LOGS__.shift(),en(m.DeviceConfig,y,u,"captcha"),x=be(m,e),n(Ee.ACTION_STATE.SUCCESS,x));',
    },
  ];
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
    responseVerifyCode: entry.responseJson?.Result?.VerifyCode || null,
    responseVerifyResult: entry.responseJson?.Result?.VerifyResult ?? null,
    tokenPrefix: parts[0] || null,
    secondLen: (parts[1] || '').length || null,
    thirdLen: (parts[2] || '').length || null,
    fourth: parts[3] || null,
    dataLen: typeof payload?.data === 'string' ? payload.data.length : null,
    tokenPreview: plain ? plain.slice(0, 220) : null,
    dataPreview: typeof payload?.data === 'string' ? payload.data.slice(0, 140) : null,
    stackPreview: typeof entry.stack === 'string' ? entry.stack.slice(0, 1200) : null,
  };
}

function tail(rows, n = 12) {
  return Array.isArray(rows) ? rows.slice(-n) : [];
}

function installRuntimeHooks(runtime) {
  const window = runtime.window;
  window.__TOKEN_CALL_LOGS__ = [];
  const wrapGetToken = (holderName) => {
    const holder = window[holderName];
    if (!holder || typeof holder.getToken !== 'function' || holder.getToken.__liveWrapped) return;
    const raw = holder.getToken;
    holder.getToken = function (...args) {
      let value = null;
      let error = null;
      try {
        value = raw.apply(this, args);
        return value;
      } catch (err) {
        error = String(err && err.stack || err);
        throw err;
      } finally {
        let plain = null;
        try {
          plain = typeof value === 'string' ? Buffer.from(value, 'base64').toString('utf8') : null;
        } catch {
          plain = null;
        }
        window.__TOKEN_CALL_LOGS__.push({
          holder: holderName,
          args,
          valuePreview: typeof value === 'string' ? value.slice(0, 240) : value,
          plainPreview: typeof plain === 'string' ? plain.slice(0, 320) : plain,
          error,
          stack: String(new Error(`${holderName}.getToken`).stack || '').slice(0, 1200),
        });
        if (window.__TOKEN_CALL_LOGS__.length > 80) {
          window.__TOKEN_CALL_LOGS__.shift();
        }
      }
    };
    holder.getToken.__liveWrapped = true;
  };
  wrapGetToken('um');
  wrapGetToken('z_um');
  const rawBtoa = typeof window.btoa === 'function' ? window.btoa.bind(window) : null;
  if (rawBtoa && !window.btoa.__liveWrapped) {
    window.__TOKEN_BTOA_LOGS__ = [];
    const wrapped = function (value) {
      const out = rawBtoa(value);
      if (typeof value === 'string' && value.includes('SG_WEB')) {
        window.__TOKEN_BTOA_LOGS__.push({
          inputPreview: value.slice(0, 320),
          outputPreview: typeof out === 'string' ? out.slice(0, 240) : out,
          stack: String(new Error('btoa-SG_WEB').stack || '').slice(0, 1200),
        });
        if (window.__TOKEN_BTOA_LOGS__.length > 80) {
          window.__TOKEN_BTOA_LOGS__.shift();
        }
      }
      return out;
    };
    wrapped.__liveWrapped = true;
    window.btoa = wrapped;
  }
}

async function main() {
  const injectCaptchaVerifyCallback = hasFlag('--callback');
  const outputPath = parseOutputPath();
  const bundle = await ensureAliyunBundleFiles();
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

  const runtime = await FeilinVmRuntime.create({
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
      literalSnippetPatches: buildStage2Patches(),
    },
    captureXhrStacks: true,
  });
  installRuntimeHooks(runtime);

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
    injectCaptchaVerifyCallback,
    timeoutMs: 3500,
  });

  const verifyRows = runtime.xhrLog
    .filter((entry) => entry?.params?.Action === 'VerifyCaptchaV3')
    .map(parseVerifyRow)
    .filter(Boolean);

  let computedToken = null;
  try {
    computedToken = await runtime.computeToken();
  } catch (error) {
    computedToken = { error: String(error && error.stack || error) };
  }

  const payload = {
    mode: injectCaptchaVerifyCallback ? 'callback' : 'direct',
    bundle,
    liveInit: {
      certifyId,
      success: liveInit?.bodyJson?.Success ?? null,
      captchaType: liveInit?.bodyJson?.CaptchaType || null,
      hasDeviceConfig: !!deviceConfig,
      deviceConfigLength: typeof deviceConfig === 'string' ? deviceConfig.length : null,
    },
    runtimeState: runtime.snapshotInterestingState(),
    computedToken,
    xhrActions: runtime.xhrLog.map((x) => x?.params?.Action).filter(Boolean),
    verifyRows,
    sessionDeriveLogs: tail(runtime.window.__FEILIN_SESSION_DERIVE_LOGS__, 20),
    deriveHelperCalls: tail(runtime.window.__FEILIN_DERIVE_HELPER_CALLS__, 40),
    rsLogs: tail(runtime.window.__FEILIN_RS_LOGS__, 24),
    rsInnerLogs: tail(runtime.window.__FEILIN_RS_INNER_LOGS__, 40),
    ubArg100Logs: tail(runtime.window.__FEILIN_UB_ARG100_LOGS__, 20),
    uyLogs: tail(runtime.window.__FEILIN_UY_LOGS__, 20),
    callbackFlow: tail(runtime.window.__STAGE2_CALLBACK_FLOW_LOGS__, 20),
    initState: tail(runtime.window.__STAGE2_INIT_STATE_LOGS__, 20),
    dnFlow: tail(runtime.window.__STAGE2_DN_FLOW_LOGS__, 20),
    localFallback: tail(runtime.window.__STAGE2_LOCAL_FALLBACK_LOGS__, 20),
    peBizSuccess: tail(runtime.window.__STAGE2_PE_BIZ_SUCCESS_LOGS__, 20),
    tokenCallLogs: tail(runtime.window.__TOKEN_CALL_LOGS__, 20),
    tokenBtoaLogs: tail(runtime.window.__TOKEN_BTOA_LOGS__, 20),
    xVCallLogs: tail(runtime.window.__X_V_CALL_LOGS__, 500),
    xSCallLogs: tail(runtime.window.__X_S_CALL_LOGS__, 120),
    xDCallLogs: tail(runtime.window.__X_D_CALL_LOGS__, 120),
    xMCallLogs: tail(runtime.window.__X_M_CALL_LOGS__, 120),
    peTyLogs: tail(runtime.window.__PE_TY_LOGS__, 120),
    peTyReturns: tail(runtime.window.__PE_TY_RETURNS__, 120),
    peTy2Calls: tail(runtime.window.__PE_TY2_CALLS__, 120),
    autoTail: tail(auto?.events, 12),
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) {
    fs.writeFileSync(outputPath, text, 'utf8');
  }
  process.stdout.write(text);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
