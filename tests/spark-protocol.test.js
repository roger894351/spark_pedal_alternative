import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMessage, changeHardwarePreset, getCurrentPresetNumber,
  to7Bit, from7Bit, SparkReader, describe, hex,
  getAmpName, BLE_WRITE_SIZE, DEFAULT_BLE_WRITE_SIZE,
} from "../web/spark-protocol.js";

const HEADER = "01 FE 00 00 53 FE 1A 00 00 00 00 00 00 00 00 00";

test("change hardware preset 1-4 matches known packets", () => {
  const expected = [
    `${HEADER} F0 01 01 00 01 38 00 00 00 F7`,
    `${HEADER} F0 01 01 01 01 38 00 00 01 F7`,
    `${HEADER} F0 01 01 02 01 38 00 00 02 F7`,
    `${HEADER} F0 01 01 03 01 38 00 00 03 F7`,
  ];
  for (let p = 1; p <= 4; p++) {
    const blocks = changeHardwarePreset(p, 1);
    assert.equal(blocks.length, 1);
    assert.equal(hex(blocks[0]), expected[p - 1]);
  }
});

test("get current preset number matches Ignitron hardcoded message", () => {
  const [block] = getCurrentPresetNumber(8);
  assert.equal(hex(block), "01 FE 00 00 53 FE 17 00 00 00 00 00 00 00 00 00 F0 01 08 00 02 10 F7");
});

test("7-bit encoding round-trips bytes with high bit set", () => {
  const data = [0x00, 0x80, 0xff, 0x7f, 0x01, 0xc3, 0x55, 0xaa, 0x90];
  const enc = to7Bit(data);
  assert.ok(enc.every((b) => b < 0x80));
  assert.deepEqual(enc.slice(0, 8), [0b0100110, 0x00, 0x00, 0x7f, 0x7f, 0x01, 0x43, 0x55]);
  assert.deepEqual(from7Bit(enc), data);
});

test("long messages are split into blocks of at most 173 bytes", () => {
  const blocks = buildMessage(0x01, 0x01, new Array(300).fill(0x41), 5);
  assert.ok(blocks.length > 1);
  for (const b of blocks) {
    assert.ok(b.length <= 0xad);
    assert.equal(b[6], b.length);
  }
});

test("reader decodes amp preset notification split across BLE packets", () => {
  // Amp -> app block (direction 41 FF) saying hardware preset 3 is active.
  const chunk = [0xf0, 0x01, 0x04, 0x02, 0x03, 0x38, 0x00, 0x00, 0x02, 0xf7];
  const block = [0x01, 0xfe, 0x00, 0x00, 0x41, 0xff, 16 + chunk.length, ...new Array(9).fill(0), ...chunk];
  const reader = new SparkReader();
  assert.deepEqual(reader.push(block.slice(0, 11)), []);
  const msgs = reader.push(block.slice(11));
  assert.equal(msgs.length, 1);
  assert.deepEqual(describe(msgs[0]), { type: "preset", preset: 3 });
});

test("reader reports ack", () => {
  const reader = new SparkReader();
  const block = [0x01, 0xfe, 0x00, 0x00, 0x41, 0xff, 23, ...new Array(9).fill(0), 0xf0, 0x01, 0x01, 0x00, 0x04, 0x38, 0xf7];
  const [msg] = reader.push(block);
  assert.deepEqual(describe(msg), { type: "ack", subCmd: 0x38 });
});

test("preset 128 selects the amp's temporary slot 0x7F", () => {
  // Ignitron sends this after a full tone so the amp actually plays what it received.
  const [block] = changeHardwarePreset(128, 1);
  assert.ok(hex(block).endsWith("01 38 00 00 7F F7"), hex(block)); // 7-bit high byte, then 00 7F
});

test("the amp is asked which model it is, and answers with its name", () => {
  const [block] = getAmpName(1);
  assert.ok(hex(block).endsWith("02 11 F7"), hex(block));
  // 03 11 comes back as: one byte, then 0xa0 + length, then the name.
  const name = "Spark MINI";
  const data = [0x00, 0xa0 + name.length, ...Array.from(name, (c) => c.charCodeAt(0))];
  assert.deepEqual(describe({ cmd: 0x03, subCmd: 0x11, data }), { type: "ampName", name });
});

test("a Spark MINI takes smaller BLE writes than a Spark 40", () => {
  // Ignitron's SparkDataControl::setAmpParameters: MINI and Spark 2 cap writes at 0x64.
  // A 0xAD block written whole to a MINI loses its tail and the tone never completes.
  assert.equal(BLE_WRITE_SIZE["Spark MINI"], 0x64);
  assert.equal(BLE_WRITE_SIZE["Spark 2"], 0x64);
  assert.equal(BLE_WRITE_SIZE["Spark 40"] ?? DEFAULT_BLE_WRITE_SIZE, 0xad);

  // Every block still splits into whole writes with nothing left over.
  const blocks = buildMessage(0x01, 0x01, new Array(400).fill(0x42), 1);
  for (const block of blocks) {
    let sent = 0;
    for (let pos = 0; pos < block.length; pos += 0x64) sent += block.subarray(pos, pos + 0x64).length;
    assert.equal(sent, block.length);
  }
});
