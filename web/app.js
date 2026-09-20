import {
  SPARK_SERVICE, SPARK_WRITE_CHAR, SPARK_NOTIFY_CHAR,
  changeHardwarePreset, getCurrentPresetNumber, getAmpName, SparkReader, describe, hex,
  BLE_WRITE_SIZE, DEFAULT_BLE_WRITE_SIZE,
} from "./spark-protocol.js?v=17";
import {
  encodePreset, decodePreset, getCurrentPreset, changeEffectParameter, turnEffectOnOff, changeEffect,
  decodeEffectParameter, decodeEffectOnOff, decodeEffectSwap,
  AMP_PARAM, AMP_SLOT, SLOT_LABELS,
} from "./spark-preset.js?v=17";
import * as library from "./library.js?v=17";
import { FX_BY_SLOT, fxInfo, paramLabel, displayName } from "./fx-catalog.js?v=17";
import { randomTone, MIN_MASTER } from "./random-tone.js?v=17";
import { runSelfTest, verdict } from "./selftest.js?v=17";

const APP_VERSION = "v17";
const ACK_TIMEOUT_MS = 700;
const RECONNECT_DELAYS_MS = [500, 1500, 4000];
const SLIDER_SEND_MS = 60; // don't flood the BLE connection while dragging

// Keyboard map, by KeyboardEvent.code so it works regardless of layout.
const KEYMAP = {
  Digit1: { slot: 1 }, Numpad1: { slot: 1 },
  Digit2: { slot: 2 }, Numpad2: { slot: 2 },
  Digit3: { slot: 3 }, Numpad3: { slot: 3 },
  Digit4: { slot: 4 }, Numpad4: { slot: 4 },
  Digit5: { slot: 5 }, Numpad5: { slot: 5 },
  Digit6: { slot: 6 }, Numpad6: { slot: 6 },
  Digit7: { slot: 7 }, Numpad7: { slot: 7 },
  Digit8: { slot: 8 }, Numpad8: { slot: 8 },
  KeyR: { random: true },
  ArrowLeft: { step: -1 }, ArrowUp: { step: -1 }, PageUp: { step: -1 },
  ArrowRight: { step: 1 }, ArrowDown: { step: 1 }, PageDown: { step: 1 },
  BracketLeft: { bank: -1 }, BracketRight: { bank: 1 },
  Minus: { volume: -0.05 }, NumpadSubtract: { volume: -0.05 },
  Equal: { volume: 0.05 }, NumpadAdd: { volume: 0.05 },
  Digit0: { revert: true }, Numpad0: { revert: true },
};

const CONNECT_HINTS = {
  NotFoundError: "No amp chosen. If the list was empty: close the page on other devices (e.g. Mac Chrome), forget \"Spark 40 BLE\" in iPhone Settings → Bluetooth, power-cycle the amp, then try \"Show all devices\".",
  SecurityError: "Bluetooth is blocked. Open the page over https:// in Bluefy, and allow Bluetooth for Bluefy in iPhone Settings → Bluefy.",
  NotAllowedError: "Bluetooth permission denied. Allow Bluetooth for Bluefy in iPhone Settings → Bluefy.",
  NetworkError: "The amp refused the connection – usually another app or device is already connected to it. Close the Spark app / other pages, power-cycle the amp and retry.",
  NotSupportedError: "The amp didn't expose the Spark control service. Tap \"Show all devices\" and pick the entry ending in \"BLE\" (not \"Audio\").",
};

const $ = (id) => document.getElementById(id);
const ui = {
  connect: $("connect"), connectAll: $("connect-all"),
  status: $("status"), statusText: $("status-text"),
  hint: $("hint"), unsupported: $("unsupported"),
  slots: [...document.querySelectorAll(".preset")],
  bankRow: $("bank-row"), bankLabel: $("bank-label"), random: $("random"),
  bankPrev: $("bank-prev"), bankNext: $("bank-next"),
  tonePanel: $("tone-panel"), toneName: $("tone-name"), revert: $("revert"),
  sliders: $("sliders"), effects: $("effects"),
  libCount: $("lib-count"), libList: $("lib-list"),
  saveTone: $("save-tone"), copyPresets: $("copy-presets"),
  selfTest: $("self-test"), testResults: $("test-results"), importFile: $("import-file"), exportLib: $("export-lib"),
  includePaid: $("include-paid"),
  log: $("log"), copyLog: $("copy-log"), version: $("version"),
  update: $("update"), updateNow: $("update-now"),
};

const state = {
  device: null, writeChar: null, connected: false, userDisconnected: false,
  activeSlot: null, pendingSlot: null, // 1–4 = the amp's presets, 5–8 = the current bank of my tones
  randomCount: 0, preRandom: null, lastRandom: 0,
  bank: 0,
  tones: library.load(),
  tone: null, // the tone currently loaded on the amp, as reported by it
  baseline: null, // that tone as first loaded, for "undo my changes"
  msgNum: 0, ackTimer: null, wakeLock: null, sliderTimer: null, lastToneRequest: 0,
  pendingTone: null, activateTimer: null,
  ampName: null, bleWriteSize: DEFAULT_BLE_WRITE_SIZE, toneWaiter: null,
  ackWaiters: [], ampNameWaiter: null, testing: false,
  pendingEdits: new Map(), echoWaiters: new Map(), adoptTimer: null, decodeRetries: 0,
  inspecting: false,
  openSlots: new Set(),
};

const reader = new SparkReader();
let writeQueue = Promise.resolve();

// ---------- plumbing ----------

function log(text) {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  ui.log.textContent = `${time}  ${text}\n` + ui.log.textContent.split("\n").slice(0, 60).join("\n");
}

function setStatus(kind, text) {
  ui.status.dataset.state = kind;
  ui.statusText.textContent = text;
  ui.connect.textContent = kind === "connected" || kind === "connecting" ? "Disconnect" : "Connect to Spark";
}

const showHint = (text) => { ui.hint.textContent = text ?? ""; ui.hint.hidden = !text; };

// Which Spark we're talking to. Only the BLE write size differs — a Spark MINI or
// Spark 2 accepts 0x64 bytes per write, so a 0xAD block sent whole loses its tail and
// the tone never completes. Everything else (tone format, commands) is the same.
function setAmpModel(name) {
  if (!name) return;
  state.ampName = name;
  state.bleWriteSize = BLE_WRITE_SIZE[name] ?? DEFAULT_BLE_WRITE_SIZE;
  log(`← amp: ${name} (${state.bleWriteSize} bytes per write)`);
  if (state.connected) setStatus("connected", `Connected: ${name}`);
}

const nextMsgNum = () => (state.msgNum = (state.msgNum % 0x7f) + 1);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Gap between the blocks of one tone. Ignitron's BLE code notes the same thing:
// "Delay seems to be required in order to not lose any packages."
const BLOCK_GAP_MS = 30;

// GATT operations must not overlap, so all writes go through one queue.
//
// Single-block commands (preset change, one knob, one effect) go out fast, with no
// response — they have always worked. A whole tone is 3–4 blocks, and those must not
// use writeValueWithoutResponse: it has no flow control, so the amp drops the tail of
// the burst. It then acks only the chunks it received and never sends the final 04 01,
// which is why sent tones — random tones and My tones alike — appeared to do nothing.
function send(blocks, label, { paced = blocks.length > 1 } = {}) {
  if (!state.writeChar) return Promise.resolve();
  writeQueue = writeQueue.then(async () => {
    const props = state.writeChar.properties ?? {};
    const fast = !paced && props.writeWithoutResponse && state.writeChar.writeValueWithoutResponse;
    const write = async (part) => {
      if (fast) await state.writeChar.writeValueWithoutResponse(part);
      else if (props.write) await state.writeChar.writeValue(part);
      else await state.writeChar.writeValueWithoutResponse(part);
    };
    for (const [i, block] of blocks.entries()) {
      if (blocks.length <= 2) log(`→ ${label}: ${hex(block)}`);
      // A Spark MINI or Spark 2 only accepts 0x64 bytes per write, a Spark 40 the whole
      // 0xAD block. Splitting further is transport-level: the block itself is unchanged.
      for (let pos = 0; pos < block.length; pos += state.bleWriteSize) {
        await write(block.subarray(pos, pos + state.bleWriteSize));
      }
      if (paced && i < blocks.length - 1) await sleep(BLOCK_GAP_MS);
    }
    if (blocks.length > 2) log(`→ ${label}: ${blocks.length} blocks, ${blocks.chunks} chunks`);
  }).catch((err) => {
    log(`write failed: ${err.message}`);
    if (state.pendingTone) state.pendingTone.writeFailed = true;
  });
  return writeQueue;
}

// ---------- verify what we send ----------
//
// The amp acks a preset change and a whole tone, but never a knob or an effect switch.
// It does echo them back though — 03 37 for a parameter, 03 15 for on/off, 03 06 for a
// model swap — and that echo is the only confirmation those commands ever get. Each send
// records what it expects; the echo clears it. Whatever is left after CONFIRM_MS never
// landed, and its row says so instead of just sounding wrong.

const CONFIRM_MS = 1500;

const editKey = {
  param: (effect, param) => `param:${effect}:${param}`,
  onOff: (effect) => `onoff:${effect}`,
  model: (effect) => `model:${effect}`,
};

const rowFor = (key) =>
  [...document.querySelectorAll("[data-verify]")].find((el) => el.dataset.verify === key) ?? null;

function expectEcho(key, detail, sent) {
  const open = state.pendingEdits.get(key);
  if (open) clearTimeout(open.timer);
  rowFor(key)?.classList.remove("unconfirmed");
  state.pendingEdits.set(key, {
    detail, sent,
    timer: setTimeout(() => {
      state.pendingEdits.delete(key);
      const effect = key.split(":")[1];
      log(`⚠ ${detail} — the amp never confirmed this.`
        + ` Does this amp have "${effect}"? A Spark 40 and a MINI don't ship the same models.`);
      rowFor(key)?.classList.add("unconfirmed");
    }, CONFIRM_MS),
  });
}

// Returns the expectation this echo answers, or null when nobody asked for it — which
// means the change was made on the amp itself, not by us.
function echoArrived(key, value) {
  state.echoWaiters.get(key)?.(value);
  const open = state.pendingEdits.get(key);
  if (!open) return null;
  clearTimeout(open.timer);
  state.pendingEdits.delete(key);
  rowFor(key)?.classList.remove("unconfirmed");
  return open;
}

// A Spark 40 confirms an edit with a plain ack (04 04 for a knob, 04 15 for an effect
// switch, 04 06 for a model swap) where a MINI echoes the whole change back (03 37, 03 15,
// 03 06). An ack carries no effect name, so it clears the oldest outstanding edit of its
// kind — edits go out one at a time, so that is the one it belongs to.
const ACK_CONFIRMS = { 0x04: "param:", 0x15: "onoff:", 0x06: "model:" };

function ackConfirms(subCmd) {
  const prefix = ACK_CONFIRMS[subCmd];
  if (!prefix) return;
  for (const [key, open] of state.pendingEdits) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(open.timer);
    state.pendingEdits.delete(key);
    rowFor(key)?.classList.remove("unconfirmed");
    state.echoWaiters.get(key)?.(open.sent);
    return;
  }
}

// For the self-test: send, then wait for the amp's echo of that exact change.
function awaitEcho(key, ms = 2500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { state.echoWaiters.delete(key); resolve(null); }, ms);
    state.echoWaiters.set(key, (value) => {
      clearTimeout(timer);
      state.echoWaiters.delete(key);
      resolve(value);
    });
  });
}

// ---------- tone selection ----------

const AMP_SLOTS = 4;
const TOTAL_SLOTS = 8;

// Slots 1–4 are the amp's own presets; 5–8 are the current bank of my tones.
const slotTone = (n) => library.bankSlots(state.tones, state.bank)[n - AMP_SLOTS - 1];
const isAmpSlot = (n) => n <= AMP_SLOTS;

function selectSlot(n) {
  if (!state.connected) return;
  if (isAmpSlot(n)) {
    state.preRandom = null;
    state.pendingSlot = n;
    render();
    send(changeHardwarePreset(n, nextMsgNum()), `preset ${n}`);
    // Ask for the tone straight away instead of waiting for the amp to announce the change.
    requestTone();
    ui.toneName.textContent = "loading…";
  } else {
    const tone = slotTone(n);
    if (!tone) return;
    state.preRandom = null; // loading a real tone ends the random audition
    state.pendingSlot = n;
    render();
    sendTone(tone, `tone "${tone.name}"`);
    setTone(structuredClone(tone)); // shown immediately; the amp confirms afterwards
  }
  clearTimeout(state.ackTimer);
  state.ackTimer = setTimeout(() => confirmSlot(n), ACK_TIMEOUT_MS);
}

// A tone we send lands in the amp's temporary slot 0x7F. The amp stores it but keeps
// playing the preset it was on until it is told to select that slot — same two-step
// sequence Ignitron uses (send preset, then on the final ack select preset 128 = 0x7F).
const TEMP_PRESET = 128;

const TONE_ACK_TIMEOUT_MS = 1500;

function sendTone(tone, label, tries = 0) {
  const blocks = encodePreset(tone, nextMsgNum());
  state.pendingTone = { tone, label, tries, chunks: blocks.chunks, acked: 0 };
  send(blocks, label);
  clearTimeout(state.activateTimer);
  state.activateTimer = setTimeout(toneTimedOut, TONE_ACK_TIMEOUT_MS);
}

// The amp acks each chunk it accepted with 05 01, then the whole tone with 04 01.
const noteChunkAck = () => { if (state.pendingTone) state.pendingTone.acked++; };

function activateSentTone() {
  if (!state.pendingTone) return;
  state.pendingTone = null;
  clearTimeout(state.activateTimer);
  activateTemp();
}

function activateTemp() {
  send(changeHardwarePreset(TEMP_PRESET, nextMsgNum()), "play sent tone");
  checkWhatLoaded();
}

// After loading a tone, ask the amp what it actually ended up with.
//
// A knob command names the effect it applies to, so being wrong about the amp's gear means
// every later edit is silently ignored — which is exactly what happened sending a Spark 40
// tone using "Plexi" to a Spark MINI, which has no such model. The amp accepted the tone,
// loaded something else, and then ignored every volume change addressed to Plexi.
//
// The read is only trusted when the amp comes back with the tone we sent, by name. If it
// answers with something else it is telling us about its stored preset, and adopting that
// would throw away the tone being listened to.
function checkWhatLoaded() {
  clearTimeout(state.adoptTimer);
  state.adoptTimer = setTimeout(async () => {
    if (state.testing) return; // the self-test does its own reading
    const sent = state.tone;
    if (!sent) return;
    state.inspecting = true;
    const loaded = await readTone("what is the amp on?");
    state.inspecting = false;
    if (!loaded) return;
    if (loaded.name !== sent.name) {
      log(`⚠ editing "${sent.name}" but the amp reports "${loaded.name}" – not adopting`);
      return;
    }
    const missing = loaded.pedals
      .map((p, i) => (sent.pedals[i] && p.name !== sent.pedals[i].name ? sent.pedals[i].name : null))
      .filter(Boolean);
    if (missing.length) {
      log(`⚠ this amp has no ${missing.join(", ")} – editing what it loaded instead`);
      showHint(`${state.ampName ?? "This amp"} doesn't have ${missing.join(", ")}.`
        + " It substituted its own gear, and the sliders now follow that.");
    }
    setTone(loaded); // what the amp has is what we edit
  }, 700);
}

// No final ack. If chunks went missing the tone is half-written and must be sent again —
// that silent failure is what made sent tones look like no-ops. But if every chunk was
// acked the tone *is* on the amp and only the ack is late (a MINI is slower, since its
// blocks go out in 100-byte writes), so play it rather than sending the whole thing twice.
function toneTimedOut() {
  const pending = state.pendingTone;
  if (!pending) return;
  state.pendingTone = null;
  if (pending.acked >= pending.chunks) {
    log(`${pending.label}: all ${pending.chunks} chunks arrived, final ack was late – playing it`);
    activateTemp();
    return;
  }
  log(`${pending.label}: only ${pending.acked}/${pending.chunks} chunks confirmed`);
  if (pending.tries < 1) {
    sendTone(pending.tone, `${pending.label} (resend)`, pending.tries + 1);
    return;
  }
  // Selecting the temp slot now would play whatever fragment the amp kept. Leave the amp
  // on the tone it already has and say so.
  log(`${pending.label}: gave up – the amp never got the whole tone, so it was not played`);
  showHint(pending.writeFailed
    ? "Bluetooth refused a write. Move closer to the amp, or reconnect, and try again."
    : "The tone didn't reach the amp in one piece, so it wasn't played. Try again.");
}

function sendRandomTone() {
  if (!state.connected) return;
  // Full tones are several BLE blocks each; don't flood the amp on a fast key repeat.
  if (Date.now() - state.lastRandom < 250) return;
  state.lastRandom = Date.now();
  // Keep the first real tone, so Undo goes back to it however many randoms you audition.
  if (!state.preRandom) state.preRandom = state.tone ? structuredClone(state.tone) : null;
  const before = state.tone?.pedals?.[AMP_SLOT]?.parameters?.[AMP_PARAM.master];
  const tone = randomTone(state.tone, ++state.randomCount, { includePaid: ui.includePaid.checked });
  if (before !== undefined && before < MIN_MASTER) {
    log(`volume was ${Math.round(before * 100)}% – raised to ${Math.round(MIN_MASTER * 100)}% so the random tone is audible`);
  }
  state.activeSlot = null;
  state.pendingSlot = null;
  sendTone(tone, `random "${tone.name}"`);
  setTone(tone);
  render();
  log(`random tone: ${tone.pedals.filter((p) => p.isOn).map((p) => displayName(p.name, p.parameters)).join(" + ")}`);
}

// Hardware presets live in the amp, so a Spark 40's four presets are not on a Spark MINI.
// Reading them into My tones makes them portable: from there they are sent over BLE and
// play on any Spark, and Export writes them to a file.
function awaitTone(ms = 2500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { state.toneWaiter = null; resolve(null); }, ms);
    state.toneWaiter = (tone) => { clearTimeout(timer); state.toneWaiter = null; resolve(tone); };
  });
}

// The amp acks some commands and ignores others; these let a caller wait for the ones it does.
function awaitAck(subCmd, ms = 3000) {
  return new Promise((resolve) => {
    const waiter = { subCmd, resolve };
    waiter.timer = setTimeout(() => {
      state.ackWaiters = state.ackWaiters.filter((w) => w !== waiter);
      resolve(false);
    }, ms);
    state.ackWaiters.push(waiter);
  });
}

function settleAck(subCmd) {
  state.ackWaiters = state.ackWaiters.filter((waiter) => {
    if (waiter.subCmd !== subCmd) return true;
    clearTimeout(waiter.timer);
    waiter.resolve(true);
    return false;
  });
}

function awaitAmpName(ms = 2500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { state.ampNameWaiter = null; resolve(null); }, ms);
    state.ampNameWaiter = (name) => { clearTimeout(timer); state.ampNameWaiter = null; resolve(name); };
  });
}

// Ask for the tone and wait for it, ignoring the throttle that stops ordinary edits
// from bouncing back to the amp's stored preset.
function readTone(label) {
  state.lastToneRequest = 0;
  const arriving = awaitTone();
  requestTone(label);
  return arriving;
}

// Like sendTone, but reports what the amp confirmed instead of quietly resending.
async function sendToneChecked(tone, label) {
  const blocks = encodePreset(tone, nextMsgNum());
  const pending = { tone, label, tries: 1, chunks: blocks.chunks, acked: 0 };
  state.pendingTone = pending;
  clearTimeout(state.activateTimer);
  state.activateTimer = setTimeout(toneTimedOut, TONE_ACK_TIMEOUT_MS);
  const acked = awaitAck(0x01);
  send(blocks, label);
  return { ok: await acked, acked: pending.acked, chunks: pending.chunks };
}

// What runSelfTest drives. Everything it needs, nothing about the page.
const ampUnderTest = {
  writeSize: () => state.bleWriteSize,
  pause: sleep,
  readAmpName: () => {
    const arriving = awaitAmpName();
    send(getAmpName(nextMsgNum()), "get amp name");
    return arriving;
  },
  readTone,
  changePreset: (n) => {
    const acked = awaitAck(0x38);
    send(changeHardwarePreset(n, nextMsgNum()), `preset ${n}`);
    return acked;
  },
  sendTone: sendToneChecked,
  // Both return what the amp echoed back, or null if it never answered.
  setParameter: (effect, param, value) => {
    const key = editKey.param(effect, param);
    const echo = awaitEcho(key);
    const detail = `${effect} p${param}=${value.toFixed(2)}`;
    send(changeEffectParameter(effect, param, value, nextMsgNum()), detail);
    expectEcho(key, detail, value);
    return echo;
  },
  setEffect: (effect, on) => {
    const key = editKey.onOff(effect);
    const echo = awaitEcho(key);
    const detail = `${effect} ${on ? "on" : "off"}`;
    send(turnEffectOnOff(effect, on, nextMsgNum()), detail);
    expectEcho(key, detail, on);
    return echo;
  },
};

async function selfTest() {
  if (!state.connected || state.testing) return;
  state.testing = true;
  ui.selfTest.disabled = true;
  ui.testResults.hidden = false;
  ui.testResults.innerHTML = "<li>Testing…</li>";
  const rows = [];
  const draw = () => { ui.testResults.innerHTML = rows.join(""); };

  try {
    const steps = await runSelfTest(ampUnderTest, (step) => {
      const mark = step.ok === null ? "–" : step.ok ? "✓" : "✗";
      const kind = step.ok === null ? "skip" : step.ok ? "pass" : "fail";
      rows.push(`<li class="${kind}"><b>${mark} ${escapeHtml(step.name)}</b>`
        + `<span>${escapeHtml(step.detail)}</span></li>`);
      draw();
    });
    rows.push(`<li class="verdict">${escapeHtml(verdict(steps))}</li>`);
    draw();
    // The test moved the amp around; show whatever it ended on.
    setTone(await readTone("read tone") ?? state.tone);
  } catch (err) {
    rows.push(`<li class="fail"><b>✗ Test stopped</b><span>${escapeHtml(err.message)}</span></li>`);
    draw();
  } finally {
    state.testing = false;
    ui.selfTest.disabled = false;
    render();
  }
}

async function copyAmpPresets() {
  if (!state.connected) return;
  const from = state.ampName ?? "amp";
  ui.copyPresets.disabled = true;
  let copied = 0;
  for (let n = 1; n <= AMP_SLOTS; n++) {
    send(changeHardwarePreset(n, nextMsgNum()), `preset ${n}`);
    state.lastToneRequest = 0; // this walk asks for every preset in turn
    const arriving = awaitTone();
    requestTone(`read preset ${n}`);
    const tone = await arriving;
    if (!tone) { log(`preset ${n}: no answer – skipped`); continue; }
    const { presetNumber, ...rest } = tone;
    state.tones.push({
      ...structuredClone(rest),
      uuid: crypto.randomUUID().toUpperCase(),
      description: `${from} preset ${n}`,
    });
    copied++;
    log(`copied preset ${n}: "${tone.name}"`);
  }
  ui.copyPresets.disabled = false;
  if (!copied) { showHint("Couldn't read the amp's presets – try again once it's settled."); return; }
  if (!library.save(state.tones)) showHint("Saved for this session only – browser storage is unavailable.");
  state.bank = library.bankCount(state.tones) - 1;
  state.preRandom = null;
  render();
  showHint(`Copied ${copied} preset(s) from ${from} into My tones. They now play on any Spark amp.`);
}

function confirmSlot(n) {
  if (n === null || state.pendingSlot !== n) return;
  state.activeSlot = n;
  state.pendingSlot = null;
  render();
}

// Arrow keys scroll through all 8 slots, skipping empty ones.
function stepSlot(step) {
  let n = state.pendingSlot ?? state.activeSlot ?? 1;
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    n = ((n - 1 + step + TOTAL_SLOTS) % TOTAL_SLOTS) + 1;
    if (isAmpSlot(n) || slotTone(n)) return selectSlot(n);
  }
}

function stepBank(step) {
  const count = library.bankCount(state.tones);
  state.bank = (state.bank + step + count) % count;
  render();
}

// ---------- tone parameters (volume / EQ / effects) ----------

// The amp only reports its *stored* preset, so asking for the tone after an edit would
// overwrite what's actually playing. Only ask when the amp itself changed preset.
function requestTone(reason = "get tone") {
  const now = Date.now();
  if (now - state.lastToneRequest < 1500) return;
  state.lastToneRequest = now;
  send(getCurrentPreset(-1, nextMsgNum()), reason);
}

function setTone(tone, { keepBaseline = false } = {}) {
  state.tone = tone;
  if (!keepBaseline) state.baseline = structuredClone(tone);
  renderTone();
}

// Undo every change made since the tone was loaded, sending only what actually differs.
function revertTone() {
  if (state.preRandom) {
    const previous = state.preRandom;
    state.preRandom = null;
    sendTone(previous, `back to "${previous.name}"`);
    setTone(structuredClone(previous));
    log(`back to "${previous.name}"`);
    return;
  }
  const base = state.baseline;
  const tone = state.tone;
  if (!base || !tone) return;
  let changes = 0;
  base.pedals.forEach((basePedal, i) => {
    const pedal = tone.pedals[i];
    if (pedal.name !== basePedal.name) {
      send(changeEffect(pedal.name, basePedal.name, nextMsgNum()), `${SLOT_LABELS[i]} → ${basePedal.name}`);
      changes++;
    }
    basePedal.parameters.forEach((value, p) => {
      if (pedal.parameters[p] !== value) {
        send(changeEffectParameter(basePedal.name, p, value, nextMsgNum()), `${basePedal.name} p${p}=${value.toFixed(2)}`);
        changes++;
      }
    });
    if (pedal.isOn !== basePedal.isOn) {
      send(turnEffectOnOff(basePedal.name, basePedal.isOn, nextMsgNum()), `${basePedal.name} ${basePedal.isOn ? "on" : "off"}`);
      changes++;
    }
  });
  state.tone = structuredClone(base);
  renderTone();
  log(changes ? `reverted ${changes} change(s)` : "nothing to revert");
}

function swapEffect(slotIndex, newName) {
  const pedal = state.tone?.pedals?.[slotIndex];
  if (!pedal || pedal.name === newName) return;
  send(changeEffect(pedal.name, newName, nextMsgNum()), `${SLOT_LABELS[slotIndex]} → ${newName}`);
  expectEcho(editKey.model(newName), `${SLOT_LABELS[slotIndex]} → ${newName}`, newName);

  // The amp gives the new effect its own settings. Rather than re-reading the tone
  // (the amp would answer with its stored preset and undo the edits), keep the knob
  // values we had where they line up and push them to the amp.
  const info = fxInfo(newName);
  const count = info?.params?.length ?? pedal.parameters.length;
  const previous = pedal.parameters;
  pedal.name = newName;
  pedal.parameters = Array.from({ length: count }, (_, p) => {
    if (info?.selector === p) return previous[p] ?? 0;
    return previous[p] ?? 0.5;
  });
  pedal.parameters.forEach((value, p) => {
    send(changeEffectParameter(newName, p, value, nextMsgNum()), `${newName} p${p}=${value.toFixed(2)}`);
  });
  renderTone();
}

const ampPedal = () => state.tone?.pedals?.[AMP_SLOT] ?? null;

function sendParameter(slotIndex, param, value) {
  const pedal = state.tone?.pedals?.[slotIndex];
  if (!pedal) return;
  pedal.parameters[param] = value;
  clearTimeout(state.sliderTimer);
  state.sliderTimer = setTimeout(() => {
    const detail = `${pedal.name} p${param}=${value.toFixed(2)}`;
    send(changeEffectParameter(pedal.name, param, value, nextMsgNum()), detail);
    expectEcho(editKey.param(pedal.name, param), detail, value);
  }, SLIDER_SEND_MS);
}

// The echo carries the value the amp actually set, which is the truth. Take it, but don't
// redraw a knob: the slider may still be under a finger.
function adoptAmpValue(effect, param, value) {
  const pedal = state.tone?.pedals?.find((p) => p.name === effect);
  if (!pedal || pedal.parameters[param] === undefined) return;
  pedal.parameters[param] = value;
}

// An on/off that differs from ours was made on the amp itself, so show it.
function adoptAmpOnOff(effect, isOn) {
  const pedal = state.tone?.pedals?.find((p) => p.name === effect);
  if (!pedal || pedal.isOn === isOn) return;
  pedal.isOn = isOn;
  renderTone();
}

function nudgeVolume(delta) {
  const pedal = ampPedal();
  if (!pedal || pedal.parameters[AMP_PARAM.master] === undefined) return;
  const value = Math.min(1, Math.max(0, pedal.parameters[AMP_PARAM.master] + delta));
  sendParameter(AMP_SLOT, AMP_PARAM.master, value);
  renderTone();
}

function toggleEffect(slotIndex) {
  const pedal = state.tone?.pedals?.[slotIndex];
  if (!pedal) return;
  pedal.isOn = !pedal.isOn;
  const detail = `${pedal.name} ${pedal.isOn ? "on" : "off"}`;
  send(turnEffectOnOff(pedal.name, pedal.isOn, nextMsgNum()), detail);
  expectEcho(editKey.onOff(pedal.name), detail, pedal.isOn);
  renderTone();
}

// ---------- rendering ----------

const escapeHtml = (str) => String(str).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

function render() {
  ui.bankLabel.textContent = `My tones · bank ${state.bank + 1} / ${library.bankCount(state.tones)}`;

  ui.slots.forEach((btn) => {
    const n = Number(btn.dataset.preset);
    const amp = isAmpSlot(n);
    const tone = amp ? null : slotTone(n);
    btn.querySelector(".num").textContent = n;
    btn.querySelector(".key").textContent = amp ? `amp preset ${n}` : (tone?.name ?? "empty");
    btn.classList.toggle("amp-slot", amp);
    btn.classList.toggle("mine", !amp);
    btn.classList.toggle("active", n === state.activeSlot);
    btn.classList.toggle("pending", n === state.pendingSlot && n !== state.activeSlot);
    btn.disabled = !state.connected || (!amp && !tone);
  });

  ui.libCount.textContent = `${state.tones.length} tone${state.tones.length === 1 ? "" : "s"}`;
  ui.libList.innerHTML = "";
  state.tones.forEach((tone, i) => {
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${i + 1}. ${tone.name}`;
    const del = document.createElement("button");
    del.className = "link";
    del.textContent = "remove";
    del.addEventListener("click", () => {
      state.tones.splice(i, 1);
      library.save(state.tones);
      state.bank = Math.min(state.bank, library.bankCount(state.tones) - 1);
      render();
    });
    row.append(label, del);
    ui.libList.append(row);
  });
  renderTone();
}

function renderTone() {
  const tone = state.tone;
  ui.tonePanel.hidden = !tone;
  if (!tone) return;
  ui.toneName.textContent = tone.name + (hasChanges() || state.preRandom ? " · edited" : "");

  const amp = ampPedal();
  ui.sliders.innerHTML = "";
  if (amp?.parameters[AMP_PARAM.master] !== undefined) {
    const volume = parameterSlider(amp.name, AMP_SLOT, AMP_PARAM.master, amp.parameters[AMP_PARAM.master]);
    volume.classList.add("volume");
    markVolume(volume, amp.parameters[AMP_PARAM.master]);
    ui.sliders.append(volume);
  }

  ui.revert.hidden = !hasChanges() && !state.preRandom;

  ui.effects.innerHTML = "";
  tone.pedals.forEach((pedal, i) => ui.effects.append(effectRow(pedal, i)));
}

function hasChanges() {
  const base = state.baseline;
  const tone = state.tone;
  if (!base || !tone) return false;
  return base.pedals.some((basePedal, i) => {
    const pedal = tone.pedals[i];
    return pedal.name !== basePedal.name || pedal.isOn !== basePedal.isOn
      || basePedal.parameters.some((v, p) => pedal.parameters[p] !== v);
  });
}

// One collapsible row per effect slot: on/off, model picker and that effect's knobs.
function effectRow(pedal, slotIndex) {
  const row = document.createElement("details");
  row.className = "fx-slot";
  row.open = state.openSlots.has(slotIndex);
  row.addEventListener("toggle", () => {
    row.open ? state.openSlots.add(slotIndex) : state.openSlots.delete(slotIndex);
  });

  const summary = document.createElement("summary");
  summary.innerHTML = `<span class="fx-label">${SLOT_LABELS[slotIndex]}</span>
    <span class="fx-name">${escapeHtml(displayName(pedal.name, pedal.parameters))}</span>`;
  const power = document.createElement("button");
  power.type = "button";
  power.className = `power${pedal.isOn ? " on" : ""}`;
  power.dataset.verify = editKey.onOff(pedal.name);
  power.textContent = pedal.isOn ? "ON" : "OFF";
  power.addEventListener("click", (e) => {
    e.preventDefault(); // don't open/close the row
    e.stopPropagation();
    toggleEffect(slotIndex);
  });
  summary.append(power);
  row.append(summary);

  const body = document.createElement("div");
  body.className = "fx-body";

  const info = fxInfo(pedal.name);
  if (info?.variants) {
    // One effect, several models chosen by a knob value (the reverbs).
    const current = pedal.parameters[info.selector] ?? 0;
    const picker = document.createElement("select");
    for (const v of info.variants) {
      picker.append(new Option(v.app, String(v.value), false, Math.abs(v.value - current) < 0.05));
    }
    picker.addEventListener("change", () => {
      sendParameter(slotIndex, info.selector, Number(picker.value));
      renderTone();
    });
    body.append(picker);
  } else {
    const options = FX_BY_SLOT[slotIndex] ?? [];
    if (options.length > 1) {
      const picker = document.createElement("select");
      if (!options.some((o) => o.tech === pedal.name)) picker.append(new Option(pedal.name, pedal.name, true, true));
      for (const opt of options) picker.append(new Option(opt.app, opt.tech, false, opt.tech === pedal.name));
      picker.addEventListener("change", () => swapEffect(slotIndex, picker.value));
      body.append(picker);
    }
  }

  pedal.parameters.forEach((value, p) => {
    if (info?.selector === p) return; // that knob is the model picker above
    body.append(parameterSlider(pedal.name, slotIndex, p, value));
  });
  row.append(body);
  return row;
}

// The master volume row says so when it is turned down far enough to sound broken.
function markVolume(row, value) {
  const low = value < 0.15;
  row.classList.toggle("low", low);
  row.querySelector("span").textContent = low ? "volume – almost silent" : "volume";
}

function parameterSlider(effectName, slotIndex, param, value) {
  const row = document.createElement("label");
  row.className = "slider";
  row.dataset.verify = editKey.param(effectName, param);
  row.innerHTML = `<span>${escapeHtml(paramLabel(effectName, param))}</span>
    <input type="range" min="0" max="1" step="0.01" value="${value}">
    <output>${Math.round(value * 100)}</output>`;
  const input = row.querySelector("input");
  const out = row.querySelector("output");
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = Math.round(v * 100);
    sendParameter(slotIndex, param, v);
    if (row.classList.contains("volume")) markVolume(row, v);
    ui.revert.hidden = !hasChanges();
  });
  return row;
}

// ---------- bluetooth ----------

function onNotification(event) {
  const { buffer, byteOffset, byteLength } = event.target.value;
  const bytes = new Uint8Array(buffer, byteOffset, byteLength);
  for (const msg of reader.push(bytes)) {
    const info = describe(msg);
    if (info?.type === "tone") {
      try {
        const tone = decodePreset(info.data);
        state.decodeRetries = 0;
        log(`← tone "${tone.name}"`);
        if (!state.inspecting) setTone(tone);
        state.toneWaiter?.(tone);
      } catch (err) {
        // Without the bytes there is nothing to go on, and this has now cost two sessions.
        log(`tone decode failed (${err.message}): ${hex(info.data.slice(0, 48))}`);
        state.toneWaiter?.(null);
        if (state.decodeRetries++ < 2) setTimeout(() => requestTone("get tone (retry)"), 600);
        else log("giving up on this tone – press a preset button to reload");
      }
    } else if (info?.type === "preset") {
      log(`← amp preset: ${info.preset ?? "custom"}`);
      if (info.preset) {
        clearTimeout(state.ackTimer);
        state.activeSlot = info.preset;
        state.pendingSlot = null;
        render();
        requestTone();
      }
    } else if (info?.type === "ack") {
      log(`← ack ${msg.subCmd.toString(16)}`);
      settleAck(msg.subCmd);
      ackConfirms(msg.subCmd);
      if (msg.subCmd === 0x01) activateSentTone();
      if (msg.subCmd === 0x38 || msg.subCmd === 0x01) confirmSlot(state.pendingSlot);
    } else if (info?.type === "paramChanged") {
      const { effect, param, value } = decodeEffectParameter(info.data);
      const asked = echoArrived(editKey.param(effect, param), value);
      const shown = `${effect} p${param}=${value.toFixed(2)}`;
      if (!asked) log(`← amp changed ${shown}`);
      else if (Math.abs(asked.sent - value) > 0.02) {
        log(`⚠ asked ${effect} p${param} for ${asked.sent.toFixed(2)}, amp set ${value.toFixed(2)}`);
      } else log(`← confirmed ${shown}`);
      adoptAmpValue(effect, param, value);
    } else if (info?.type === "effectToggled") {
      const { effect, isOn } = decodeEffectOnOff(info.data);
      const asked = echoArrived(editKey.onOff(effect), isOn);
      log(`← ${asked ? "confirmed" : "amp changed"} ${effect} ${isOn ? "on" : "off"}`);
      adoptAmpOnOff(effect, isOn);
    } else if (info?.type === "effectSwapped") {
      const { from, to } = decodeEffectSwap(info.data);
      const asked = echoArrived(editKey.model(to), to);
      log(`← ${asked ? "confirmed" : "amp changed"} ${from} → ${to}`);
    } else if (info?.type === "ampName") {
      setAmpModel(info.name);
      state.ampNameWaiter?.(info.name);
    } else if (msg.cmd === 0x03 && msg.subCmd === 0x27) {
      log("← amp stored the tone");
    } else if (msg.cmd === 0x05 && msg.subCmd === 0x01) {
      noteChunkAck(); // one chunk of a tone accepted
      log(`← chunk ok${state.pendingTone ? ` (${state.pendingTone.acked}/${state.pendingTone.chunks})` : ""}`);
    } else {
      log(`← cmd ${msg.cmd.toString(16)} ${msg.subCmd.toString(16)} (${msg.data.length} bytes)`);
    }
  }
}

async function openGatt() {
  setStatus("connecting", `Connecting to ${state.device.name ?? "Spark"}…`);
  log(`gatt connect → ${state.device.name ?? "(no name)"}`);
  const server = await state.device.gatt.connect();
  log("getting Spark service ffc0");
  const service = await server.getPrimaryService(SPARK_SERVICE);
  state.writeChar = await service.getCharacteristic(SPARK_WRITE_CHAR);
  const notifyChar = await service.getCharacteristic(SPARK_NOTIFY_CHAR);
  log("starting notifications ffc2");
  notifyChar.addEventListener("characteristicvaluechanged", onNotification);
  await notifyChar.startNotifications();
  showHint(null);

  state.connected = true;
  setStatus("connected", `Connected: ${state.device.name ?? "Spark"}`);
  log("connected");
  render();
  requestWakeLock();
  send(getAmpName(nextMsgNum()), "get amp name");
  send(getCurrentPresetNumber(nextMsgNum()), "get preset");
  requestTone();
}

async function connect({ allDevices = false } = {}) {
  if (!navigator.bluetooth) return;
  state.userDisconnected = false;
  showHint(null);
  try {
    const options = allDevices
      ? { acceptAllDevices: true, optionalServices: [SPARK_SERVICE] }
      : { filters: [{ services: [SPARK_SERVICE] }, { namePrefix: "Spark" }], optionalServices: [SPARK_SERVICE] };
    log(allDevices ? "requesting device (all devices)" : "requesting device (Spark filter)");
    state.device = await navigator.bluetooth.requestDevice(options);
    state.device.addEventListener("gattserverdisconnected", onDisconnected);
    await openGatt();
  } catch (err) {
    log(`connect failed: ${err.name}: ${err.message}`);
    state.device?.gatt?.connected && state.device.gatt.disconnect();
    setStatus("disconnected", err.name === "NotFoundError" ? "No amp selected" : "Connection failed");
    showHint(CONNECT_HINTS[err.name] ?? `Connection failed (${err.name}). Open "Bluetooth log" below, tap Copy log and send it.`);
  }
}

function disconnect() {
  state.userDisconnected = true;
  state.device?.gatt?.disconnect();
}

async function onDisconnected() {
  state.connected = false;
  state.writeChar = null;
  render();
  releaseWakeLock();
  if (state.userDisconnected) {
    setStatus("disconnected", "Disconnected");
    log("disconnected");
    return;
  }
  log("connection lost, reconnecting…");
  for (const delay of RECONNECT_DELAYS_MS) {
    setStatus("connecting", "Connection lost – reconnecting…");
    await new Promise((r) => setTimeout(r, delay));
    if (state.userDisconnected) break;
    try {
      await openGatt();
      return;
    } catch (err) {
      log(`reconnect failed: ${err.message}`);
    }
  }
  setStatus("disconnected", "Disconnected – tap Connect");
}

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    // Not supported or denied; the user can disable auto-lock manually.
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

// ---------- events ----------

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.connected) requestWakeLock();
});

document.addEventListener("keydown", (e) => {
  const action = KEYMAP[e.code];
  if (!action || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches?.("input, textarea")) return;
  e.preventDefault();
  if (e.repeat && !action.volume) return;
  if (action.slot) selectSlot(action.slot);
  else if (action.step) stepSlot(action.step);
  else if (action.bank) stepBank(action.bank);
  else if (action.volume) nudgeVolume(action.volume);
  else if (action.revert) revertTone();
  else if (action.random) sendRandomTone();
});

ui.connect.addEventListener("click", () => {
  if (state.connected || ui.status.dataset.state === "connecting") disconnect();
  else connect();
});
ui.connectAll.addEventListener("click", () => { if (!state.connected) connect({ allDevices: true }); });
ui.random.addEventListener("click", sendRandomTone);

// Whether random tones may use the paid Hendrix gear; remembered per device.
try {
  ui.includePaid.checked = localStorage.getItem("spark-switch-include-jh") !== "no";
} catch {
  ui.includePaid.checked = true;
}
ui.includePaid.addEventListener("change", () => {
  try {
    localStorage.setItem("spark-switch-include-jh", ui.includePaid.checked ? "yes" : "no");
  } catch {
    // Storage unavailable: the choice still applies for this session.
  }
});
ui.revert.addEventListener("click", revertTone);
ui.bankPrev.addEventListener("click", () => stepBank(-1));
ui.bankNext.addEventListener("click", () => stepBank(1));

ui.slots.forEach((btn) => {
  btn.addEventListener("click", () => {
    selectSlot(Number(btn.dataset.preset));
    btn.blur();
  });
});

ui.saveTone.addEventListener("click", () => {
  if (!state.tone) return;
  const name = prompt("Name for this tone:", state.tone.name)?.trim();
  if (!name) return;
  state.tones.push({ ...structuredClone(state.tone), name, uuid: crypto.randomUUID().toUpperCase() });
  if (!library.save(state.tones)) showHint("Saved for this session only – browser storage is unavailable.");
  state.bank = library.bankCount(state.tones) - 1; // show the bank the new tone landed in
  state.preRandom = null;
  render();
});

ui.copyPresets.addEventListener("click", copyAmpPresets);
ui.selfTest.addEventListener("click", selfTest);

ui.importFile.addEventListener("change", async () => {
  const files = [...ui.importFile.files];
  let added = 0;
  for (const file of files) {
    try {
      const tones = library.parseImport(await file.text());
      state.tones.push(...tones);
      added += tones.length;
    } catch (err) {
      showHint(`Could not read ${file.name}: ${err.message}`);
    }
  }
  if (added) {
    library.save(state.tones);
    log(`imported ${added} tone(s)`);
    render();
  }
  ui.importFile.value = "";
});

ui.exportLib.addEventListener("click", async () => {
  const text = JSON.stringify(state.tones.map(library.toFileFormat), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    ui.exportLib.textContent = "Copied to clipboard";
  } catch {
    ui.exportLib.textContent = "Copy failed – see log";
    log(text);
  }
  setTimeout(() => (ui.exportLib.textContent = "Export (copy JSON)"), 2500);
});

ui.copyLog.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(ui.log.textContent);
    ui.copyLog.textContent = "Copied";
  } catch {
    getSelection().selectAllChildren(ui.log);
    ui.copyLog.textContent = "Selected – use Copy";
  }
  setTimeout(() => (ui.copyLog.textContent = "Copy log"), 2000);
});

// ---------- startup ----------

// The page itself gets cached hard on iOS, which has more than once left an old version
// running while the fix for the very bug being reported sat live. Ask the server what is
// current and offer a reload that busts the cache with a query string.
async function checkForUpdate() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    const { version } = await res.json();
    if (!version || version === APP_VERSION) return;
    log(`running ${APP_VERSION}, but ${version} is live – reload to get it`);
    ui.update.querySelector("span").textContent =
      `You are running ${APP_VERSION}. Version ${version} is live.`;
    ui.update.hidden = false;
  } catch {
    // Opened from a file, or offline: nothing to check against.
  }
}

ui.updateNow.addEventListener("click", () => {
  location.replace(`${location.pathname}?r=${Date.now()}`);
});

checkForUpdate();

ui.version.textContent = APP_VERSION;
log(`${APP_VERSION} · ${navigator.userAgent}`);
log(`web bluetooth: ${navigator.bluetooth ? "yes" : "no"} · secure context: ${window.isSecureContext}`);

if (!navigator.bluetooth) {
  ui.unsupported.hidden = false;
  ui.connect.disabled = true;
  ui.connectAll.disabled = true;
  setStatus("disconnected", "Bluetooth not available in this browser");
} else {
  setStatus("disconnected", "Not connected");
  navigator.bluetooth.getAvailability?.().then((available) => {
    log(`bluetooth available: ${available}`);
    if (!available) showHint("Bluetooth looks off or blocked. Turn Bluetooth on and allow it for this browser (iPhone Settings → Bluefy → Bluetooth).");
  }).catch(() => {});
}
render();

// Offline preview for screenshots/tests: ?demo=1 renders with a sample tone, no Bluetooth.
if (new URLSearchParams(location.search).has("demo")) {
  state.connected = true;
  state.activeSlot = 2;
  state.tones = [
    { name: "GnR Lead", pedals: [] }, { name: "Clean Jazzy", pedals: [] },
    { name: "Blues Drive", pedals: [] }, { name: "Metal Rhythm", pedals: [] },
  ];
  setStatus("connected", "Connected: Spark 40 BLE (demo)");
  setTone({
    name: "Ac Dc", pedals: [
      { name: "bias.noisegate", isOn: false, parameters: [0.2, 0.34] },
      { name: "BBEOpticalComp", isOn: true, parameters: [0.76, 0.26, 0] },
      { name: "Booster", isOn: true, parameters: [0.7] },
      { name: "94MatchDCV2", isOn: true, parameters: [0.5, 0.6, 0.55, 0.45, 0.8] },
      { name: "Cloner", isOn: false, parameters: [0.3, 0] },
      { name: "DelayMono", isOn: false, parameters: [0.2, 0.3, 0.4, 0.5, 1] },
      { name: "bias.reverb", isOn: true, parameters: [0.35, 0.4, 0.5, 0.6, 0.1, 0.9, 0.8] },
    ],
  });
  render();
}
