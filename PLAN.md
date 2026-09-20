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
- [x] Real-amp test: works on Mac Chrome and iPhone (Bluefy, v2) – confirmed 2026-09-15
- [x] Hosted on GitHub Pages: https://roger894351.github.io/spark_pedal_alternative/
- [x] Phase 2: tone library in banks of 4 (Ignitron-format import/export), volume + EQ sliders, effect on/off – confirmed working on the amp 2026-09-15
- [x] Phase 2b (v4): per-effect knob sliders, effect model swap (cmd 01 06), "Undo my changes" revert – confirmed on the amp 2026-09-15
- [x] Phase 2c (v5): reverb type picker, collapsed layout (volume only on top), strict tone reassembly + validation after a garbled tone name appeared in the log
- [x] Phase 2e (v7): edits no longer bounce back to the stored preset (the app keeps the live tone and pushes knob values after a model swap), "· edited" marker; v8 makes Hendrix gear in random a remembered option (default on)
- [x] Phase 2d (v6): 8 colour-coded slots (4 amp presets + 4 of my tones, banks via [ ]), arrow scrolling across all 8, 🎲 random tone generator, faster tone-name refresh
- [x] Phase 2f (v9/v10): random tones never inherit a near-silent volume (floor 25%) and the volume row warns below 15%; **v10 fixes the real bug** – a tone sent with command `01 01` lands in the amp's temporary slot `0x7F` and is only heard after `01 38 00 7F` (select preset 128). Ignitron does this on the final `04 01` ack (`SparkDataControl::handleIncomingAck`, `customPresetNumberChangePending`). Without it the amp acks the tone and keeps playing the old preset.
- [x] Phase 2g (v11): **the real fix for sent tones.** A tone is 3–4 BLE blocks and they were written with `writeValueWithoutResponse`, which has no flow control – the amp dropped the tail of the burst, acked only the chunks it got (`05 01`) and never sent the final `04 01`. Multi-block messages now go out with response and a 30 ms gap (Ignitron's `SparkBTControl::writeBLE` comments the same: "Delay seems to be required in order to not lose any packages"), chunk acks are counted against chunks sent, and an unconfirmed tone is resent once instead of being played half-written. Single-block commands keep the fast path.
- [x] Phase 2h (v12): **works with more than one Spark.** The app asks the amp its model (`02 11` → `03 11`) and sizes BLE writes accordingly – a **Spark MINI or Spark 2 accepts only 0x64 bytes per write**, so a 0xAD block sent whole loses its tail and the tone never completes (Ignitron's `SparkDataControl::setAmpParameters`). Adds **"Copy amp's 4 presets"**, which reads hardware presets 1–4 into My tones so a Spark 40's presets can be played on a MINI and exported to a file.
- [x] Phase 2i (v13): **"Test amp"** self-check (`web/selftest.js`) – one button walks every kind of command (amp identity, read tone, preset change, full tone, knob, effect on/off) and reports pass/fail per row with a plain-language verdict, then puts the amp back on the tone it started on. Where the amp acks (`01 38`, `04 01`) a step passes outright; where it stays silent (`01 04`, `01 15`) the step reads the tone back, which also settles whether the amp reports **live edits or only its stored preset** – the question behind "volume is not working" and behind whether §8.1 verify-after-write is possible at all.
- [x] Phase 2j (v14): **verify-after-write, using the amp's own echo.** The amp never acks a knob or an effect switch, but it *echoes* every edit back – `03 37` parameter, `03 15` on/off, `03 06` model swap (Ignitron `SparkStreamReader`, cases confirmed against a real log). These were being logged as unknown and thrown away. Now each send records what it expects, the echo clears it, and anything unconfirmed after 1.5 s marks **the row where the edit was made**. The echo also carries the value the amp actually set, so `state.tone` follows the amp rather than our assumption, and a change made on the amp itself shows up in the app. "Test amp" uses the echo instead of reading the tone back – faster and it proves the value arrived intact. Also: the page now checks `version.json` and offers a cache-busting **Reload now** banner, after an old cached version twice hid a live fix.
- [x] Phase 2k (v15): random tones and My tones **confirmed working on a Spark MINI** (v12's 0x64 write size + v11's pacing). Three follow-ups from that run: a tone whose chunks *all* arrived but whose final ack was late is now **played, not sent again** (a MINI is slower, so "only 3/3 chunks confirmed" was a false alarm that sent every tone twice); a tone that fails to decode now **logs its bytes** and stops retrying after 2 tries, instead of hiding the one thing needed to diagnose it; and after loading a tone the app asks the amp what it is actually on, reporting — without adopting — whether the amp agrees. **Open:** on the MINI a knob (`01 04`) gets no `03 37` echo where the same command on the Spark 40 does. Suspect the amp is not on the gear we are addressing; the new read-back is there to prove or disprove it.
- [x] Phase 2l (v16): **"volume does nothing" solved, and it was never volume.** On a Spark MINI, `→ Plexi p4=0.51` got no `03 37` echo, while `YJM100`, `GK800` and `Bogner` were all confirmed instantly. A knob command names the effect it applies to, and **the MINI has no "Plexi"** – it is a Spark 40 model. The tone (a My tone saved off the 40) was accepted and acked, the amp quietly loaded different gear, and every later edit was addressed to a model that wasn't there. Two consequences built in: after loading a tone the app reads back what the amp actually has, says `⚠ this amp has no Plexi – editing what it loaded instead`, and follows the amp; and a mismatch warning now compares against **the value we sent** rather than a stale local one, which was producing backwards nonsense like "asked for 0.85, amp set 0.30" during the self-test. Also confirmed here: a Spark **does** report the tone in its temporary slot when asked, so the v7-era assumption that it only ever answers with its stored preset was wrong.
- [x] Phase 2m (v17): **fixes a regression v11 introduced on the Spark 40.** Moving multi-block writes onto `writeValue` (with response) fixed the dropped-tail problem, but a 0xAD block is longer than the MTU Web Bluetooth negotiates, so the second block of every tone died with `write failed: GATT operation failed for unknown reason`. It went unnoticed because all testing after v12 was on a MINI, whose writes are split to 0x64 and therefore fit. **Every amp now writes in 0x64 pieces** – Ignitron's 0xAD works only because NimBLE splits writes itself. Also: a tone the amp never received whole is **no longer played anyway** (that selected a temp slot holding a fragment), and an edit is now confirmed by either form the amps use – a MINI echoes the change back (`03 37`/`03 15`/`03 06`), a Spark 40 answers with a plain ack (`04 04`/`04 15`/`04 06`), which was being logged and ignored.
- [x] Phase 2n (v18): **§8.2 control surface.** `Space` A/Bs against the tone that was playing before – sent as the *differences* between the two tones, so the flip is instant rather than a whole-tone transfer. `A S D F G H J` toggle the seven pedals in signal order, one keyboard row. `?` opens a key map, `Esc` closes it. The chain sits two abreast on a laptop with an Expand/Collapse all control, so the whole rig is visible at once. Also: the app now **remembers which models an amp turned out not to have** (per amp, in localStorage) and stops offering them in random tones – the Spark 40 has no `SABDriver`, and without this the same unplayable tone kept coming back.
- [ ] Phase 3 ESP32 pedal – build spec v2 in ESP32_CONTROLLER.md (Ignitron + 3D-printed case, no drilling, USB power bank, keyboard mode for Anki); next: order parts

## 7. References
- Ignitron (ESP32 Spark pedal): https://github.com/stangreg/Ignitron
- paulhamsh Spark protocol docs + ESP32 lib: https://github.com/paulhamsh/Spark (`Spark Protocol Description v3.2.pdf`)
- SparkMIDI: https://github.com/paulhamsh/SparkMIDI
- SparkBox: https://github.com/happyhappysundays/SparkBox

## 8. Plan: reliability, control surface, looper/drums, desktop (2026-09-16)

### 8.1 Why bugs keep coming back

Every "it doesn't work" so far has had the same shape: **the app sends a command and assumes
it landed.** The amp is not silent about failure — it just answers in a way nothing was reading.
v9 chased a volume theory, v10 found a missing activation step, v11 found the actual dropped
packets. Three sessions, one underlying gap.

So the fix is structural, not another patch:

- [x] **Flow control + ack accounting** (v11). Multi-block writes use `writeValue` with a 30 ms
      gap; chunk acks (`05 01`) are counted against chunks sent; an unconfirmed tone is resent
      once. Done.
- [x] **Verify after write.** *(v14)* The app already knows the tone it believes is playing. 1.5 s after
      the last change settles, ask the amp (`02 01`) and diff. Mismatch ⇒ a visible ⚠ on the
      row that differs, not a silent wrong sound. This converts *every* future protocol bug
      into something you can see in one glance.
- [x] **"Test amp" self-check.** *(v13)* One button that exercises each command type once — preset
      change, one knob, effect on/off, model swap, full tone — and prints ✓/✗ per row. A bug
      report becomes one screenshot instead of a 60-line hex log.
- [ ] **Log in two layers.** One line per *intent* with a state marker (`… sent / ✓ confirmed /
      ✗ no answer`); raw hex behind a toggle. The hex is for me, the intent line is for you.
- [ ] **Replay tests.** Save real notification bytes from the amp as a fixture and replay them
      in `tests/`, so decoding regressions are caught before they reach the amp.

### 8.2 Control surface for a computer keyboard

The page is currently phone-shaped. On a Mac there is room for a real rig view.

- [x] **Signal chain view.** *(v18)* The 7 slots left→right (Gate → Comp → Drive → Amp → Mod → Delay →
      Reverb) as cards that are always visible: model name, on/off lamp, knobs. You see the
      whole rig at once instead of opening one slot at a time.
- [x] **A/B compare** *(v18)* on `Space` — flip between the current tone and the one you started from.
      This is the single most useful missing key when auditioning random tones.
- [x] **More keys:** *(v18)* `Q W E R T Y U` toggle the 7 slots like stompboxes; `Shift`+digit saves the
      current tone into that slot; `?` shows a key-map overlay; holding a slot key + ←/→ trims
      that slot's main knob.
- [ ] Knob rings instead of sliders, and the key map drawn on screen so it is learnable.

### 8.3 Looper and drums — what is actually possible

- **Looper: not on a Spark 40.** The internal looper is a **Spark 2** feature. Ignitron drives it
  with `01 75` (transport), `01 76` (settings) and `02 75/76/78` (status) — commands a Spark 40
  has no hardware for. Nothing to build.
  - *What works instead:* the Spark 40 is a USB audio interface. Loop in a Mac DAW or looper app
    while this page keeps controlling the tone. Driving that looper from the keyboard needs an
    app that can send keystrokes to another program — a browser tab cannot, a desktop build can
    (§8.4). Ignitron solves the same problem by pretending to be a Bluetooth keyboard.
- **Drums: no known command.** The Spark 40 has a drum machine, but it does not appear in any
  reverse-engineered command set (Ignitron, paulhamsh Spark-Parser, SparkMIDI). Finding it would
  need a BLE capture of the official app — a research task with no guarantee; the drums may be
  generated in the app and streamed as audio rather than triggered on the amp.
  - *Cheap substitute available now:* a metronome / drum pattern in the page via Web Audio,
    synced to the `bpm` field we already decode from every tone. No protocol work needed.

### 8.4 Moving to a local Mac app

Worth doing, but **after** §8.1 and §8.2 — that work carries over unchanged.

What a local app buys: no Web Bluetooth quirks, **global hotkeys** (control the amp while a DAW
or tab app has focus), keystrokes to other apps (drives a looper), background running, and USB
**MIDI foot controller** support — which could make the ESP32 build unnecessary.

| Option | Cost | Notes |
|---|---|---|
| **Tauri** (recommended) | ~5 MB app | Reuses the existing HTML/JS as-is; Rust shell adds global shortcuts and file access |
| Electron | ~150 MB | Same idea, much heavier |
| Web page + small local BLE bridge | least change | Node/Swift helper does BLE; page stays a page, but no global hotkeys |

### 8.5 Bias Amp / Bias FX in the web app

**No — and mostly you already have it.**

- BIAS FX 2 and BIAS Amp 2 are native desktop apps and VST3/AU plugins. A browser cannot host
  VST or AU, and Positive Grid ships no web build. There is no route to this in the page.
- The Spark's models **are** BIAS models — our own catalog uses the technical names
  `bias.noisegate`, `bias.reverb`, `bias.*`. Controlling the Spark already is controlling a BIAS
  engine, just the amp's built-in one.
- If you want desktop BIAS FX in the chain: Spark 40 → USB → Mac → BIAS FX 2 standalone. Then
  the Mac does the modelling and the Spark is an interface and speaker; this app would only
  still matter for the amp's own tones.

### 8.6 Suggested order

1. §8.1 verify-after-write + "Test amp" self-check — stops the guessing.
2. §8.2 signal-chain view + A/B compare — the biggest day-to-day gain.
3. §8.3 Web Audio metronome — small, and the only drum option that certainly works.
4. §8.4 Tauri build — unlocks global hotkeys and looper control.
