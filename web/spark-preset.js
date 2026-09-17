// Full-tone (preset) encoding/decoding and tone-parameter commands.
// Layout ported from Ignitron (BSD-3): SparkMessage::buildPresetData and
// SparkStreamReader::readPreset. Tone JSON is Ignitron-compatible.

import { buildMessage } from "./spark-protocol.js";

export const PEDAL_COUNT = 7; // gate, comp, drive, amp, mod, delay, reverb
export const AMP_SLOT = 3;

// Amp block parameter indices (same for every amp model).
export const AMP_PARAM = { gain: 0, treble: 1, mid: 2, bass: 3, master: 4 };
export const SLOT_LABELS = ["Noise Gate", "Compressor", "Drive", "Amp", "Modulation", "Delay", "Reverb"];

// ---------- value encoding ----------

const encString = (str) => (str.length > 31
  ? [0xd9, str.length, ...strBytes(str)]
  : [0xa0 + str.length, ...strBytes(str)]);

const encLongString = (str) => [0xd9, str.length, ...strBytes(str)];

const strBytes = (str) => Array.from(str, (c) => c.charCodeAt(0) & 0xff);

function encFloat(value) {
  const rounded = Math.round(value * 10000) / 10000;
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, rounded, false); // big-endian, as Spark expects
  return [0xca, ...new Uint8Array(view.buffer)];
}

const encOnOff = (on) => [on ? 0xc3 : 0xc2];

// Prefixed string used by the parameter/effect commands: length, 0xa0+length, chars
const encPrefixedString = (str) => [str.length, 0xa0 + str.length, ...strBytes(str)];

// ---------- value decoding ----------

class Cursor {
  constructor(data) { this.data = data; this.pos = 0; }
  byte() { return this.data[this.pos++]; }
  string() {
    let tag = this.byte();
    let len;
    if (tag === 0xd9) len = this.byte();
    else if (tag >= 0xa0) len = tag - 0xa0;
    else len = this.byte() - 0xa0; // prefixed form: length byte came first
    let out = "";
    for (let i = 0; i < len; i++) out += String.fromCharCode(this.byte());
    return out;
  }
  float() {
    this.byte(); // 0xca tag
    const view = new DataView(new ArrayBuffer(4));
    for (let i = 0; i < 4; i++) view.setUint8(i, this.byte());
    return view.getFloat32(0, false);
  }
  onOff() { return this.byte() === 0xc3; }
}

// ---------- preset (tone) ----------

// tone: { uuid, name, version, description, icon, bpm, pedals: [{name, isOn, parameters: [num]}] }
export function encodePreset(tone, msgNum = 1) {
  const data = [0x00, 0x7f]; // 0x7f = temporary slot, so the amp's 4 saved presets stay intact
  data.push(...encLongString(tone.uuid ?? crypto.randomUUID().toUpperCase()));
  data.push(...encString(tone.name ?? "Tone"));
  data.push(...encString(tone.version ?? "0.7"));
  data.push(...encString(tone.description ?? ""));
  data.push(...encString(tone.icon ?? "icon.png"));
  data.push(...encFloat(tone.bpm ?? 120));
  data.push(0x90 + PEDAL_COUNT);
  for (let i = 0; i < PEDAL_COUNT; i++) {
    const pedal = tone.pedals[i];
    data.push(...encString(pedal.name));
    data.push(...encOnOff(pedal.isOn));
    data.push(0x90 + pedal.parameters.length);
    pedal.parameters.forEach((value, p) => {
      data.push(p, 0x91, ...encFloat(value));
    });
  }
  // Checksum covers everything after the 2 header bytes.
  const body = data.slice(2);
  data.push(body.reduce((sum, b) => (sum + b) & 0xff, 0));
  return buildMessage(0x01, 0x01, data, msgNum);
}

// A tone payload must at least hold its header, 6 short fields and 7 pedals.
const PRINTABLE = /^[\x20-\x7e]*$/;

export function decodePreset(data) {
  if (data.length < 40) throw new Error(`tone too short (${data.length} bytes)`);
  const c = new Cursor(data);
  c.byte();
  const presetNumber = c.byte();
  const tone = {
    presetNumber,
    uuid: c.string(),
    name: c.string(),
    version: c.string(),
    description: c.string(),
    icon: c.string(),
    bpm: Math.round(c.float() * 100) / 100,
    pedals: [],
  };
  c.byte(); // pedal count tag (0x90 + 7)
  for (let i = 0; i < PEDAL_COUNT; i++) {
    const name = c.string();
    const isOn = c.onOff();
    const paramCount = c.byte() - 0x90;
    const parameters = [];
    for (let p = 0; p < paramCount; p++) {
      c.byte(); // parameter index
      c.byte(); // 0x91 tag
      parameters.push(Math.round(c.float() * 10000) / 10000);
    }
    if (!name || !PRINTABLE.test(name)) throw new Error(`bad effect name in slot ${i}`);
    tone.pedals.push({ name, isOn, parameters });
  }
  if (!tone.name || !PRINTABLE.test(tone.name)) throw new Error("bad tone name");
  if (!PRINTABLE.test(tone.uuid)) throw new Error("bad tone id");
  return tone;
}

// ---------- commands ----------

// hwPreset: 0..3 for a stored preset, -1 for whatever is currently loaded
export const getCurrentPreset = (hwPreset = -1, msgNum) =>
  buildMessage(0x02, 0x01, hwPreset === -1 ? [0x01, 0x00] : [0x00, hwPreset], msgNum);

// Change one knob of one effect, e.g. ("Twin", AMP_PARAM.master, 0.7)
export const changeEffectParameter = (effectName, param, value, msgNum) =>
  buildMessage(0x01, 0x04, [...encPrefixedString(effectName), param, ...encFloat(value)], msgNum);

// Swap the effect in a slot, e.g. ("Booster", "Fuzz"). The amp loads that effect's own settings.
export const changeEffect = (oldName, newName, msgNum) =>
  buildMessage(0x01, 0x06, [...encPrefixedString(oldName), ...encPrefixedString(newName)], msgNum);

export const turnEffectOnOff = (effectName, on, msgNum) =>
  buildMessage(0x01, 0x15, [...encPrefixedString(effectName), ...encOnOff(on), 0x00], msgNum);

// ---------- the amp's echo of an edit ----------
// Same layout as the commands above, with a trailing byte we don't need.

export function decodeEffectParameter(data) {
  const c = new Cursor(data);
  return { effect: c.string(), param: c.byte(), value: Math.round(c.float() * 10000) / 10000 };
}

export function decodeEffectOnOff(data) {
  const c = new Cursor(data);
  return { effect: c.string(), isOn: c.onOff() };
}

export function decodeEffectSwap(data) {
  const c = new Cursor(data);
  return { from: c.string(), to: c.string() };
}

export const internals = { encString, encFloat, encPrefixedString, Cursor };
