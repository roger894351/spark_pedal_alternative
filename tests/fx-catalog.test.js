import { test } from "node:test";
import assert from "node:assert/strict";
import { FX_CATALOG, FX_BY_SLOT, fxInfo, paramLabel, displayName } from "../web/fx-catalog.js";

test("catalog covers every slot and names amp knobs", () => {
  for (let slot = 0; slot < 7; slot++) {
    assert.ok(FX_BY_SLOT[slot]?.length > 0, `slot ${slot} has no effects`);
  }
  assert.deepEqual(fxInfo("94MatchDCV2").params, ["Gain", "Treble", "Middle", "Bass", "Volume"]);
  assert.equal(paramLabel("94MatchDCV2", 4), "Volume");
  assert.equal(displayName("bias.noisegate"), "Noise Gate");
  assert.equal(paramLabel("nope", 0), "param 0");
  assert.ok(Object.keys(FX_CATALOG).length > 60);
});
