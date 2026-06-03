#!/usr/bin/env node

function pickPart(report, name) {
  return (report?.n0PartLogs || []).find((entry) => entry?.name === name) || null;
}

function pickLastPart(report, name) {
  const rows = (report?.n0PartLogs || []).filter((entry) => entry?.name === name);
  return rows.length ? rows[rows.length - 1] : null;
}

function parseTokenLPreview(lPreview) {
  const l = String(lPreview || '');
  const parts = l ? l.split('#') : [];
  return {
    raw: l,
    parts,
    prefixA: parts[0] ?? null,
    prefixB: parts[1] ?? null,
    osName: parts[37] ?? null,
    platformArch: parts[38] ?? null,
    browser: parts[7] ?? null,
    browserVersion: parts[8] ?? null,
    uy: parts[22] ?? null,
    o6: parts[33] ?? null,
    permutationTrace: parts[44] ?? null,
    stateFingerprint: parts[53] ?? null,
    currentUrl: parts[54] ?? null,
    appName: parts[67] ?? null,
    scene: parts[68] ?? null,
    sceneFlag: parts[69] ?? null,
    sceneFlag2: parts[70] ?? null,
    ce: parts[71] ?? null,
    ceTimestamp: parts[72] ?? null,
    ci: parts[73] ?? null,
    ciTimestamp: parts[74] ?? null,
    ciTimestamp2: parts[75] ?? null,
    deviceClass: parts[76] ?? null,
    certifyId: parts[77] ?? null,
    md5ishA: parts[78] ?? null,
    md5ish: parts[79] ?? null,
    uaTail: parts[81] ?? null,
    secondTimestamp: parts[87] ?? null,
    chromiumBrands: parts[111] ?? null,
  };
}

function cloneParts(parts) {
  return Array.isArray(parts) ? parts.slice() : [];
}

function applyTokenVectorToParts(parts, patch = {}) {
  const next = cloneParts(parts);
  const assignments = [
    ['osName', 37],
    ['platformArch', 38],
    ['browser', 7],
    ['browserVersion', 8],
    ['uy', 22],
    ['o6', 33],
    ['permutationTrace', 44],
    ['stateFingerprint', 53],
    ['currentUrl', 54],
    ['appName', 67],
    ['scene', 68],
    ['sceneFlag', 69],
    ['sceneFlag2', 70],
    ['ce', 71],
    ['ceTimestamp', 72],
    ['ci', 73],
    ['ciTimestamp', 74],
    ['ciTimestamp2', 75],
    ['deviceClass', 76],
    ['certifyId', 77],
    ['md5ishA', 78],
    ['md5ish', 79],
    ['uaTail', 81],
    ['secondTimestamp', 87],
    ['chromiumBrands', 111],
  ];
  for (const [key, index] of assignments) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      while (next.length <= index) next.push('');
      next[index] = patch[key] == null ? '' : String(patch[key]);
    }
  }
  return next;
}

function buildTokenLPreviewFromParts(parts) {
  return cloneParts(parts).join('#');
}

function buildTokenLPreviewFromVector(vector, patch = {}) {
  const baseParts = cloneParts(vector?.parts || vector?.parsed?.parts || []);
  const nextParts = applyTokenVectorToParts(baseParts, patch);
  return buildTokenLPreviewFromParts(nextParts);
}

function buildTokenVectorFromReport(report) {
  const vector = pickBestTokenVector(report);
  if (vector) return vector;
  const v = pickLastPart(report, 'v') || pickPart(report, 'v');
  const m = pickLastPart(report, 'm') || pickPart(report, 'm');
  const B = pickLastPart(report, 'B') || pickPart(report, 'B');
  const tA = pickLastPart(report, 'tA') || pickPart(report, 'tA');
  const parsed = parseTokenLPreview(v?.lPreview || '');
  return {
    candidateIndex: 0,
    lLength: typeof v?.lLength === 'number' ? v.lLength : parsed.raw.length,
    second: tA?.value || null,
    secondCipherBase64: tA?.CPreview || null,
    trPreview: tA?.trPreview || null,
    xPrefix: v?.xPreview || null,
    uy: parsed.uy,
    ce: parsed.ce,
    ceTimestamp: parsed.ceTimestamp,
    ci: parsed.ci,
    ciTimestamp: parsed.ciTimestamp,
    o6: parsed.md5ish,
    secondTimestamp: parsed.secondTimestamp,
    appName: parsed.appName,
    permutationTrace: parsed.permutationTrace,
    stateFingerprint: parsed.stateFingerprint,
    currentUrl: parsed.currentUrl,
    osName: parsed.osName,
    platformArch: parsed.platformArch,
    browser: parsed.browser,
    browserVersion: parsed.browserVersion,
    deviceClass: parsed.deviceClass,
    certifyId: parsed.certifyId,
    md5ishA: parsed.md5ishA,
    mHex: m?.mHexPreview || null,
    BHex: B?.value || null,
    parts: parsed.parts,
    parsed,
  };
}

function buildTokenVectorFromParts(v, tA, m, B, candidateIndex = 0) {
  const parsed = parseTokenLPreview(v?.lPreview || '');
  return {
    candidateIndex,
    lLength: typeof v?.lLength === 'number' ? v.lLength : parsed.raw.length,
    second: tA?.value || null,
    secondCipherBase64: tA?.CPreview || null,
    trPreview: tA?.trPreview || null,
    xPrefix: v?.xPreview || null,
    uy: parsed.uy,
    ce: parsed.ce,
    ceTimestamp: parsed.ceTimestamp,
    ci: parsed.ci,
    ciTimestamp: parsed.ciTimestamp,
    o6: parsed.md5ish,
    secondTimestamp: parsed.secondTimestamp,
    appName: parsed.appName,
    permutationTrace: parsed.permutationTrace,
    stateFingerprint: parsed.stateFingerprint,
    currentUrl: parsed.currentUrl,
    osName: parsed.osName,
    platformArch: parsed.platformArch,
    browser: parsed.browser,
    browserVersion: parsed.browserVersion,
    deviceClass: parsed.deviceClass,
    certifyId: parsed.certifyId,
    md5ishA: parsed.md5ishA,
    mHex: m?.mHexPreview || null,
    BHex: B?.value || null,
    parts: parsed.parts,
    parsed,
    sourceParts: { v, tA, m, B },
  };
}

function collectTokenVectorsFromReport(report) {
  const rows = Array.isArray(report?.n0PartLogs) ? report.n0PartLogs : [];
  let lastM = null;
  let lastB = null;
  let lastTA = null;
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.name === 'm') lastM = row;
    else if (row.name === 'B') lastB = row;
    else if (row.name === 'tA') lastTA = row;
    else if (row.name === 'v') {
      out.push(buildTokenVectorFromParts(row, lastTA, lastM, lastB, out.length));
    }
  }
  return out;
}

function scoreTokenVector(vector) {
  if (!vector || typeof vector !== 'object') return -Infinity;
  let score = 0;
  if (typeof vector.second === 'string' && vector.second.includes('-h-')) score += 2000;
  if (typeof vector.trPreview === 'string' && vector.trPreview.length === 16) score += 1200;
  if (typeof vector.secondCipherBase64 === 'string' && vector.secondCipherBase64.length >= 64) score += 800;
  if (typeof vector.currentUrl === 'string' && vector.currentUrl.includes('chat.z.ai')) score += 300;
  if (typeof vector.certifyId === 'string' && vector.certifyId) score += 300;
  if (typeof vector.lLength === 'number') score += vector.lLength;
  score += vector.candidateIndex || 0;
  return score;
}

function pickBestTokenVector(report) {
  const vectors = collectTokenVectorsFromReport(report);
  if (!vectors.length) return null;
  return [...vectors].sort((a, b) => scoreTokenVector(b) - scoreTokenVector(a))[0];
}

if (require.main === module) {
  const fs = require('fs');
  const path = process.argv[2];
  if (!path) {
    console.error('usage: aliyun_token_vector.js <report.json>');
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(path, 'utf8'));
  console.log(JSON.stringify(buildTokenVectorFromReport(report), null, 2));
} else {
  module.exports = {
    parseTokenLPreview,
    applyTokenVectorToParts,
    buildTokenLPreviewFromParts,
    buildTokenLPreviewFromVector,
    buildTokenVectorFromParts,
    buildTokenVectorFromReport,
    collectTokenVectorsFromReport,
    pickBestTokenVector,
  };
}
