# Spark Pedal Alternative – Build Plan

Goal: switch tones on a **Positive Grid Spark 40** quickly, without buying Spark Control.
Controls: a Bluetooth keyboard or page-turner pedal, the phone itself, and later a DIY foot pedal.

---

## 1. How it works

```
 Phase 1 (software only)                     Phase 3 (hardware pedal)

 BT keyboard / page-turner pedal             Footswitches (GPIO)
          │ (HID key presses)                  and/or BT keyboard
          ▼                                          │
 Phone / laptop  ── web app ──┐                      ▼
                              │  Bluetooth LE     ESP32 board
                              ▼                      │  Bluetooth LE
                        Spark 40 amp  ◄──────────────┘
```

The Spark 40 exposes a BLE control service. It is the same one the official Spark app uses:

| Item                   | Value                                                   |
|------------------------|---------------------------------------------------------|
| BLE service            | `FFC0` (`0000ffc0-0000-1000-8000-00805f9b34fb`)         |
| Write characteristic   | `FFC1` (commands go to the amp)                         |
| Notify characteristic  | `FFC2` (replies and ACKs come back from the amp)        |

Sources: `Ignitron/src/SparkBTControl.h` and `paulhamsh/Spark/SparkESP32/SparkComms.h`.

**Limit:** the amp normally accepts only **one** BLE control connection at a time.
While our tool is connected, the official Spark app can't be. Bluetooth audio streaming still works, because it uses a separate Bluetooth connection.

---

## 2. Protocol summary

Taken from the Ignitron source (`src/SparkMessage.cpp`, BSD-3 licensed).

A message to the amp has three layers:

1. **Payload** (8-bit bytes). For example, "change hardware preset" is `00 <preset index 0..3>`.
2. **7-bit encoding.** For every group of up to 7 bytes, add one leading byte that holds their high bits. Then clear the high bit of each data byte.
3. **Chunk:**
   `F0 01 <msgNum> <checksum> <cmd> <subCmd> <7-bit data...> F7`
   - `checksum` is the XOR of all 7-bit data bytes.
4. **Block header** (16 bytes) in front of the chunks:
   `01 FE 00 00 53 FE <total block length> 00 00 00 00 00 00 00 00 00`
   - Maximum block size to the amp is `0xAD` (173) bytes; larger messages are split into several blocks.

Commands we need:

| Action                      | cmd  | subCmd | Payload                                  |
|-----------------------------|------|--------|------------------------------------------|
| Change hardware preset 1–4  | `01` | `38`   | `00 <0..3>`                              |
| Effect on/off               | `01` | `15`   | `<len-prefixed effect name> <on/off> 00` |
| Change effect parameter     | `01` | `04`   | `<effect name> <param#> <float>`         |
| Send a full custom preset   | `01` | `01`   | multi-chunk preset structure (Phase 2)   |

Worked example: select **preset 1** with message number `01`. The full packet is 26 bytes, written to `FFC1`:

```
01 FE 00 00 53 FE 1A 00 00 00 00 00 00 00 00 00   F0 01 01 00 01 38 00 00 00 F7
```

- Preset 2: the chunk becomes `F0 01 01 01 01 38 00 00 01 F7`.
- Preset 3: `... 02 01 38 00 00 02 F7`.
- Preset 4: `... 03 01 38 00 00 03 F7`.

---

## 3. Phases

### Phase 0 – Prove the protocol with no code (about 30 minutes)
1. Install **nRF Connect** (free, iOS or Android).
2. Turn the Spark 40 on. **Close the Spark app** and disconnect it.
3. In nRF Connect, scan and connect to the amp's BLE device (name like "Spark 40 BLE").
4. Open service `FFC0`, then characteristic `FFC1`. Write the preset-2 packet above as a hex byte array.
5. ✅ Pass: the amp's preset LED or tone changes. Also enable notifications on `FFC2` to see the ACK.

If this works, the rest of the plan is software engineering. If it doesn't, check whether a newer amp firmware changed the protocol before going further.

### Phase 1 – Web app: keyboard or phone → Spark 40 (about 1–2 days)
A single-page web app that uses **Web Bluetooth**. It needs no install and can be hosted on GitHub Pages or opened locally.

**Features (MVP)**
- "Connect to Spark" button. It filters devices by service `FFC0`.
- 4 large on-screen preset buttons, so the phone itself is the controller.
- Keyboard map (edit `KEYMAP` in `web/app.js`; a settings panel can come later):
  - `1` `2` `3` `4` → presets 1–4
  - `←` / `→` and `PageUp` / `PageDown` → previous / next preset (this is what most BT page-turner pedals send)
  - Later: `Space` → toggle a chosen effect, such as drive on/off
- Shows which preset is active and whether the amp ACKed.
- Screen Wake Lock, so the phone doesn't sleep in the middle of a song.
- Auto-reconnect when the connection drops.

**File layout**
```
web/
  index.html          UI
  app.js              connect, key map, key handling, UI state
  spark-protocol.js   message builder (payload → 7-bit → chunk → block) and parser
tests/
  spark-protocol.test.js   check the encoder against the known byte strings in section 2
```

**Where it runs**
| Device                 | Works?                                                    |
|------------------------|-----------------------------------------------------------|
| Android + Chrome       | ✅ best option                                            |
| Mac / Windows + Chrome | ✅ good for development                                   |
| iPhone / iPad          | ⚠️ Safari has no Web Bluetooth; use the **Bluefy** browser |

**Done when:** a BT page-turner or keyboard paired to the phone switches all 4 presets reliably. Target: under 150 ms, 50 switches in a row with no misses.

### Phase 2 – Custom tones from the phone (optional, about 2–4 days)
- Store more than 4 tones as JSON. Reuse Ignitron's preset JSON format so its preset library works too.
- Tone banks: Bank Up/Down plus 4 slots gives unlimited tones.
- Send a full preset with command `01 01` (multi-chunk), then activate it.
- Import and export presets.

### Phase 3 – ESP32 foot pedal, phone-free (about 1–2 weekends)
Two ways to do it:

- **3A – Build Ignitron as-is (recommended first).** It is proven on the Spark 40. It has 6 switches (4 presets + bank up/down), an OLED display, a looper mode, and can pass the connection through to the Spark app. Build it with PlatformIO, then flash it with `pio run -t upload` and `pio run -t uploadfs`.
- **3B – Our own firmware.** Port `spark-protocol.js` to C++ (NimBLE-Arduino). Choose this only if we need something Ignitron can't do, such as accepting a **BLE keyboard** as input. That works because an ESP32 can act as central to both the amp and the keyboard at the same time.

**Parts list (about $40–60)**
| Part                                        | Qty | ~Cost |
|---------------------------------------------|-----|-------|
| ESP32 DevKit (Node32s / WROOM-32)           | 1   | $8    |
| Momentary soft-touch footswitch             | 4–6 | $12   |
| Aluminum enclosure (Hammond 1590BB size)    | 1   | $12   |
| SSD1306 0.96" OLED (optional)               | 1   | $5    |
| LEDs + resistors                            | 4–6 | $2    |
| USB-C power bank, or 18650 + TP4056 charger | 1   | $10   |

---

## 4. Risks

| Risk                                          | Mitigation                                                          |
|-----------------------------------------------|---------------------------------------------------------------------|
| Amp firmware update changes the protocol      | Phase 0 test comes first; watch Ignitron issues; don't auto-update the amp before gigs |
| Only one BLE control connection               | Close the Spark app; later use Ignitron's pass-through mode         |
| iOS Web Bluetooth limits                      | Use Bluefy, or build the ESP32 pedal                                |
| Phone sleeps or the browser tab gets killed   | Wake Lock + auto-reconnect; Phase 3 removes the phone               |
| Reverse-engineered protocol, no official support | Personal use; keep the BSD-3 notice if we copy Ignitron code     |

---

## 5. Decisions (made 2026-09-14)
1. **Phone:** iPhone, so we use the **Bluefy** browser. The page must be hosted on HTTPS, e.g. GitHub Pages. A Mac with Chrome at `localhost` works for testing.
2. **Input device:** the **KZZI K75 Pro** keyboard the user already owns, in Bluetooth mode. Keys `1`–`4` select presets; arrow keys and PgUp/PgDn go to previous/next.
3. **End goal:** use existing hardware, so Phase 1 comes first. Only buy an ESP32 later if a phone-free pedal is wanted.

## 6. Status
- [x] Phase 1 MVP built: `web/` (UI, BLE connection, key map, auto-reconnect, wake lock) + `tests/` (encoder verified against known packets)
- [ ] Phase 0 / first real-amp test (Mac Chrome, then iPhone Bluefy)
- [ ] Host on GitHub Pages for iPhone use
- [ ] Phase 2 custom tones (optional)
- [ ] Phase 3 ESP32 pedal – design guide in ESP32_CONTROLLER.md, waiting on hardware decisions

## 7. References
- Ignitron (ESP32 Spark pedal): https://github.com/stangreg/Ignitron
- paulhamsh Spark protocol docs + ESP32 lib: https://github.com/paulhamsh/Spark (`Spark Protocol Description v3.2.pdf`)
- SparkMIDI: https://github.com/paulhamsh/SparkMIDI
- SparkBox: https://github.com/happyhappysundays/SparkBox
