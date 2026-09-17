import { test } from "node:test";
import assert from "node:assert/strict";
import { runSelfTest, verdict } from "../web/selftest.js";
import { AMP_SLOT, AMP_PARAM } from "../web/spark-preset.js";

const TONE = {
  uuid: "EB6E51F4-D60F-49E8-9CD1-40C2962A8B38",
  name: "Comped Cleaner", version: "0.7", description: "", icon: "icon.png", bpm: 120,
  pedals: [
    { name: "bias.noisegate", isOn: false, parameters: [0.2, 0.34] },
    { name: "BBEOpticalComp", isOn: true, parameters: [0.75, 0.25, 0] },
    { name: "Booster", isOn: true, parameters: [0.7] },
    { name: "RolandJC120", isOn: true, parameters: [0.5, 0.6, 0.55, 0.45, 0.8] },
    { name: "Cloner", isOn: false, parameters: [0.3, 0] },
    { name: "DelayMono", isOn: false, parameters: [0.2, 0.3, 0.4, 0.5, 1] },
    { name: "bias.reverb", isOn: true, parameters: [0.35, 0.4, 0.5, 0.6, 0.1, 0.9, 0.8] },
  ],
};

// A stand-in amp. `echoes` says whether it answers a knob or effect change with the
// 03 37 / 03 15 message that is the only confirmation those commands ever get.
function fakeAmp({ name = "Spark 40", tone = TONE, echoes = true, toneSendOk = true } = {}) {
  const live = tone ? structuredClone(tone) : null;
  const calls = [];
  return {
    calls,
    writeSize: () => 0xad,
    pause: async () => {},
    readAmpName: async () => name,
    readTone: async () => (tone ? structuredClone(live) : null),
    changePreset: async (n) => { calls.push(`preset ${n}`); return true; },
    sendTone: async (t, label) => {
      calls.push(`sendTone ${label}`);
      return toneSendOk ? { ok: true, acked: 4, chunks: 4 } : { ok: false, acked: 2, chunks: 4 };
    },
    setParameter: async (fx, param, value) => {
      calls.push(`param ${fx} ${param}=${value}`);
      live.pedals[AMP_SLOT].parameters[param] = value;
      return echoes ? value : null;
    },
    setEffect: async (fx, on) => {
      calls.push(`fx ${fx} ${on}`);
      const pedal = live.pedals.find((p) => p.name === fx);
      if (pedal) pedal.isOn = on;
      return echoes ? on : null;
    },
  };
}

const byName = (steps, name) => steps.find((s) => s.name === name);

test("a healthy amp passes every check", async () => {
  const amp = fakeAmp();
  const steps = await runSelfTest(amp);
  assert.ok(steps.every((s) => s.ok === true), JSON.stringify(steps, null, 2));
  assert.equal(verdict(steps), "Everything the amp can confirm, it confirmed.");
});

test("dropped blocks are reported as the tone-send failure they are", async () => {
  const steps = await runSelfTest(fakeAmp({ toneSendOk: false }));
  const send = byName(steps, "Full tone send");
  assert.equal(send.ok, false);
  assert.match(send.detail, /only 2\/4 chunks/);
  assert.match(verdict(steps), /not arriving whole/);
});

test("an amp that never echoes an edit is reported as not taking it", async () => {
  const steps = await runSelfTest(fakeAmp({ echoes: false }));
  assert.equal(byName(steps, "Volume reaches the amp").ok, false);
  assert.match(byName(steps, "Volume reaches the amp").detail, /did not take this change/);
  assert.equal(byName(steps, "Reverb on/off").ok, false);
});

test("volume confirmed by the amp points the blame away from the app", async () => {
  // The amp takes the knob but something else fails: the verdict must not send the user
  // hunting in the app for a volume problem that is not there.
  const amp = fakeAmp({ toneSendOk: true });
  const steps = await runSelfTest(amp);
  steps.push({ name: "Something else", ok: false, detail: "" });
  assert.match(verdict(steps), /volume is reaching the amp/);
});

test("the test stops cleanly when the amp sends no tone", async () => {
  const steps = await runSelfTest(fakeAmp({ tone: null }));
  assert.equal(steps.length, 2);
  assert.equal(byName(steps, "Amp sends its current tone").ok, false);
});

test("the amp is left on the tone it started on", async () => {
  const amp = fakeAmp();
  await runSelfTest(amp);
  const master = TONE.pedals[AMP_SLOT].parameters[AMP_PARAM.master];
  assert.equal(amp.calls.at(-1), "sendTone restore tone");
  // The probe value is put back, and the effect is switched back to how it was.
  assert.ok(amp.calls.includes(`param RolandJC120 ${AMP_PARAM.master}=${master}`), amp.calls.join("\n"));
  assert.ok(amp.calls.includes(`fx bias.reverb ${TONE.pedals[6].isOn}`), amp.calls.join("\n"));
});
