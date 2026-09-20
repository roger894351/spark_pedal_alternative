import { test } from "node:test";
import assert from "node:assert/strict";
import { randomTone, MIN_MASTER } from "../web/random-tone.js";
import { encodePreset, decodePreset, PEDAL_COUNT, AMP_SLOT, AMP_PARAM } from "../web/spark-preset.js";
import { SparkReader, describe as describeMsg } from "../web/spark-protocol.js";
import { fxInfo } from "../web/fx-catalog.js";

const BASE = { bpm: 120, pedals: Array.from({ length: PEDAL_COUNT }, () => ({ name: "Booster", isOn: true, parameters: [0.5] })) };

test("random tones are valid and keep a steady volume", () => {
  for (let i = 0; i < 50; i++) {
    const tone = randomTone({ ...BASE, pedals: BASE.pedals.map((p, s) => (s === AMP_SLOT ? { ...p, parameters: [0.5, 0.5, 0.5, 0.5, 0.62] } : p)) }, i);
    assert.equal(tone.pedals.length, PEDAL_COUNT);
    assert.ok(tone.name.startsWith("Random "));
    assert.equal(tone.pedals[AMP_SLOT].isOn, true, "the amp block must stay on");
    assert.equal(tone.pedals[AMP_SLOT].parameters[AMP_PARAM.master], 0.62, "volume follows the previous tone");
    for (const pedal of tone.pedals) {
      const info = fxInfo(pedal.name);
      assert.ok(info, `unknown effect ${pedal.name}`);
      assert.equal(pedal.parameters.length, info.params.length);
      assert.ok(pedal.parameters.every((v) => v >= 0 && v <= 1), "knobs stay in range");

    }
  }
});

test("a random tone survives the trip to the amp and back", () => {
  const tone = randomTone(BASE, 7);
  const reader = new SparkReader();
  let messages = [];
  for (const block of encodePreset(tone, 9)) messages = messages.concat(reader.push(block));
  const decoded = decodePreset(describeMsg(messages[0]).data);
  assert.equal(decoded.name, "Random 7");
  assert.deepEqual(decoded.pedals.map((p) => p.name), tone.pedals.map((p) => p.name));
});

test("Hendrix gear is included by default and can be switched off", () => {
  const free = Array.from({ length: 40 }, (_, i) => randomTone(BASE, i, { includePaid: false }));
  assert.ok(free.every((t) => t.pedals.every((p) => !p.name.startsWith("JH."))), "opt-out must exclude paid gear");
  const any = Array.from({ length: 300 }, (_, i) => randomTone(BASE, i));
  assert.ok(any.some((t) => t.pedals.some((p) => p.name.startsWith("JH."))), "default should allow paid gear");
});

test("a random tone is never left inaudible", () => {
  const quiet = structuredClone(BASE);
  quiet.pedals[AMP_SLOT].parameters[AMP_PARAM.master] = 0.05;
  const tone = randomTone(quiet, 1);
  assert.ok(tone.pedals[AMP_SLOT].parameters[AMP_PARAM.master] >= MIN_MASTER,
    "a near-silent master volume must not be carried into a random tone");
  // A volume the player can actually hear is kept as it is.
  const loud = structuredClone(BASE);
  loud.pedals[AMP_SLOT].parameters[AMP_PARAM.master] = 0.72;
  assert.equal(randomTone(loud, 1).pedals[AMP_SLOT].parameters[AMP_PARAM.master], 0.72);
});

test("gear this amp doesn't have is never offered again", () => {
  // The catalog is the union of every Spark's models, so a random tone can name something
  // the connected amp never shipped. Once the amp has shown it substitutes that model,
  // it has to stop appearing or the same unplayable tone keeps coming back.
  const exclude = new Set(["SABDriver"]);
  for (let i = 0; i < 200; i++) {
    const tone = randomTone(BASE, i, { exclude });
    assert.ok(!tone.pedals.some((p) => exclude.has(p.name)), `run ${i} used excluded gear`);
  }
  // Excluding one model must not empty a slot: something else still gets picked.
  const drives = new Set();
  for (let i = 0; i < 200; i++) drives.add(randomTone(BASE, i, { exclude }).pedals[2].name);
  assert.ok(drives.size > 1, "the drive slot should still have choices");
});
