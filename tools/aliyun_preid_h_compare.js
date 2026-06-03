#!/usr/bin/env node
const fs = require('fs');
const { splitPreidH, PREID_H_STATIC_PREFIX_BASE64 } = require('./aliyun_preid_h_local');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function parseHarVerifyToken(harPath, verifyIndex = 94) {
  const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
  const entry = har?.log?.entries?.[verifyIndex];
  if (!entry) throw new Error(`missing HAR entry ${verifyIndex}`);
  const form = Object.fromEntries(new URLSearchParams(entry.request?.postData?.text || '').entries());
  const payload = JSON.parse(form.CaptchaVerifyParam || '{}');
  const plain = Buffer.from(payload.deviceToken || '', 'base64').toString('utf8');
  return {
    plain,
    source: `${harPath}#${verifyIndex}`,
  };
}

function summarize(name, plain) {
  const parts = String(plain || '').split('#');
  const third = parts[2] || '';
  const base = {
    name,
    second: parts[1] || null,
    thirdLength: third.length,
    fourth: parts[3] || null,
    fifth: parts[4] || null,
  };
  if (!third) return { ...base, splitOk: false };
  try {
    const split = splitPreidH(third);
    const defaultPrefix = Buffer.from(PREID_H_STATIC_PREFIX_BASE64, 'base64');
    let common = 0;
    while (common < Math.min(defaultPrefix.length, split.prefix.length) && defaultPrefix[common] === split.prefix[common]) {
      common += 1;
    }
    return {
      ...base,
      splitOk: true,
      totalBytes: split.buffer.length,
      prefixBytes: split.prefix.length,
      tailBytes: split.tail.length,
      prefixBase64Preview: split.prefix.toString('base64').slice(0, 160),
      defaultPrefixCommonBytes: common,
      defaultPrefixExactMatch: common === defaultPrefix.length && split.prefix.length === defaultPrefix.length,
    };
  } catch (error) {
    return {
      ...base,
      splitOk: false,
      error: String(error && error.message || error),
    };
  }
}

function main() {
  const harPath = getArg('--har', 'glitchhunter_session_1779496468306.har');
  const verifyIndex = Number(getArg('--verify-index', '94'));
  const browser = parseHarVerifyToken(harPath, verifyIndex);
  console.log(JSON.stringify({
    browser: summarize(browser.source, browser.plain),
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exit(1);
  }
}
