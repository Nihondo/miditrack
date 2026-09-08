import assert from "node:assert/strict";
import test from "node:test";

import { createPianorollLoopController } from "../src/miditrack/web_assets/pianoroll_loop.mjs";

test("ループ範囲を曲長内へ正規化して有効状態を保持する", () => {
  const controller = createPianorollLoopController({ minimumSeconds: 0.1 });

  assert.equal(controller.setRange(-1, 12, 10, { enable: true }), true);
  assert.deepEqual(controller.getSelectedRange(10), { start: 0, end: 10 });
  assert.deepEqual(controller.getActiveRange(10), { start: 0, end: 10 });
  assert.equal(controller.setRange(2, 2.05, 10), false);
  assert.deepEqual(controller.getActiveRange(10), { start: 0, end: 10 });
});

test("ループ範囲は曲長変更時に再検証され、解除で初期化される", () => {
  const controller = createPianorollLoopController({ minimumSeconds: 0.1 });

  assert.equal(controller.setRange(6, 10, 10, { enable: false }), true);
  assert.deepEqual(controller.getSelectedRange(8), { start: 6, end: 8 });
  assert.equal(controller.getActiveRange(8), null);
  controller.clearRange();
  assert.equal(controller.getSelectedRange(8), null);
  assert.equal(controller.isEnabled(), false);
});
