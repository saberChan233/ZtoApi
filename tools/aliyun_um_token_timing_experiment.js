#!/usr/bin/env node

const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });

  const summarize = (value) => ({
    preview: value ? String(value).slice(0, 220) : null,
    prefix: value ? String(value).split('#')[0] || null : null,
    partsCount: value ? String(value).split('#').length : 0,
    thirdLen: value ? (String(value).split('#')[2] || '').length : 0,
    fourth: value ? String(value).split('#')[3] || null : null,
    fifth: value ? String(value).split('#')[4] || null : null,
  });

  console.log(JSON.stringify({
    pre: {
      um: summarize(out.umTokenPreview),
      zUm: summarize(out.zUmTokenPreview),
    },
    postAutoInit: {
      um: summarize(out.postAutoInitUmTokenPreview),
      zUm: summarize(out.postAutoInitZUmTokenPreview),
      umWithCertifyId: summarize(out.postAutoInitUmTokenWithCertifyIdPreview),
      zUmWithCertifyId: summarize(out.postAutoInitZUmTokenWithCertifyIdPreview),
    },
    verify: {
      initDeviceTokenPreview: out.initDeviceTokenPreview || null,
      deviceTokenPreview: out.deviceTokenPreview || null,
      verifyCode: out.liveVerify?.bodyJson?.Result?.VerifyCode || null,
    },
    trace: {
      umEvents: out.umObjectSnapshot?.events || [],
      zUmEvents: out.zUmObjectSnapshot?.events || [],
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
