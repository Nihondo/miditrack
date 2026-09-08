import assert from "node:assert/strict";
import test from "node:test";

import { createPianorollPointerController } from "../src/miditrack/web_assets/pianoroll_pointer.mjs";

test("ポインター操作はしきい値を越えた移動だけをループ選択として返す", () => {
  const controller = createPianorollPointerController({ dragThresholdPixels: 6 });

  controller.beginPointer(7, 100, 3);
  assert.equal(controller.updatePointer(8, 120, 5), null);
  assert.equal(controller.updatePointer(7, 105, 4), null);
  assert.deepEqual(controller.updatePointer(7, 106, 4), {
    anchorSeconds: 3,
    currentSeconds: 4,
  });
  assert.deepEqual(controller.finishPointer(7), {
    pointerId: 7,
    startClientX: 100,
    anchorSeconds: 3,
    isDragging: true,
  });
});

test("不正な座標の操作はドラッグにせず、終了後は同じポインターを受け付けない", () => {
  const controller = createPianorollPointerController({ dragThresholdPixels: 6 });

  controller.beginPointer(4, 100, null);
  assert.equal(controller.updatePointer(4, 120, 5), null);
  assert.deepEqual(controller.finishPointer(4), {
    pointerId: 4,
    startClientX: 100,
    anchorSeconds: null,
    isDragging: false,
  });
  assert.equal(controller.finishPointer(4), null);
});
