#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { FeilinVmRuntime } = require('./feilin_vm_runtime');

const FILES = {
  feilinPath: '/tmp/feilin.js',
  dynamicPath: '/tmp/aliyun-pe.js',
  loaderPath: '/tmp/AliyunCaptcha.js',
};

function previewValue(value, limit = 200) {
  if (typeof value === 'string') return value.slice(0, limit);
  if (value == null) return value;
  if (typeof value === 'function') return String(value).slice(0, limit);
  if (Array.isArray(value)) return value.slice(0, 12).map((x) => previewValue(x, 80));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 12)) {
      out[key] = previewValue(value[key], 80);
    }
    return out;
  }
  return value;
}

function snapshotShape(value, limit = 40) {
  if (!value || typeof value !== 'object') return null;
  const keys = Reflect.ownKeys(value).map(String).slice(0, limit);
  const preview = {};
  for (const key of keys.slice(0, 20)) {
    try {
      preview[key] = previewValue(value[key], 200);
    } catch (err) {
      preview[key] = { error: String(err) };
    }
  }
  return { keys, preview };
}

function diffPreview(left, right, label) {
  const rows = [];
  const leftPreview = left?.preview || {};
  const rightPreview = right?.preview || {};
  const keys = new Set([...Object.keys(leftPreview), ...Object.keys(rightPreview)]);
  for (const key of [...keys].sort()) {
    const a = JSON.stringify(leftPreview[key]);
    const b = JSON.stringify(rightPreview[key]);
    if (a !== b) {
      rows.push({ label, key, vm: leftPreview[key], probe: rightPreview[key] });
    }
  }
  return rows;
}

async function main() {
  const runtime = await FeilinVmRuntime.create(FILES);
  const out = await solveCaptcha({
    files: [FILES.feilinPath, FILES.dynamicPath, FILES.loaderPath],
    loaderPath: FILES.loaderPath,
  });

  const vmState = {
    re: snapshotShape(runtime.window.__FEILIN_RE__),
    rk: snapshotShape(runtime.window.__FEILIN_RK__),
    rm: snapshotShape(runtime.window.__FEILIN_RM__),
    ro: snapshotShape(runtime.window.__FEILIN_RO__),
    ru: snapshotShape(runtime.window.__FEILIN_RU__),
    rn: snapshotShape(runtime.window.__FEILIN_RN__),
  };
  const probeState = {
    re: out.feilinReSnapshot || null,
    rk: out.feilinRkSnapshot || null,
    rm: out.feilinRmSnapshot || null,
    ro: out.feilinRoSnapshot || null,
    ru: out.feilinRuSnapshot || null,
    rn: out.feilinRnSnapshot || null,
  };

  console.log(JSON.stringify({
    vmState,
    probeState,
    diffs: [
      ...diffPreview(vmState.re, probeState.re, 're'),
      ...diffPreview(vmState.rk, probeState.rk, 'rk'),
      ...diffPreview(vmState.rm, probeState.rm, 'rm'),
      ...diffPreview(vmState.ro, probeState.ro, 'ro'),
      ...diffPreview(vmState.ru, probeState.ru, 'ru'),
      ...diffPreview(vmState.rn, probeState.rn, 'rn'),
    ],
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
