# Versatile ESP32 Spark Controller – Design Guide

A phone-free foot controller for the Spark 40 that goes beyond Spark Control. It adds unlimited tone banks, effect on/off switches, volume/expression control, a tuner, and control of phone apps such as a looper.

## 1. What is an ESP32?
A small, cheap microcontroller board (about 5 × 2.5 cm, $6–10) with **Bluetooth LE + Wi-Fi built in**. You program it from your Mac over USB.

It can:
- Talk to the Spark 40 the same way the Spark app does.
- Read footswitches, knobs and expression pedals.
- Drive a small display and LEDs.
- Pretend to be a Bluetooth keyboard or MIDI device, to control phone apps.

## 2. Feature menu
Pick what you want. Everything here can run on one ESP32.

| # | Feature | What it does | Needs |
|---|---|---|---|
| A | **Preset banks** | 4 switches = 4 tones, 2 switches = bank up/down. Hundreds of tones stored on the ESP32 and sent to the amp. The amp's own 4 presets stay untouched. | 6 footswitches |
| B | **FX mode** | Switches toggle Noise Gate / Comp / Drive / Mod / Delay / Reverb in the current tone | same switches, long-press to change mode |
| C | **Volume** | Up/down switches, or a knob, set the tone's **Master** level (amp block parameter 4, value 0.0–1.0) | 2 switches or a $1 knob |
| D | **Expression pedal** | Smooth control of volume, wah, gain or delay mix | 1–2 TRS jacks + expression pedal(s) |
| E | **Tuner** | Turns on the amp's tuner and shows the note on the display | display |
| F | **Phone app control** | Acts as a Bluetooth keyboard/MIDI device for a looper, backing tracks or sheet-music page turning | nothing extra |
| G | **Wi-Fi setup page** | Change button mapping, banks and tones from your phone's browser; no reprogramming | nothing extra |
| H | **Display + LEDs** | Shows bank, tone name and volume; LEDs show the active tone or effect | OLED + LED strip |
| I | **Battery** | Runs wireless for about 10–15 h per charge | 18650 cell + charger board |

**Can't do:** turn the amp's *physical* Master knob. Volume control changes the level inside the tone. In practice that works the same way.

## 3. Recommended hardware ("versatile" build, about $60–80)

| Part | Recommended | Qty | ~Cost | Notes |
|---|---|---|---|---|
| Controller | **ESP32-WROOM-32 DevKit V1** (38-pin, USB-C if available) | 1 (buy 2) | $8 | Same chip as Ignitron and SparkBox. Avoid ESP32-C3 and S2 variants. |
| Screw-terminal breakout for the DevKit | 38-pin "ESP32 expansion board" | 1 | $5 | Lets you wire with a screwdriver instead of soldering |
| Footswitches | **Momentary** soft-touch SPST (*not* latching) | 6 (or 8) | $15 | Latching switches won't work well |
| Expression jacks | 6.35 mm (1/4") **TRS** stereo jack | 2 | $3 | Tip = wiper; powered from **3.3 V**, not 5 V |
| Volume knob (optional) | 10 kΩ linear potentiometer + knob | 1 | $2 | |
| Display | 1.3" OLED **SH1106** I²C (or 0.96" SSD1306) | 1 | $6 | |
| LEDs | WS2812B addressable LED strip (6–8 LEDs) | 1 | $4 | Needs only one data wire |
| Enclosure | Aluminum, Hammond **1590DD** size (6–8 switches) | 1 | $20 | 1590BB fits 4 switches |
| Power (simple) | Any USB power bank | – | $0 | Use one you already have |
| Power (built-in) | 18650 cell + holder + **IP5306** or TP4056+boost board + on/off switch | 1 set | $10 | |
| Wiring | Hookup wire, heat-shrink, rubber feet | – | $5 | |
| Expression pedal | M-Audio EX-P, Moog EP-3 or similar (TRS) | 0–2 | $25–40 each | Only if you want feature D |

**Tools:** a soldering iron for the footswitch tabs (or buy switches with pre-soldered wires), a drill with a step bit for the enclosure holes, and a USB cable for your Mac.

## 4. Pin plan (ESP32-WROOM-32)
| Function | GPIO | Why |
|---|---|---|
| Footswitches 1–8 | 13, 14, 16, 17, 18, 19, 23, 25 | Internal pull-ups; each switch goes to GND |
| OLED SDA / SCL | 21 / 22 | Default I²C pins |
| WS2812 LED data | 26 | |
| Expression 1 / 2 (ADC) | 34 / 35 | Input-only **ADC1** pins; ADC2 pins stop working while Bluetooth is on |
| Volume knob (ADC) | 32 | ADC1 |
| Battery voltage sense | 36 (VP) | through a 100k/100k divider |

## 5. Software approach
1. **Start from Ignitron** (BSD-3, proven on Spark 40). It already has preset banks, FX mode, tuner, looper/keyboard mode and an OLED UI.
2. **Add on top (our fork):**
   - Volume up/down and knob → amp Master parameter
   - Expression pedal inputs with configurable targets. SparkBox (github.com/happyhappysundays/SparkBox) has working expression code to borrow from.
   - Wi-Fi setup page for button mapping
   - Optional: import tones created in the Spark Switch web app
3. **Build and flash** with VS Code + PlatformIO on your Mac. Updates can later be sent over Wi-Fi.

## 6. Build order
1. **Bench test (1 evening):** bare ESP32 on USB + 2 switches on a breadboard, with Ignitron flashed. Switching presets on the Spark 40 proves the setup works.
2. **Add parts one at a time:** display, then all switches, then LEDs, then the expression jack.
3. **Firmware additions:** volume, expression, Wi-Fi setup.
4. **Enclosure:** drill, mount and wire.
5. **Battery** (optional).

## 7. Decisions needed from you
1. **How many footswitches?** 4 (compact), **6** (recommended: 4 tones + bank up/down), or 8 (adds 2 dedicated FX or volume switches)
2. **Expression pedals:** none / 1 / 2? Do you already own one?
3. **Volume control style:** up/down footswitches, a knob on the pedal, or expression pedal?
4. **Display:** yes/no?
5. **Power:** USB power bank or built-in rechargeable battery?
6. **Soldering:** comfortable, or should we choose a solderless build (screw terminals, pre-wired switches)?
7. **Phone app control** (looper, backing tracks, sheet music): wanted?
8. **Budget ceiling?**
