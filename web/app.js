import {
  SPARK_SERVICE, SPARK_WRITE_CHAR, SPARK_NOTIFY_CHAR,
  changeHardwarePreset, getCurrentPresetNumber, SparkReader, describe, hex,
} from "./spark-protocol.js?v=10";
import {
  encodePreset, decodePreset, getCurrentPreset, changeEffectParameter, turnEffectOnOff, changeEffect,
  AMP_PARAM, AMP_SLOT, SLOT_LABELS,
} from "./spark-preset.js?v=10";
import * as library from "./library.js?v=10";
import { FX_BY_SLOT, fxInfo, paramLabel, displayName } from "./fx-catalog.js?v=10";
import { randomTone, MIN_MASTER } from "./random-tone.js?v=10";

const APP_VERSION = "v10";
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
  saveTone: $("save-tone"), importFile: $("import-file"), exportLib: $("export-lib"),
  includePaid: $("include-paid"),
  log: $("log"), copyLog: $("copy-log"), version: $("version"),
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
  activatePending: false, activateTimer: null,
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

const nextMsgNum = () => (state.msgNum = (state.msgNum % 0x7f) + 1);

// GATT operations must not overlap, so all writes go through one queue.
function send(blocks, label) {
  if (!state.writeChar) return Promise.resolve();
  writeQueue = writeQueue.then(async () => {
    for (const block of blocks) {
      if (blocks.length <= 2) log(`→ ${label}: ${hex(block)}`);
      const props = state.writeChar.properties ?? {};
      if (props.writeWithoutResponse && state.writeChar.writeValueWithoutResponse) {
        await state.writeChar.writeValueWithoutResponse(block);
      } else {
        await state.writeChar.writeValue(block);
      }
    }
    if (blocks.length > 2) log(`→ ${label}: ${blocks.length} blocks`);
  }).catch((err) => log(`write failed: ${err.message}`));
  return writeQueue;
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

function sendTone(tone, label) {
  send(encodePreset(tone, nextMsgNum()), label);
  state.activatePending = true;
  clearTimeout(state.activateTimer);
  state.activateTimer = setTimeout(activateSentTone, 900); // in case the ack never arrives
}

function activateSentTone() {
  if (!state.activatePending) return;
  state.activatePending = false;
  clearTimeout(state.activateTimer);
  send(changeHardwarePreset(TEMP_PRESET, nextMsgNum()), "play sent tone");
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
  state.sliderTimer = setTimeout(
    () => send(changeEffectParameter(pedal.name, param, value, nextMsgNum()), `${pedal.name} p${param}=${value.toFixed(2)}`),
    SLIDER_SEND_MS,
  );
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
  send(turnEffectOnOff(pedal.name, pedal.isOn, nextMsgNum()), `${pedal.name} ${pedal.isOn ? "on" : "off"}`);
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
        log(`← tone "${tone.name}"`);
        setTone(tone);
      } catch (err) {
        log(`tone decode failed (${err.message}) – asking again`);
        setTimeout(() => requestTone("get tone (retry)"), 600);
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
      if (msg.subCmd === 0x01 && state.activatePending) activateSentTone();
      if (msg.subCmd === 0x38 || msg.subCmd === 0x01) confirmSlot(state.pendingSlot);
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
