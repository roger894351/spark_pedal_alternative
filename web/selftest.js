// A scripted conversation with the amp: one of every kind of command we send, checking
// what comes back.
//
// Some commands the amp acks (a preset change, a whole tone). The rest it never acks — but
// it echoes them back: 03 37 for a knob, 03 15 for an effect switch. That echo is the only
// confirmation those commands ever get, and it carries the value the amp actually set, so
// the test can check not just that the change arrived but that it arrived intact.
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

  // 5. A knob. Never acked, but echoed — and the echo says what the amp actually set.
  const ampPedal = original.pedals[AMP_SLOT];
  const before = ampPedal.parameters[AMP_PARAM.master];
  const probe = before > 0.6 ? 0.35 : 0.85;
  const echoed = await amp.setParameter(ampPedal.name, AMP_PARAM.master, probe);
  record("Volume reaches the amp", echoed !== null && Math.abs(echoed - probe) < 0.02,
    echoed === null
      ? `no echo for ${ampPedal.name} — the amp did not take this change`
      : Math.abs(echoed - probe) < 0.02
        ? `asked ${ampPedal.name} for ${pct(probe)}, amp confirmed ${pct(echoed)}`
        : `asked for ${pct(probe)}, amp set ${pct(round(echoed))} instead`);
  await amp.setParameter(ampPedal.name, AMP_PARAM.master, before);

  // 6. An effect switch, same shape, different command (01 15).
  const fx = original.pedals[TEST_SLOT];
  if (!fx?.name) {
    record(`${SLOT_LABELS[TEST_SLOT]} on/off`, false, "the tone has no effect in this slot");
  } else {
    const wanted = !fx.isOn;
    const got = await amp.setEffect(fx.name, wanted);
    record(`${SLOT_LABELS[TEST_SLOT]} on/off`, got === wanted,
      got === null ? `no echo for ${fx.name} — the amp did not take this change`
      : got === wanted ? `${fx.name} switched ${wanted ? "on" : "off"} and confirmed`
      : `${fx.name} answered ${got ? "on" : "off"}, not ${wanted ? "on" : "off"}`);
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
  const knob = steps.find((s) => s.name === "Volume reaches the amp");
  if (failed.length === 1 && knob && knob.ok === false) {
    return "Presets and tones are fine, but the amp is not taking volume changes. Check "
      + "the Spark app isn't connected at the same time, then run this again.";
  }
  if (knob && knob.ok === true) {
    return `${failed.length} check(s) failed, but volume is reaching the amp — if it still `
      + "sounds wrong, that is the amp's own Master knob, not the app.";
  }
  return `${failed.length} check(s) failed — send the log.`;
}
