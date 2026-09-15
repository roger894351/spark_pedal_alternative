# ESP32 Spark 40 Controller – Build Spec v1

**Target:** a battery-powered foot controller with a display. It gives you far more than 4 tones, and you design the tones in the Spark app.
**Budget:** about $50 in parts, well under the ~$200 Positive Grid pedal.

---

## 1. Answers to the key questions

### "The Spark 40 only has 4 presets – can we get more?"
Yes. The amp stores 4 tones, but the pedal can **store hundreds of tones itself**. When you press a switch, it sends the complete tone (amp model, effects, settings) to the amp. That is what the Spark app does.

Tones are grouped in **banks of 4**:
- 4 switches pick a tone.
- 2 switches go to the previous/next bank.

The amp's own 4 presets stay unchanged. The open-source **Ignitron** firmware already does this, and it comes with 94 tones.

### "Should we move the Spark app to an ESP32 or a Raspberry Pi?"
The ESP32 is the better fit here:

| | ESP32 | Raspberry Pi |
|---|---|---|
| Price | ~$6 | $35–80+ (plus SD card) |
| Start-up time | ~2 seconds | 30+ seconds |
| Battery life on one 18650 cell | ~15 hours | ~3–4 hours |
| Existing Spark pedal software | ✅ Ignitron, SparkBox | ❌ you'd write it yourself |

### "Can I still use my Spark app?"
Yes, in two ways:
1. **Design and name tones in the Spark app, then save them into the pedal.**
   - Hold switch 1 while powering on the pedal. It now appears to the Spark app as an amp (this is called AMP mode).
   - The iPhone Spark app connects to it.
   - Pick any tone, from your own or ToneCloud, **name it** the way you want, and save it to the pedal.
   - The display then shows that name. This is how you **rename channels**.
2. **While you play:** the pedal uses the amp's one control connection, so the Spark app can't control the amp at the same time. However:
   - Your iPhone can still **stream music or backing tracks** to the Spark 40 over Bluetooth audio.
   - The pedal can also act as a Bluetooth keyboard to control phone apps (a looper, tabs or backing tracks).

### "No expression pedal – can we add a pedal or a physical switch keyboard?"
Options, from most to least recommended:

| Option | What you get | Cost | Notes |
|---|---|---|---|
| **Footswitches** (main input) | 6 stomp switches | $10 | Built for feet; this is the core of the pedal |
| **Volume knob** on the pedal | Turn to set the tone's Master volume | $1.50 | Needs a small addition to Ignitron (I can write it) |
| **Expression jack** (TRS 1/4") | Plug in any expression pedal later for volume or wah swells | $1.50 | Same addition; drill one hole now, buy a pedal later (~$25 used) |
| Mechanical keyboard switches | Compact buttons for hands, not feet | $5 | Good for a desktop box, bad on the floor |
| Your KZZI keyboard plugged into the pedal | Key presses switch tones | – | Possible with a different chip (ESP32-S3) and custom code. Not recommended: the **web app already does this with your phone** |

**Recommendation:** 6 footswitches + volume knob + expression jack. Use the KZZI keyboard + web app for practicing at a desk.

---

## 2. Parts list (≈ $50)

Prices are approximate (AliExpress/Tayda cheapest, Amazon faster). Use the search terms to find parts.

| # | Part | Search term | Qty | ~Cost |
|---|---|---|---|---|
| 1 | ESP32 board | "ESP32 WROOM-32 DevKit 38 pin USB-C" | 1 | $6 |
| 2 | Footswitches | "momentary soft touch footswitch SPST" (**not latching**) | 6 | $10 |
| 3 | Display | "1.3 inch OLED I2C SH1106 128x64" | 1 | $6 |
| 4 | Battery | 18650 **protected** cell, brand name (Samsung, LG, Molicel) | 1 | $6 |
| 5 | Charger | "TP4056 USB-C 18650 charger module with protection" | 1 | $2 |
| 6 | 5 V booster | "MT3608 boost converter" (or one "18650 battery shield" that replaces #5 and #6) | 1 | $2 |
| 7 | Battery holder + power switch | "18650 holder with leads" + "mini slide switch" | 1 | $2 |
| 8 | Enclosure | "1590DD aluminum enclosure" (fits 6 switches + display) | 1 | $10 |
| 9 | Volume knob | "10k linear potentiometer B10K" + knob | 1 | $1.50 |
| 10 | Expression jack | "6.35mm TRS stereo jack panel mount" | 1 | $1.50 |
| 11 | Resistors | 6 × 1 kΩ (switches), 2 × 100 kΩ (battery sense) | – | $1 |
| 12 | Wire | 22–24 AWG hookup wire, dupont jumpers, heat-shrink | – | $3 |
| | **Total** | | | **≈ $51** |

Optional:
- 6 × 5 mm LEDs + 470 Ω resistors + holders (+$3) show the active effect or tone. The display already shows the channel, so you can skip them at first.
- An ESP32 screw-terminal breakout board (+$4) means less soldering (see section 3).

**Tools (not in budget):**
- A soldering iron. A Pinecil or any temperature-controlled iron is about $25. Borrow one if you can.
- Solder, and a drill with a step bit (4–13 mm) for the enclosure.
- A multimeter is helpful (~$15).

**Battery life:** the ESP32 + Bluetooth + display draw about 120 mA, so a 3000 mAh cell gives **~15–20 hours**. Charge it over USB-C.

---

## 3. Soldering options

| Option | Solder joints | Skill | Neatness | Extra cost |
|---|---|---|---|---|
| **A. Screw-terminal breakout** (recommended for a first build) | ~20 (switch tabs, battery modules) | Beginner | OK | +$4 |
| B. Perfboard "shield" | ~60 | Some practice | Good | $0 |
| C. Ignitron's custom PCB | ~50 | Some practice | Best | +$15–20 (PCB order) |

With **Option A**:
- The ESP32 plugs into the breakout board, and wires go into screw terminals.
- The display connects with 4 plug-in jumper wires.
- You only solder the footswitch lugs, the battery modules, the knob and the jack. These are all big and easy joints.

---

## 4. Wiring plan
**Footswitch wiring** (same for all 6):
```
3V3 ──[footswitch]──┬── GPIO pin
                    └──[1 kΩ]── GND
```
The pin reads HIGH when the switch is pressed. The 1 kΩ resistor pulls the pin down to LOW when released.

| Function | ESP32 pin | Connection |
|---|---|---|
| Switch 1 (Tone 1 / Drive) | GPIO 25 | footswitch to 3V3, 1 kΩ to GND |
| Switch 2 (Tone 2 / Mod) | GPIO 26 | same |
| Switch 3 (Tone 3 / Delay) | GPIO 32 | same |
| Switch 4 (Tone 4 / Reverb) | GPIO 33 | same |
| Switch 5 (Bank down / Noise gate) | GPIO 19 | same |
| Switch 6 (Bank up / Comp) | GPIO 18 | same |
| Display GND / VCC / SCL / SDA | GND / 3V3 / GPIO 22 / GPIO 21 | 4 jumper wires |
| LEDs 1–6 (optional) | GPIO 27, 13, 16, 14, 23, 17 | pin → 470 Ω → LED long leg; LED short leg → GND |
| Battery voltage | GPIO 36 (VP) | middle of a 100k/100k divider across the battery (+ to GND) |
| Volume knob (new) | GPIO 34 | knob wiper (middle leg); outer legs to 3V3 and GND |
| Expression jack (new) | GPIO 35 | jack tip; ring to 3V3, sleeve to GND |
| Power | 5V (VIN) / GND | battery → charger → power switch → MT3608 (set to 5.0 V) → 5V pin |

Source: `hardware/Ignitron-Schematics.pdf` for switches, LEDs and display; `src/Config_Definitions.h` for pins.
Only GPIO 34/35 are new. They are input-only ADC1 pins, which keep working while Bluetooth is on.


---

## 5. Firmware plan

| Step | What | Who |
|---|---|---|
| 1 | Install VS Code + PlatformIO on the Mac | you (I'll give exact steps) |
| 2 | Flash **stock Ignitron** with settings for this build: `OLED_DRIVER_SH1106`, battery type Li-ion ×1 cell | I prepare the config |
| 3 | Bench test: ESP32 on USB + 2 switches + display, with the Spark 40 switching tones | you |
| 4 | Save your own tones and names from the iPhone Spark app (AMP mode) | you |
| 5 | **Add volume knob + expression jack support** (Master volume of the current tone) | I write it (our fork of Ignitron, BSD-3) |
| 6 | Later, optional: a Wi-Fi page on the pedal to rename or reorder tones from your phone's browser | I write it |

---

## 6. Build order
1. **Order parts.** AliExpress takes 2–3 weeks; Amazon is faster but costs more.
2. **Bench test on the desk** (1 evening): ESP32 + display + 2 switches with jumper wires. Flash Ignitron and switch tones on the Spark 40.
3. **Load your tones** from the Spark app.
4. **Drill the enclosure** (1 afternoon). Print a paper template, center-punch, then use a step bit.
5. **Wire everything in the box** (1–2 evenings): switches, then display, then battery, then knob and jack.
6. **Add the volume/expression firmware.**

## 7. Open questions
1. Do you already own a **soldering iron** and a **drill**?
2. Order from **AliExpress** (cheapest, slow) or **Amazon** (fast, about +$15)?
3. **LEDs** now or skip?
4. Screw-terminal breakout (**Option A**) or perfboard (**Option B**)?
