#!/usr/bin/env node

const fs = require('fs');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function diffValues(before, after, path, rows) {
  if (before === after) return;
  const beforeIsObj = isObject(before);
  const afterIsObj = isObject(after);
  if (beforeIsObj && afterIsObj) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      diffValues(before[key], after[key], `${path}.${key}`, rows);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i += 1) {
      diffValues(before[i], after[i], `${path}[${i}]`, rows);
    }
    return;
  }
  rows.push({
    path,
    before,
    after,
  });
}

function pickSnapshot(input, label) {
  const found = (input.snapshots || []).find((item) => item.label === label);
  if (!found) {
    throw new Error(`snapshot not found: ${label}`);
  }
  return found.state;
}

function main() {
  const inputPath = getArg('--input');
  const beforeLabel = getArg('--before', 'before-send');
  const afterLabel = getArg('--after', 'after-verify-request');
  if (!inputPath) {
    throw new Error('missing --input <runtime-json>');
  }
  const input = readJson(inputPath);
  const before = pickSnapshot(input, beforeLabel);
  const after = pickSnapshot(input, afterLabel);
  const rows = [];
  diffValues(before, after, 'state', rows);
  console.log(JSON.stringify({
    beforeLabel,
    afterLabel,
    eventActions: (input.events || []).map((item) => item.action).filter(Boolean),
    diffCount: rows.length,
    diffs: rows.slice(0, 300),
  }, null, 2));
}

main();
