import {
  SPARK_SERVICE, SPARK_WRITE_CHAR, SPARK_NOTIFY_CHAR,
  changeHardwarePreset, getCurrentPresetNumber, SparkReader, describe, hex,
} from "./spark-protocol.js?v=2";

// Keyboard map, by KeyboardEvent.code so it works regardless of layout.
const KEYMAP = {
  Digit1: { preset: 1 }, Numpad1: { preset: 1 },
  Digit2: { preset: 2 }, Numpad2: { preset: 2 },
  Digit3: { preset: 3 }, Numpad3: { preset: 3 },
  Digit4: { preset: 4 }, Numpad4: { preset: 4 },
  ArrowLeft: { step: -1 }, ArrowUp: { step: -1 }, PageUp: { step: -1 },
  ArrowRight: { step: 1 }, ArrowDown: { step: 1 }, PageDown: { step: 1 },
};

const RECONNECT_DELAYS_MS = [500, 1500, 4000];
const ACK_TIMEOUT_MS = 700;
const APP_VERSION = "v2";

// Shown on screen when connecting fails, keyed by DOMException name.
const CONNECT_HINTS = {
  NotFoundError: "No amp chosen. If the list was empty: close the page on other devices (e.g. Mac Chrome), forget \"Spark 40 BLE\" in iPhone Settings → Bluetooth, power-cycle the amp, then try \"Show all devices\".",
  SecurityError: "Bluetooth is blocked. Open the page over https:// in Bluefy, and allow Bluetooth for Bluefy in iPhone Settings → Bluefy.",
  NotAllowedError: "Bluetooth permission denied. Allow Bluetooth for Bluefy in iPhone Settings → Bluefy.",
  NetworkError: "The amp refused the connection – usually another app or device is already connected to it. Close the Spark app / other pages, power-cycle the amp and retry.",
  NotSupportedError: "The amp didn't expose the Spark control service. Tap \"Show all devices\" and pick the entry ending in \"BLE\" (not \"Audio\").",
};

const $ = (id) => document.getElementById(id);
const ui = {
  connect: $("connect"),
  connectAll: $("connect-all"),
  hint: $("hint"),
  copyLog: $("copy-log"),
  version: $("version"),
  status: $("status"),
  statusText: $("status-text"),
  presets: [...document.querySelectorAll(".preset")],
  log: $("log"),
  unsupported: $("unsupported"),
};

const state = {
  device: null,
  writeChar: null,
  connected: false,
  userDisconnected: false,
  activePreset: null,
  pendingPreset: null,
  msgNum: 0,
  ackTimer: null,
  wakeLock: null,
};

const reader = new SparkReader();
let writeQueue = Promise.resolve();

function log(text) {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  ui.log.textContent = `${time}  ${text}\n` + ui.log.textContent.split("\n").slice(0, 60).join("\n");
}

function setStatus(kind, text) {
  ui.status.dataset.state = kind;
  ui.statusText.textContent = text;
  ui.connect.textContent = kind === "connected" || kind === "connecting" ? "Disconnect" : "Connect to Spark";
}

function render() {
  ui.presets.forEach((btn) => {
    const n = Number(btn.dataset.preset);
    btn.classList.toggle("active", n === state.activePreset);
    btn.classList.toggle("pending", n === state.pendingPreset && n !== state.activePreset);
    btn.disabled = !state.connected;
  });
}

const nextMsgNum = () => (state.msgNum = (state.msgNum % 0x7f) + 1);

// GATT operations must not overlap, so all writes go through one queue.
function send(blocks, label) {
  if (!state.writeChar) return Promise.resolve();
  writeQueue = writeQueue.then(async () => {
    for (const block of blocks) {
      log(`→ ${label}: ${hex(block)}`);
      const props = state.writeChar.properties ?? {};
      if (props.writeWithoutResponse && state.writeChar.writeValueWithoutResponse) {
        await state.writeChar.writeValueWithoutResponse(block);
      } else {
        await state.writeChar.writeValue(block);
      }
    }
  }).catch((err) => log(`write failed: ${err.message}`));
  return writeQueue;
}

function selectPreset(n) {
  if (!state.connected) return;
  state.pendingPreset = n;
  render();
  send(changeHardwarePreset(n, nextMsgNum()), `preset ${n}`);
  // If the amp doesn't acknowledge, assume the change went through.
  clearTimeout(state.ackTimer);
  state.ackTimer = setTimeout(() => confirmPreset(n), ACK_TIMEOUT_MS);
}

function confirmPreset(n) {
  if (state.pendingPreset !== n) return;
  state.activePreset = n;
  state.pendingPreset = null;
  render();
}

function stepPreset(step) {
  const current = state.pendingPreset ?? state.activePreset ?? 1;
  selectPreset(((current - 1 + step + 4) % 4) + 1);
}

function onNotification(event) {
  const { buffer, byteOffset, byteLength } = event.target.value;
  const bytes = new Uint8Array(buffer, byteOffset, byteLength);
  for (const msg of reader.push(bytes)) {
    const info = describe(msg);
    if (info?.type === "preset") {
      log(`← amp preset: ${info.preset ?? "custom"}`);
      clearTimeout(state.ackTimer);
      state.activePreset = info.preset;
      state.pendingPreset = null;
      render();
    } else if (info?.type === "ack") {
      log(`← ack ${msg.subCmd.toString(16)}`);
      if (msg.subCmd === 0x38) confirmPreset(state.pendingPreset);
    } else {
      log(`← cmd ${msg.cmd.toString(16)} ${msg.subCmd.toString(16)} (${msg.data.length} bytes)`);
    }
  }
}

function showHint(text) {
  ui.hint.textContent = text ?? "";
  ui.hint.hidden = !text;
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

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.connected) requestWakeLock();
});

document.addEventListener("keydown", (e) => {
  const action = KEYMAP[e.code];
  if (!action || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  if (e.repeat) return;
  if (action.preset) selectPreset(action.preset);
  else stepPreset(action.step);
});

ui.connect.addEventListener("click", () => {
  if (state.connected || ui.status.dataset.state === "connecting") disconnect();
  else connect();
});

ui.connectAll.addEventListener("click", () => {
  if (!state.connected) connect({ allDevices: true });
});

ui.copyLog.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(ui.log.textContent);
    ui.copyLog.textContent = "Copied";
  } catch {
    // Clipboard unavailable: select the text so the user can copy it manually.
    getSelection().selectAllChildren(ui.log);
    ui.copyLog.textContent = "Selected – use Copy";
  }
  setTimeout(() => (ui.copyLog.textContent = "Copy log"), 2000);
});

ui.presets.forEach((btn) => {
  btn.addEventListener("click", () => {
    selectPreset(Number(btn.dataset.preset));
    btn.blur();
  });
});

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
