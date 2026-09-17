import { test } from "node:test";
import assert from "node:assert/strict";
import { SparkReader, describe, hex } from "../web/spark-protocol.js";
import {
  encodePreset, decodePreset, getCurrentPreset, changeEffectParameter, turnEffectOnOff, changeEffect,
  AMP_PARAM, internals,
} from "../web/spark-preset.js";

// An Ignitron-format tone (data/AcDc.json has the same shape).
const TONE = {
  uuid: "EB6E51F4-D60F-49E8-9CD1-40C2962A8B38",
  name: "Ac Dc",
  version: "0.7",
  description: "ACDc - Back in Black",
  icon: "icon.png",
  bpm: 120,
  pedals: [
    { name: "bias.noisegate", isOn: false, parameters: [0.2, 0.34] },
    { name: "BBEOpticalComp", isOn: true, parameters: [0.7583, 0.2585, 0] },
    { name: "Booster", isOn: true, parameters: [0.7] },
    { name: "94MatchDCV2", isOn: true, parameters: [0.5, 0.6, 0.55, 0.45, 0.8] },
    { name: "Cloner", isOn: false, parameters: [0.3, 0] },
    { name: "DelayMono", isOn: false, parameters: [0.2, 0.3, 0.4, 0.5, 1] },
    { name: "bias.reverb", isOn: true, parameters: [0.35, 0.4, 0.5, 0.6, 0.1, 0.9, 0.8] },
  ],
};

// Strip block headers and chunk framing the way the amp does, then rebuild the payload.
function payloadFromBlocks(blocks) {
  const reader = new SparkReader();
  let messages = [];
  for (const block of blocks) messages = messages.concat(reader.push(block));
  return messages;
}

test("tone survives encode → BLE blocks → decode", () => {
  const blocks = encodePreset(TONE, 3);
  assert.ok(blocks.length >= 1);
  const messages = payloadFromBlocks(blocks);
  assert.equal(messages.length, 1, "multi-chunk tone should join into one message");
  const info = describe(messages[0]);
  assert.equal(info.type, "tone");

  const decoded = decodePreset(info.data);
  assert.equal(decoded.presetNumber, 0x7f, "tone goes to the temporary slot, not a saved preset");
  assert.equal(decoded.name, TONE.name);
  assert.equal(decoded.uuid, TONE.uuid);
  assert.equal(decoded.description, TONE.description);
  assert.equal(decoded.bpm, 120);
  assert.deepEqual(decoded.pedals, TONE.pedals);
});

test("tone payload ends with the additive checksum of its body", () => {
  const blocks = encodePreset(TONE, 1);
  const [msg] = payloadFromBlocks(blocks);
  const body = msg.data.slice(2, -1);
  const expected = body.reduce((sum, b) => (sum + b) & 0xff, 0);
  assert.equal(msg.data.at(-1), expected);
});

test("long names use the 0xd9 long-string form", () => {
  const short = internals.encString("Ac Dc");
  assert.equal(short[0], 0xa0 + 5);
  const long = internals.encString("x".repeat(40));
  assert.deepEqual(long.slice(0, 2), [0xd9, 40]);
});

test("floats are big-endian with a 0xca tag", () => {
  assert.equal(hex(internals.encFloat(1.0)), "CA 3F 80 00 00");
  assert.equal(hex(internals.encFloat(0.5)), "CA 3F 00 00 00");
  assert.equal(hex(internals.encFloat(0)), "CA 00 00 00 00");
});

test("volume/EQ command carries effect name, parameter index and value", () => {
  const [block] = changeEffectParameter("Twin", AMP_PARAM.master, 0.5, 2);
  const payload = hex(block);
  assert.ok(payload.startsWith("01 FE 00 00 53 FE"), payload);
  // chunk: F0 01 msgNum checksum 01 04 ...
  assert.ok(payload.includes("F0 01 02"), payload);
  assert.ok(payload.includes("01 04"), payload);
  const [msg] = payloadFromBlocks([block]);
  assert.equal(msg.cmd, 0x01);
  assert.equal(msg.subCmd, 0x04);
  // 04 A4 'T' 'w' 'i' 'n' 04 CA 3F 00 00 00
  assert.deepEqual(msg.data.slice(0, 2), [0x04, 0xa4]);
  assert.equal(String.fromCharCode(...msg.data.slice(2, 6)), "Twin");
  assert.equal(msg.data[6], AMP_PARAM.master);
  assert.deepEqual(msg.data.slice(7), [0xca, 0x3f, 0x00, 0x00, 0x00]);
});

test("effect on/off command", () => {
  const [block] = turnEffectOnOff("Booster", true, 4);
  const [msg] = payloadFromBlocks([block]);
  assert.equal(msg.subCmd, 0x15);
  assert.equal(msg.data.at(-2), 0xc3);
  const [offBlock] = turnEffectOnOff("Booster", false, 5);
  assert.equal(payloadFromBlocks([offBlock])[0].data.at(-2), 0xc2);
});

test("get current preset asks for the loaded tone or a stored one", () => {
  const [loaded] = getCurrentPreset(-1, 1);
  const [stored] = getCurrentPreset(2, 1);
  assert.deepEqual(payloadFromBlocks([loaded])[0].data, [0x01, 0x00]);
  assert.deepEqual(payloadFromBlocks([stored])[0].data, [0x00, 0x02]);
});

test("reader joins tone chunks arriving from the amp in 25-byte pieces", () => {
  // Re-chunk an encoded tone the way the amp sends it back (small chunks, 41 FF direction).
  const [msg] = payloadFromBlocks(encodePreset(TONE, 1));
  const payload = msg.data;
  const chunkSize = 0x19;
  const count = Math.ceil(payload.length / chunkSize);
  const reader = new SparkReader();
  let out = [];
  for (let i = 0; i < count; i++) {
    const part = payload.slice(i * chunkSize, (i + 1) * chunkSize);
    const data8 = [count, i, part.length, ...part];
    const data7 = [];
    for (let s = 0; s < data8.length; s += 7) {
      const seq = data8.slice(s, s + 7);
      let high = 0;
      seq.forEach((b, j) => { if (b & 0x80) high |= 1 << j; });
      data7.push(high, ...seq.map((b) => b & 0x7f));
    }
    const chunk = [0xf0, 0x01, 0x20, data7.reduce((a, b) => a ^ b, 0), 0x03, 0x01, ...data7, 0xf7];
    const block = [0x01, 0xfe, 0x00, 0x00, 0x41, 0xff, 16 + chunk.length, ...new Array(9).fill(0), ...chunk];
    out = out.concat(reader.push(block));
  }
  assert.equal(out.length, 1);
  assert.equal(decodePreset(out[0].data).name, "Ac Dc");
});

test("change effect model sends both technical names", () => {
  const [block] = changeEffect("Booster", "Fuzz", 6);
  const [msg] = payloadFromBlocks([block]);
  assert.equal(msg.subCmd, 0x06);
  assert.deepEqual(msg.data.slice(0, 2), [7, 0xa7]);
  assert.equal(String.fromCharCode(...msg.data.slice(2, 9)), "Booster");
  assert.deepEqual(msg.data.slice(9, 11), [4, 0xa4]);
  assert.equal(String.fromCharCode(...msg.data.slice(11)), "Fuzz");
});

test("interleaved or missing chunks never produce a corrupt tone", () => {
  const [full] = payloadFromBlocks(encodePreset(TONE, 1));
  const payload = full.data;
  const chunkSize = 0x19;
  const count = Math.ceil(payload.length / chunkSize);

  const toBlock = (i, msgNum) => {
    const part = payload.slice(i * chunkSize, (i + 1) * chunkSize);
    const data8 = [count, i, part.length, ...part];
    const data7 = [];
    for (let s = 0; s < data8.length; s += 7) {
      const seq = data8.slice(s, s + 7);
      let high = 0;
      seq.forEach((b, j) => { if (b & 0x80) high |= 1 << j; });
      data7.push(high, ...seq.map((b) => b & 0x7f));
    }
    const chunk = [0xf0, 0x01, msgNum, data7.reduce((a, b) => a ^ b, 0), 0x03, 0x01, ...data7, 0xf7];
    return [0x01, 0xfe, 0x00, 0x00, 0x41, 0xff, 16 + chunk.length, ...new Array(9).fill(0), ...chunk];
  };

  // Missing first chunk: nothing should be emitted.
  const dropped = new SparkReader();
  let out = [];
  for (let i = 1; i < count; i++) out = out.concat(dropped.push(toBlock(i, 0x20)));
  assert.deepEqual(out, [], "a tone missing its first chunk must be discarded");

  // A second message interrupting the first: only the complete one is emitted.
  const mixed = new SparkReader();
  out = mixed.push(toBlock(0, 0x20));
  out = out.concat(mixed.push(toBlock(0, 0x21)));
  for (let i = 1; i < count; i++) out = out.concat(mixed.push(toBlock(i, 0x21)));
  assert.equal(out.length, 1);
  assert.equal(decodePreset(out[0].data).name, "Ac Dc");
});

test("garbled payloads are rejected instead of decoded as junk", () => {
  assert.throws(() => decodePreset([0x00, 0x7f, 0xd9, 0x03, 0x41]), /too short/);
  const junk = new Array(80).fill(0);
  junk[2] = 0xd9; junk[3] = 4; junk[4] = 0x01; // unprintable name characters
  assert.throws(() => decodePreset(junk), /bad/);
});

test("a tone reports how many chunks the amp must ack", () => {
  // The amp sends one 05 01 per chunk, then 04 01 for the whole tone. The sender
  // compares the two, so a tone that arrived in part is resent instead of played.
  const blocks = encodePreset(TONE, 1);
  assert.ok(blocks.chunks >= 2, `a full tone spans several chunks, got ${blocks.chunks}`);
  const starts = blocks.flatMap((b) => Array.from(b).slice(16))
    .filter((b, i, all) => b === 0xf0 && all[i + 1] === 0x01).length;
  assert.equal(blocks.chunks, starts, "chunk count must match the F0 01 chunk headers sent");
});
