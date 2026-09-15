# ESP32 Spark 40 Controller – Build Spec v2 (no drilling)

**Target:** a 6-switch foot controller with a display, based on **Ignitron**. It gives you unlimited tone banks, tone names from the Spark app, and effect on/off switches. It doubles as a **Bluetooth keyboard** (for Anki, a looper, etc.).
**Constraints:** soldering iron ✅, no drill ❌, buying from AliExpress, budget about $50–70 (well under the ~$200 official pedal).

---

## 1. The build at a glance

| | Choice | Why |
|---|---|---|
| Firmware | **Ignitron** (open source, BSD-3, proven on Spark 40) | Banks, tone names, FX mode, tuner, keyboard mode already work |
| Case | **Ignitron 3D-printed case** ([Thingiverse 6952547](https://www.thingiverse.com/thing:6952547)) | Pre-designed holes for 6 switches, LEDs, display and USB → **no drilling** |
| Display | 1.3" OLED, SH1106 driver, I²C | Fits the case window; shows bank, tone number and **tone name** |
| Power | USB power bank into the case's USB port | The case is designed for USB power; rechargeable; no battery wiring |
| Wiring | Solder wires directly; no custom PCB | ~40 small solder joints |

---

## 2. What the parts look like

**The display is a bare module with no case:**
```
 ┌──────────────────────────┐  ~35 × 33 mm small circuit board
 │ ┌──────────────────────┐ │
 │ │  BANK 3      TONE 2  │ │  1.3" glass OLED screen (white text on black)
 │ │  Clean Chorus        │ │  128 × 64 pixels → 2–3 lines of text
 │ │  DRV MOD DLY REV     │ │
 │ └──────────────────────┘ │
 │     GND VCC SCL SDA      │  4 pins → 4 wires to the ESP32
 └──────────────────────────┘
```
It sits behind the rectangular window in the 3D-printed case, and the case holds it in place.

**The ESP32 DevKit is also a bare board:** about 55 × 28 mm, with 38 pins and a USB port. It mounts inside the case with 4 screws. That's why the listing must say **"4 mounting holes"**.

**The footswitches** are metal stomp buttons with a nut. They go through the case holes, and 2 wires are soldered to each one.

---

## 3. Parts list (AliExpress)

| # | Part | Search term on AliExpress | Qty | ~Cost |
|---|---|---|---|---|
| 1 | ESP32 board | "ESP32 DevKit 38 pin **mounting holes** CP2102 USB-C" | 1 (buy 2, spare) | $5 |
| 2 | Display | "1.3 inch OLED **SH1106** I2C 4 pin **white**" | 1 | $4 |
| 3 | Footswitches | "momentary soft touch footswitch" (**not** latching) | 6 | $8 |
| 4 | LEDs | 5 mm LEDs assorted (6 FX + 2 label; 4 preset optional) | 1 pack | $2 |
| 5 | Resistors | assorted 1/4 W kit (need 6 × 1 kΩ, 10 × 470 Ω, 1 × 47 Ω) | 1 kit | $2 |
| 6 | Wire | 24 AWG silicone wire (2–3 colors) + heat-shrink tubing | 1 set | $4 |
| 7 | USB power bank | small 5000 mAh with **"low current / always-on" mode** | 1 (or use one you own) | $0–8 |
| 8 | USB cable | short cable matching the ESP32 port | 1 | $1 |
| 9 | **3D-printed case** | Upload the Thingiverse STL files to a print service: JLC3DP, Craftcloud, or an AliExpress "custom 3D printing service" store. Outer shell opaque PLA; inner part **translucent/natural PLA** | 1 set | $20–35 |
| | **Total** | | | **≈ $50–70** |

**Notes:**
- **Power bank:** many power banks switch off when a device draws very little current. The ESP32 draws about 120 mA. Pick one that says "low current mode" or "always on", or test one you already own first.
- **Battery life:** a 5000 mAh bank gives roughly **25+ hours**.
- **No 3D printer?** Many public libraries and makerspaces print for a few dollars. That's often cheaper than a mail-order service.

---

## 4. Wiring (from Ignitron's schematic)

**Each footswitch:**
```
3V3 ──[footswitch]──┬── GPIO
                    └──[1 kΩ]── GND
```

| Function | ESP32 pin | Connection |
|---|---|---|
| Switch 1 – Tone 1 / Drive | GPIO 25 | switch to 3V3, 1 kΩ to GND |
| Switch 2 – Tone 2 / Mod | GPIO 26 | same |
| Switch 3 – Tone 3 / Delay | GPIO 32 | same |
| Switch 4 – Tone 4 / Reverb | GPIO 33 | same |
| Switch 5 – Bank down / Noise gate | GPIO 19 | same |
| Switch 6 – Bank up / Comp | GPIO 18 | same |
| Display GND / VCC / SCL / SDA | GND / 3V3 / GPIO 22 / GPIO 21 | |
| FX LEDs 1–6 | GPIO 27, 13, 16, 14, 23, 17 | pin → 470 Ω → LED long leg; short leg → GND |
| Preset LEDs 1–4 (optional) | GPIO 0, 4, 12, 15 | same; enable `DEDICATED_PRESET_LEDS` in firmware |
| "IGNITRON" label LEDs (optional) | 5V + GND | 2 LEDs in series with 47 Ω (not blue) |

Sources: `hardware/Ignitron-Schematics.pdf`, `hardware/README.md` (3D case section), `src/Config_Definitions.h`.

---

## 5. Extras you asked about

### Wah / knob / touch screen
- **Wah on the Spark 40 is limited.** The only wah documented for Spark amps is the **J.H. Legendary Wah** from the paid Hendrix gear pack in the Spark app. It is an **auto-wah**: it sweeps by itself, synced to BPM or triggered by picking strength. There is no documented "pedal position" setting, so a knob or rocker can't sweep it the way a real wah pedal does.
  - **Cheapest real wah:** a used analog wah pedal between your guitar and the amp (~$30–40). It works with any tone.
- **A knob works well for:** tone volume, gain, delay/reverb mix, and modulation speed or depth. The knob is not in the 3D case design. To add one later without a drill, open a 7 mm hole in the PLA side wall with a hand reamer (~$5) or a hot old soldering tip. Firmware support for the knob is a small addition I can write.
- **Touch screen:** see Option B below.

### ESP32 as a custom keyboard (Anki flash cards)
Yes. Ignitron has a **Keyboard mode** that turns the pedal into a Bluetooth keyboard.
- **To enter:** hold **switch 3** while powering on, then pair "Ignitron" in iPhone Settings → Bluetooth.
- **Default keys:** switches send `1`–`6` on short press and `A`–`D` on long press. Layouts are configurable in code, and long-pressing Bank up/down switches between layouts.
- **Anki layout (AnkiMobile, AnkiDroid and desktop all support these keys):**

| Switch | Key | Anki action |
|---|---|---|
| 1 | `Space` | Show answer |
| 2 | `1` | Again |
| 3 | `2` | Hard |
| 4 | `3` | Good |
| 5 | `4` | Easy |
| 6 | (free) | e.g. Enter |

- **Hands-free review:** use your feet. Or build a small desk keypad version with mechanical keyboard switches.
- **iPhone tip:** Ignitron's docs describe a one-line tweak so iOS treats it as a *keypad*. Then the on-screen keyboard doesn't disappear while it's connected.

### Option B – touchscreen controller (later, ~$20)
- **"Cheap Yellow Display" (ESP32-2432S028R):** an ESP32 with a built-in **2.8" color touchscreen**, about $15 on AliExpress. Search "ESP32-2432S028R case"; ready-made cases and free STL files (Printables) exist.
- **Could show:** a tone list with big names, on-screen renaming, **sliders** for volume/gain/effect mix, and big touch buttons for Anki.
- **Limits:**
  - Only 4 free pins, so 2–4 footswitches at most, via a ready-made dual footswitch plugged into a jack.
  - Needs **custom firmware**, which I'd write. Ignitron doesn't support this board.
  - The amp allows one control connection, so the pedal and the touchscreen can't control the amp at the same time.

---

## 6. Build order
1. **Order parts + case print** (AliExpress 2–3 weeks; print service 1–2 weeks).
2. **Set up the Mac:** VS Code + PlatformIO. Flash stock Ignitron to the bare ESP32 over USB and connect it to the Spark 40 with **no wiring** yet.
3. **Bench test:** display + 2 switches with jumper wires. Switch tones on the amp.
4. **Save your tones and names** from the iPhone Spark app (hold switch 1 at power-on = AMP mode).
5. **Assemble in the case:** mount the switches and LEDs, then solder the wires.
6. **Keyboard mode layout for Anki** (I prepare the code change).
7. **Optional later:** knob support, touchscreen remote.
