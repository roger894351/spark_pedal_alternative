// A scripted conversation with the amp: one of every kind of command we send, checking
// what comes back.
//
// Where the amp answers by itself — it names its model, acks a preset change, acks a whole
// tone — a step can pass or fail outright. Where it stays silent (a knob, an effect switch)
// the step makes the change and then reads the tone back, which is the only way to find out
// whether it landed. That read-back also answers a question we have been guessing at: does
// the amp report what is *playing*, or only what it has *stored*?
//
// The test leaves the amp on the tone it started on.

import { AMP_SLOT, AMP_PARAM, SLOT_LABELS } from "./spark-preset.js";

const round = (v) => Math.round(v * 100) / 100;
const pct = (v) => `${Math.round(v * 100)}%`;

// The slot to flip for the effect test: reverb is last in the chain and safe to toggle.
const TEST_SLOT = 6;

export async function runSelfTest(amp, onStep) {
  const steps = [];
  const record = (name, ok, detail) => {
    const step = { name, ok, detail };
    steps.push(step);
    onStep?.(step);
    return step;
  };

  // 1. Does the amp say what it is? Decides how big each BLE write may be.
  const name = await amp.readAmpName();
  record("Amp says which model it is", !!name,
    name ? `${name} · ${amp.writeSize()} bytes per write` : "no answer to 02 11");

  // 2. Read the tone that is playing. Everything below is measured against it, and the
  //    amp is put back on it at the end.
  const original = await amp.readTone("read tone");
  if (!original) {
    record("Amp sends its current tone", false, "no tone came back – nothing else can be checked");
    return steps;
  }
  record("Amp sends its current tone", true, `"${original.name}"`);

  // 3. Preset button. One block, always worked, but worth proving on this amp.
  const switched = await amp.changePreset(1);
  record("Preset button", switched, switched ? "acked 01 38" : "no ack for 01 38");

  // 4. A whole tone — several blocks. This is what silently failed before v11, and it
  //    also puts back the tone step 3 switched away from.
  const sent = await amp.sendTone(original, "send tone");
  record("Full tone send", sent.ok,
    sent.ok
      ? `${sent.acked}/${sent.chunks} chunks, then the final ack`
      : `only ${sent.acked}/${sent.chunks} chunks confirmed – blocks are being dropped`);

  // 5. A knob. The amp never acks these, so the only check is to read the tone back.
  const ampPedal = original.pedals[AMP_SLOT];
  const before = ampPedal.parameters[AMP_PARAM.master];
  const probe = before > 0.6 ? 0.35 : 0.85;
  await amp.setParameter(ampPedal.name, AMP_PARAM.master, probe);
  await amp.pause(600);
  const afterKnob = await amp.readTone("read back");
  const got = afterKnob?.pedals?.[AMP_SLOT]?.parameters?.[AMP_PARAM.master];
  const knobEchoed = got !== undefined && Math.abs(got - probe) < 0.02;
  record("Volume change is echoed back", knobEchoed,
    got === undefined
      ? "the amp sent no tone to compare against"
      : knobEchoed
        ? `set ${pct(probe)} on ${ampPedal.name}, amp reports ${pct(got)}`
        : `set ${pct(probe)}, amp still reports ${pct(round(got))} — it answers with its `
          + "stored preset, not what is playing, so a knob cannot be verified this way");
  await amp.setParameter(ampPedal.name, AMP_PARAM.master, before);

  // 6. An effect switch, same shape. Only meaningful if step 5 showed the amp echoes edits.
  const fx = original.pedals[TEST_SLOT];
  if (!fx?.name) {
    record(`${SLOT_LABELS[TEST_SLOT]} on/off`, false, "the tone has no effect in this slot");
  } else if (!knobEchoed) {
    record(`${SLOT_LABELS[TEST_SLOT]} on/off`, null,
      "skipped – the amp does not report live edits, so there is nothing to compare");
  } else {
    await amp.setEffect(fx.name, !fx.isOn);
    await amp.pause(600);
    const afterFx = await amp.readTone("read back");
    const isOn = afterFx?.pedals?.[TEST_SLOT]?.isOn;
    const fxEchoed = isOn === !fx.isOn;
    record(`${SLOT_LABELS[TEST_SLOT]} on/off`, fxEchoed,
      fxEchoed ? `${fx.name} switched ${fx.isOn ? "off" : "on"} and reported back`
               : `${fx.name} did not change`);
    await amp.setEffect(fx.name, fx.isOn);
  }

  // Leave the amp as we found it.
  await amp.sendTone(original, "restore tone");
  return steps;
}

// One line saying what the run means, rather than making you read six rows.
export function verdict(steps) {
  const failed = steps.filter((s) => s.ok === false);
  if (!steps.length) return "The test didn't run.";
  if (!failed.length) return "Everything the amp can confirm, it confirmed.";

  const toneSend = steps.find((s) => s.name === "Full tone send");
  if (toneSend && toneSend.ok === false) {
    return "Tones are not arriving whole — this is the bug that makes random tones and My "
      + "tones do nothing. Send the log.";
  }
  const knob = steps.find((s) => s.name === "Volume change is echoed back");
  if (failed.length === 1 && knob && knob.ok === false) {
    return "Commands are getting through. The amp just doesn't report edits back, so the "
      + "app can't confirm a knob landed — if volume sounds wrong, check the amp's own "
      + "Master knob and the Spark app isn't also connected.";
  }
  return `${failed.length} check(s) failed — send the log.`;
}
