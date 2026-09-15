import {
  SPARK_SERVICE, SPARK_WRITE_CHAR, SPARK_NOTIFY_CHAR,
  changeHardwarePreset, getCurrentPresetNumber, SparkReader, describe, hex,
} from "./spark-protocol.js?v=3";
import {
  encodePreset, decodePreset, getCurrentPreset, changeEffectParameter, turnEffectOnOff,
  AMP_PARAM, AMP_SLOT, SLOT_LABELS,
} from "./spark-preset.js?v=3";
import * as library from "./library.js?v=3";

const APP_VERSION = "v3";
const ACK_TIMEOUT_MS = 700;
const RECONNECT_DELAYS_MS = [500, 1500, 4000];
const SLIDER_SEND_MS = 60; // don't flood the BLE connection while dragging

// Keyboard map, by KeyboardEvent.code so it works regardless of layout.
const KEYMAP = {
  Digit1: { slot: 1 }, Numpad1: { slot: 1 },
  Digit2: { slot: 2 }, Numpad2: { slot: 2 },
  Digit3: { slot: 3 }, Numpad3: { slot: 3 },
  Digit4: { slot: 4 }, Numpad4: { slot: 4 },
  ArrowLeft: { step: -1 }, ArrowUp: { step: -1 }, PageUp: { step: -1 },
  ArrowRight: { step: 1 }, ArrowDown: { step: 1 }, PageDown: { step: 1 },
  BracketLeft: { bank: -1 }, BracketRight: { bank: 1 },
  Minus: { volume: -0.05 }, NumpadSubtract: { volume: -0.05 },
  Equal: { volume: 0.05 }, NumpadAdd: { volume: 0.05 },
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
  modeAmp: $("mode-amp"), modeLibrary: $("mode-library"),
  bankRow: $("bank-row"), bankLabel: $("bank-label"),
  bankPrev: $("bank-prev"), bankNext: $("bank-next"),
  tonePanel: $("tone-panel"), toneName: $("tone-name"),
  sliders: $("sliders"), effects: $("effects"),
  libCount: $("lib-count"), libList: $("lib-list"),
  saveTone: $("save-tone"), importFile: $("import-file"), exportLib: $("export-lib"),
  log: $("log"), copyLog: $("copy-log"), version: $("version"),
};

const state = {
  device: null, writeChar: null, connected: false, userDisconnected: false,
  mode: "amp", // "amp" = the amp's own 4 presets, "library" = our own tones
  activeSlot: null, pendingSlot: null,
  bank: 0,
  tones: library.load(),
  tone: null, // the tone currently loaded on the amp, as reported by it
  msgNum: 0, ackTimer: null, wakeLock: null, sliderTimer: null,
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

const slotTone = (n) => library.bankSlots(state.tones, state.bank)[n - 1];

function selectSlot(n) {
  if (!state.connected) return;
  if (state.mode === "amp") {
    state.pendingSlot = n;
    render();
    send(changeHardwarePreset(n, nextMsgNum()), `preset ${n}`);
  } else {
    const tone = slotTone(n);
    if (!tone) return;
    state.pendingSlot = n;
    render();
    send(encodePreset(tone, nextMsgNum()), `tone "${tone.name}"`);
    setTone(structuredClone(tone));
  }
  clearTimeout(state.ackTimer);
  state.ackTimer = setTimeout(() => confirmSlot(n), ACK_TIMEOUT_MS);
}

function confirmSlot(n) {
  if (n === null || state.pendingSlot !== n) return;
  state.activeSlot = n;
  state.pendingSlot = null;
  render();
}

function stepSlot(step) {
  const current = state.pendingSlot ?? state.activeSlot ?? 1;
  selectSlot(((current - 1 + step + 4) % 4) + 1);
}

function stepBank(step) {
  if (state.mode !== "library") return;
  const count = library.bankCount(state.tones);
  state.bank = (state.bank + step + count) % count;
  render();
}

function setMode(mode) {
  state.mode = mode;
  state.activeSlot = null;
  state.pendingSlot = null;
  render();
  if (state.connected && mode === "amp") send(getCurrentPresetNumber(nextMsgNum()), "get preset");
}

// ---------- tone parameters (volume / EQ / effects) ----------

function setTone(tone) {
  state.tone = tone;
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
  const inLibrary = state.mode === "library";
  ui.modeAmp.classList.toggle("selected", !inLibrary);
  ui.modeLibrary.classList.toggle("selected", inLibrary);
  ui.bankRow.hidden = !inLibrary;
  if (inLibrary) ui.bankLabel.textContent = `Bank ${state.bank + 1} / ${library.bankCount(state.tones)}`;

  ui.slots.forEach((btn) => {
    const n = Number(btn.dataset.preset);
    const tone = inLibrary ? slotTone(n) : null;
    btn.querySelector(".num").textContent = inLibrary ? (tone ? n : "–") : n;
    btn.querySelector(".key").textContent = inLibrary ? (tone?.name ?? "empty") : `key ${n}`;
    btn.classList.toggle("active", n === state.activeSlot);
    btn.classList.toggle("pending", n === state.pendingSlot && n !== state.activeSlot);
    btn.disabled = !state.connected || (inLibrary && !tone);
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
  ui.toneName.textContent = tone.name;

  const amp = ampPedal();
  ui.sliders.innerHTML = "";
  if (amp) {
    for (const [label, index] of Object.entries(AMP_PARAM)) {
      const value = amp.parameters[index];
      if (value === undefined) continue;
      const row = document.createElement("label");
      row.className = "slider";
      row.innerHTML = `<span>${label === "master" ? "volume" : label}</span>
        <input type="range" min="0" max="1" step="0.01" value="${value}">
        <output>${Math.round(value * 100)}</output>`;
      const input = row.querySelector("input");
      const out = row.querySelector("output");
      input.addEventListener("input", () => {
        const v = Number(input.value);
        out.textContent = Math.round(v * 100);
        sendParameter(AMP_SLOT, index, v);
      });
      ui.sliders.append(row);
    }
  }

  ui.effects.innerHTML = "";
  tone.pedals.forEach((pedal, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `fx${pedal.isOn ? " on" : ""}`;
    btn.innerHTML = `<span class="fx-label">${SLOT_LABELS[i]}</span><span class="fx-name">${escapeHtml(pedal.name)}</span>`;
    btn.addEventListener("click", () => toggleEffect(i));
    ui.effects.append(btn);
  });
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
        log(`tone decode failed: ${err.message}`);
      }
    } else if (info?.type === "preset") {
      log(`← amp preset: ${info.preset ?? "custom"}`);
      if (state.mode === "amp" && info.preset) {
        clearTimeout(state.ackTimer);
        state.activeSlot = info.preset;
        state.pendingSlot = null;
        render();
      }
      send(getCurrentPreset(-1, nextMsgNum()), "get tone");
    } else if (info?.type === "ack") {
      log(`← ack ${msg.subCmd.toString(16)}`);
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
  send(getCurrentPreset(-1, nextMsgNum()), "get tone");
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
});

ui.connect.addEventListener("click", () => {
  if (state.connected || ui.status.dataset.state === "connecting") disconnect();
  else connect();
});
ui.connectAll.addEventListener("click", () => { if (!state.connected) connect({ allDevices: true }); });
ui.modeAmp.addEventListener("click", () => setMode("amp"));
ui.modeLibrary.addEventListener("click", () => setMode("library"));
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
  state.tones.push({ ...structuredClone(state.tone), name });
  if (!library.save(state.tones)) showHint("Saved for this session only – browser storage is unavailable.");
  setMode("library");
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
    setMode("library");
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
