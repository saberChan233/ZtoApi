#!/usr/bin/env node
const { runProbe } = require('./probe_feilin_runtime');

function inspect(report) {
  const verify = (report.xhrLog || []).find((x) => x?.params?.Action === 'VerifyCaptchaV3');
  if (!verify) {
    return {
      ok: false,
      asyncErrors: report.asyncErrors || [],
      autoInit: report.autoInit || [],
    };
  }
  const payload = JSON.parse(verify.params.CaptchaVerifyParam);
  const decoded = Buffer.from(payload.deviceToken, 'base64').toString('utf8');
  const parts = decoded.split('#');
  return {
    ok: true,
    prefix: parts[0],
    part3: parts[3],
    partLens: parts.map((x) => x.length),
    dataLen: (payload.data || '').length,
    asyncErrors: report.asyncErrors || [],
  };
}

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

const baseTouchSeq = [
  { type: 'touchstart', clientX: 35, clientY: 20, pointerType: 'touch', buttons: 1 },
  { type: 'touchmove', clientX: 60, clientY: 22, pointerType: 'touch', buttons: 1 },
  { type: 'touchmove', clientX: 90, clientY: 24, pointerType: 'touch', buttons: 1 },
  { type: 'touchend', clientX: 95, clientY: 25, pointerType: 'touch', buttons: 0 },
];

const keySeq = [
  { type: 'keydown', key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16, target: 'window' },
  { type: 'keyup', key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16, target: 'window' },
  { type: 'keydown', key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, target: 'window' },
  { type: 'keyup', key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, target: 'window' },
];

const variants = [
  { name: 'baseline', syntheticEventsBeforeTrigger: [] },
  { name: 'doc_mouse', syntheticEventsBeforeTrigger: baseMouseSeq },
  { name: 'doc_pointer', syntheticEventsBeforeTrigger: basePointerSeq },
  { name: 'doc_touch', syntheticEventsBeforeTrigger: baseTouchSeq },
  { name: 'doc_mouse_plus_keys', syntheticEventsBeforeTrigger: [...baseMouseSeq, ...keySeq] },
  { name: 'doc_pointer_plus_keys', syntheticEventsBeforeTrigger: [...basePointerSeq, ...keySeq] },
  {
    name: 'window_mouse',
    syntheticEventsBeforeTrigger: baseMouseSeq.map((x) => ({ ...x, target: 'window' })),
  },
  {
    name: 'body_mouse',
    syntheticEventsBeforeTrigger: baseMouseSeq.map((x) => ({ ...x, target: 'body' })),
  },
  {
    name: 'button_mouse',
    syntheticEventsBeforeTrigger: baseMouseSeq.map((x) => ({ ...x, target: 'button' })),
  },
  {
    name: 'mixed_mouse',
    syntheticEventsBeforeTrigger: [
      ...baseMouseSeq.slice(0, 3).map((x) => ({ ...x, target: 'window' })),
      ...baseMouseSeq.slice(3, 7).map((x) => ({ ...x, target: 'button' })),
      ...baseMouseSeq.slice(7).map((x) => ({ ...x, target: 'document' })),
    ],
  },
  {
    name: 'mixed_pointer_mouse_touch',
    syntheticEventsBeforeTrigger: [
      ...basePointerSeq.map((x) => ({ ...x, target: 'document' })),
      ...baseMouseSeq.slice(3, 7).map((x) => ({ ...x, target: 'button' })),
      ...baseTouchSeq.map((x) => ({ ...x, target: 'document' })),
      ...keySeq,
    ],
  },
];

async function main() {
  const files = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const rows = [];
  for (const variant of variants) {
    const report = await runProbe(files, {
      injectCaptchaVerifyCallback: false,
      initialAliyunCaptchaConfig: { region: 'sgp', prefix: 'no8xfe' },
      setGlobalAliyunCaptchaConfig: false,
      syntheticEventsBeforeTrigger: variant.syntheticEventsBeforeTrigger,
    });
    rows.push({ name: variant.name, ...inspect(report) });
  }
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
