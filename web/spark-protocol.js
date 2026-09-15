// Spark amp BLE message encoder/decoder.
// Format derived from Ignitron (github.com/stangreg/Ignitron, BSD-3) src/SparkMessage.cpp
// and paulhamsh/Spark "Spark Protocol Description".

// Full 128-bit UUID strings: some iOS Web Bluetooth browsers don't accept 16-bit numeric aliases.
const uuid16 = (short) => `0000${short}-0000-1000-8000-00805f9b34fb`;
export const SPARK_SERVICE = uuid16("ffc0");
export const SPARK_WRITE_CHAR = uuid16("ffc1");
export const SPARK_NOTIFY_CHAR = uuid16("ffc2");

const MAX_CHUNK_SIZE_TO_SPARK = 0x80;
const MAX_BLOCK_SIZE_TO_SPARK = 0xad;
const BLOCK_HEADER_SIZE = 16;
const DIR_TO_SPARK = [0x53, 0xfe];

// Split 8-bit payload into chunks; multi-chunk messages get a (count, index, length) sub-header.
function splitToChunks(data) {
  const numChunks = Math.max(1, Math.ceil(data.length / MAX_CHUNK_SIZE_TO_SPARK));
  const chunks = [];
  for (let i = 0; i < numChunks; i++) {
    const part = data.slice(i * MAX_CHUNK_SIZE_TO_SPARK, (i + 1) * MAX_CHUNK_SIZE_TO_SPARK);
    chunks.push(numChunks > 1 ? [numChunks, i, part.length, ...part] : part);
  }
  return chunks;
}

// Every group of up to 7 bytes is prefixed by one byte holding their high bits.
export function to7Bit(bytes) {
  const out = [];
  for (let s = 0; s < bytes.length; s += 7) {
    const seq = bytes.slice(s, s + 7);
    let highBits = 0;
    seq.forEach((b, i) => { if (b & 0x80) highBits |= 1 << i; });
    out.push(highBits, ...seq.map((b) => b & 0x7f));
  }
  return out;
}

export function from7Bit(bytes) {
  const out = [];
  for (let s = 0; s < bytes.length; s += 8) {
    const highBits = bytes[s];
    bytes.slice(s + 1, s + 8).forEach((b, i) => {
      out.push(highBits & (1 << i) ? b | 0x80 : b);
    });
  }
  return out;
}

const xorChecksum = (bytes) => bytes.reduce((acc, b) => acc ^ b, 0);

// Build the list of BLE blocks (Uint8Array) to write to FFC1.
export function buildMessage(cmd, subCmd, payload = [], msgNum = 1) {
  const stream = [];
  for (const chunk of splitToChunks(payload)) {
    const data7 = to7Bit(chunk);
    stream.push(0xf0, 0x01, msgNum || 1, xorChecksum(data7), cmd, subCmd, ...data7, 0xf7);
  }

  const blocks = [];
  for (let pos = 0; pos < stream.length; ) {
    const take = Math.min(MAX_BLOCK_SIZE_TO_SPARK - BLOCK_HEADER_SIZE, stream.length - pos);
    const header = [0x01, 0xfe, 0x00, 0x00, ...DIR_TO_SPARK, take + BLOCK_HEADER_SIZE, ...new Array(9).fill(0)];
    blocks.push(Uint8Array.from([...header, ...stream.slice(pos, pos + take)]));
    pos += take;
  }
  return blocks;
}

// presetNumber: 1..4
export const changeHardwarePreset = (presetNumber, msgNum) =>
  buildMessage(0x01, 0x38, [0x00, presetNumber - 1], msgNum);

export const getCurrentPresetNumber = (msgNum) => buildMessage(0x02, 0x10, [], msgNum);

// Incremental parser for notifications from the amp (FFC2).
// Call push() with each notification; it returns decoded messages.
export class SparkReader {
  constructor() {
    this.blockBuf = [];
    this.chunkBuf = [];
    this.partial = null;
  }

  push(bytes) {
    this.blockBuf.push(...bytes);
    this.#extractBlocks();
    return this.#extractChunks();
  }

  #extractBlocks() {
    for (;;) {
      const buf = this.blockBuf;
      if (buf.length === 0) return;
      if (buf[0] !== 0x01 || (buf.length > 1 && buf[1] !== 0xfe)) {
        // Data without block header: pass it straight to the chunk parser.
        const next = buf.findIndex((b, i) => i > 0 && b === 0x01 && buf[i + 1] === 0xfe);
        const end = next === -1 ? buf.length : next;
        this.chunkBuf.push(...buf.splice(0, end));
        continue;
      }
      if (buf.length < BLOCK_HEADER_SIZE) return;
      const blockLen = buf[6];
      if (blockLen < BLOCK_HEADER_SIZE) { buf.splice(0, 2); continue; }
      if (buf.length < blockLen) return;
      const block = buf.splice(0, blockLen);
      this.chunkBuf.push(...block.slice(BLOCK_HEADER_SIZE));
    }
  }

  #extractChunks() {
    const messages = [];
    for (;;) {
      const buf = this.chunkBuf;
      const start = buf.findIndex((b, i) => b === 0xf0 && buf[i + 1] === 0x01);
      if (start === -1) { this.chunkBuf = buf.slice(-1); return messages; }
      // 7-bit data never contains 0xF7, so the first F7 ends the chunk.
      const end = buf.indexOf(0xf7, start + 6);
      if (end === -1) { this.chunkBuf = buf.slice(start); return messages; }
      const [, , msgNum, , cmd, subCmd] = buf.slice(start, start + 6);
      const data = from7Bit(buf.slice(start + 6, end));
      this.chunkBuf = buf.slice(end + 1);
      const joined = this.#joinMultiChunk(msgNum, cmd, subCmd, data);
      if (joined) messages.push({ msgNum, cmd, subCmd, data: joined });
    }
  }

  // Full tones (cmd 01/03, sub 01) are split over several chunks, each carrying a
  // (chunk count, chunk index, length) sub-header. Chunks must arrive in order and
  // belong to one message; anything else resets, so a dropped or interleaved chunk
  // can't be glued into a corrupt tone. Returns null until the last chunk.
  #joinMultiChunk(msgNum, cmd, subCmd, data) {
    const isToneChunk = (cmd === 0x01 || cmd === 0x03) && subCmd === 0x01
      && data.length > 3 && data[0] >= 1 && data[1] < data[0] && data[2] === data.length - 3;
    if (!isToneChunk) return data;
    const [count, index] = data;
    const body = data.slice(3);

    if (index === 0) {
      this.partial = { msgNum, count, next: 1, bytes: body };
    } else if (this.partial && this.partial.msgNum === msgNum
               && this.partial.count === count && this.partial.next === index) {
      this.partial.bytes.push(...body);
      this.partial.next = index + 1;
    } else {
      this.partial = null; // out of order or from another message: wait for a fresh chunk 0
      return null;
    }

    if (index !== count - 1) return null;
    const complete = this.partial.bytes;
    this.partial = null;
    return complete;
  }
}

// Interpret a decoded message. Returns { type, ... } or null.
export function describe(msg) {
  const { cmd, subCmd, data } = msg;
  if ((cmd === 0x03 && (subCmd === 0x38 || subCmd === 0x10)) || (cmd === 0x01 && subCmd === 0x38)) {
    // payload: 0x00, preset index 0..3 (0x7f/0x80+ = unsaved/custom tone)
    const index = data[1];
    return { type: "preset", preset: index !== undefined && index < 4 ? index + 1 : null };
  }
  if ((cmd === 0x01 || cmd === 0x03) && subCmd === 0x01) return { type: "tone", data };
  if (cmd === 0x04) return { type: "ack", subCmd };
  return null;
}

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
