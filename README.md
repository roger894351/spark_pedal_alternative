# Spark Switch

Switch presets 1–4 on a **Positive Grid Spark 40** from a Bluetooth keyboard or your phone, with no extra hardware.

```
KZZI K75 Pro (Bluetooth) ──► iPhone (Bluefy browser, this web app) ──► Spark 40 (Bluetooth LE)
```

## Keys
| Key                         | Action          |
|-----------------------------|-----------------|
| `1` `2` `3` `4`             | Preset 1–4      |
| `←` `↑` `Page Up`           | Previous preset |
| `→` `↓` `Page Down`         | Next preset     |

You can also tap the big on-screen buttons. To change the key mapping, edit `KEYMAP` in `web/app.js`.

## Try it on your Mac first (easiest)
1. `npm run serve` (or `python3 -m http.server 8000 --directory web`)
2. Open **Google Chrome** at http://localhost:8000
3. Close the Spark app on your phone. The amp accepts only one control connection at a time.
4. Click **Connect to Spark** and pick the device named like "Spark 40 BLE".
5. Press `1`–`4` on the keyboard.

## Use it on iPhone
Web Bluetooth needs **HTTPS** and a browser that supports it. Safari doesn't.

1. Use the hosted version (see below), or host the `web/` folder on any HTTPS site.
2. Install **Bluefy – Web BLE Browser** from the App Store (free).
3. Pair the keyboard with the iPhone:
   - Switch the K75 Pro to **Bluetooth mode**. Check its manual for the key combo, usually Fn + a number key; 2.4G mode needs the USB dongle and won't work with an iPhone.
   - On the iPhone, open Settings → Bluetooth and select the keyboard.
4. **Don't** pair the amp in iPhone Settings. Open the page in Bluefy and tap **Connect to Spark**.
5. Force-quit the official Spark app first.
6. Keep Bluefy open on screen while playing. Set Settings → Display & Brightness → Auto-Lock → Never if the screen still sleeps.

### Hosted version
Open **https://roger894351.github.io/spark_pedal_alternative/** in Bluefy. It's published from the `main` branch via GitHub Pages; pushing to `main` updates it within a minute or two.

## Troubleshooting
| Problem                                  | Fix                                                                 |
|------------------------------------------|---------------------------------------------------------------------|
| Amp not listed when connecting           | Close or force-quit the Spark app; power-cycle the amp               |
| "Bluetooth not available in this browser" | Use Bluefy (iPhone) or Chrome (Mac/Android); page must be HTTPS or localhost |
| Connected, but keys do nothing           | Tap an empty area of the page once so it has focus; check the keyboard is in BT mode |
| Preset button stays yellow               | Open **Bluetooth log** at the bottom; copy it and share it for debugging |

## Development
- `npm test` runs the protocol encoder/decoder tests (Node 18+).
- `web/spark-protocol.js` has the message format; see [PLAN.md](PLAN.md) section 2.
- Protocol reference: [Ignitron](https://github.com/stangreg/Ignitron) (BSD-3) and [paulhamsh/Spark](https://github.com/paulhamsh/Spark).
