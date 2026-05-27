#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_LOADER_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
const DEFAULT_DYNAMIC_URL = 'https://g.alicdn.com/captcha-frontend/dynamicJS/3.25.0/pe.092.5b9f44e900a2b7c5.js';
const DEFAULT_FEILIN_URL = 'https://g.alicdn.com/captcha-frontend/FeiLin/1.4.2/feilin050.613d0930758597fa3bd6259470267d0c251b971ced77e86280217002235f682f.js';

function resolveBundleConfig(overrides = {}) {
  const feilinPath = overrides.feilinPath || process.env.AUTO_CAPTCHA_PURE_CODE_FEILIN || '/tmp/feilin.js';
  const dynamicPath = overrides.dynamicPath || process.env.AUTO_CAPTCHA_PURE_CODE_DYNAMIC || '/tmp/aliyun-pe.js';
  const loaderPath = overrides.loaderPath || process.env.AUTO_CAPTCHA_PURE_CODE_LOADER || '/tmp/AliyunCaptcha.js';
  return {
    feilinPath,
    dynamicPath,
    loaderPath,
    feilinUrl: overrides.feilinUrl || process.env.AUTO_CAPTCHA_PURE_CODE_FEILIN_URL || DEFAULT_FEILIN_URL,
    dynamicUrl: overrides.dynamicUrl || process.env.AUTO_CAPTCHA_PURE_CODE_DYNAMIC_URL || DEFAULT_DYNAMIC_URL,
    loaderUrl: overrides.loaderUrl || process.env.AUTO_CAPTCHA_PURE_CODE_LOADER_URL || DEFAULT_LOADER_URL,
  };
}

async function downloadToFile(url, filePath) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`download failed ${response.status} ${response.statusText} for ${url}`);
    }
    const text = await response.text();
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, text, 'utf8');
    return {
      url,
      filePath,
      bytes: Buffer.byteLength(text, 'utf8'),
      transport: 'fetch',
    };
  } catch (fetchError) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const out = spawnSync('curl', ['-L', url, '-o', filePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (out.status !== 0) {
      throw new Error(`download failed for ${url}: ${String(fetchError && fetchError.stack || fetchError)} | curl stderr=${out.stderr || ''}`);
    }
    const stat = await fs.promises.stat(filePath);
    return {
      url,
      filePath,
      bytes: stat.size,
      transport: 'curl',
    };
  }
}

async function ensureAliyunBundleFiles(overrides = {}) {
  const cfg = resolveBundleConfig(overrides);
  const canonical = resolveBundleConfig({});
  const targets = [
    { kind: 'feilin', filePath: cfg.feilinPath, url: cfg.feilinUrl, fallbackPath: canonical.feilinPath },
    { kind: 'dynamic', filePath: cfg.dynamicPath, url: cfg.dynamicUrl, fallbackPath: canonical.dynamicPath },
    { kind: 'loader', filePath: cfg.loaderPath, url: cfg.loaderUrl, fallbackPath: canonical.loaderPath },
  ];
  const results = [];
  const seenPaths = new Set();
  for (const target of targets) {
    if (seenPaths.has(target.filePath)) {
      results.push({
        kind: target.kind,
        filePath: target.filePath,
        url: target.url,
        exists: fs.existsSync(target.filePath),
        downloaded: false,
        skippedDuplicatePath: true,
      });
      continue;
    }
    seenPaths.add(target.filePath);
    if (fs.existsSync(target.filePath)) {
      const stat = await fs.promises.stat(target.filePath);
      results.push({
        kind: target.kind,
        filePath: target.filePath,
        url: target.url,
        exists: true,
        downloaded: false,
        bytes: stat.size,
      });
      continue;
    }
    if (
      target.fallbackPath &&
      target.fallbackPath !== target.filePath &&
      fs.existsSync(target.fallbackPath)
    ) {
      await fs.promises.mkdir(path.dirname(target.filePath), { recursive: true });
      await fs.promises.copyFile(target.fallbackPath, target.filePath);
      const stat = await fs.promises.stat(target.filePath);
      results.push({
        kind: target.kind,
        filePath: target.filePath,
        url: target.url,
        exists: true,
        downloaded: false,
        copiedFromFallback: target.fallbackPath,
        bytes: stat.size,
      });
      continue;
    }
    const downloaded = await downloadToFile(target.url, target.filePath);
    results.push({
      kind: target.kind,
      filePath: target.filePath,
      url: target.url,
      exists: true,
      downloaded: true,
      bytes: downloaded.bytes,
    });
  }
  return {
    files: [cfg.feilinPath, cfg.dynamicPath, cfg.loaderPath],
    loaderPath: cfg.loaderPath,
    results,
  };
}

if (require.main === module) {
  ensureAliyunBundleFiles().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    console.error(String(error && error.stack || error));
    process.exit(1);
  });
} else {
  module.exports = {
    DEFAULT_LOADER_URL,
    DEFAULT_DYNAMIC_URL,
    DEFAULT_FEILIN_URL,
    resolveBundleConfig,
    ensureAliyunBundleFiles,
  };
}
