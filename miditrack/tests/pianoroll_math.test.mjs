import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPianorollTime,
  formatPlaybackClock,
  isPianorollBlackKey,
  pianorollFieldOffsets,
  pianorollOctaveLabel,
  pianorollPitchBounds,
  pianorollWhiteKeyBounds,
} from "../src/miditrack/web_assets/pianoroll_math.mjs";

test("ピアノロールのフィールド・時計・時刻ラベルを決定論的に整形する", () => {
  assert.deepEqual(pianorollFieldOffsets({ fields: ["start", "duration", "note"] }), {
    start: 0, duration: 1, note: 2,
  });
  assert.deepEqual(formatPlaybackClock(62.007), { whole: "01:02", decimal: "007" });
  assert.equal(formatPianorollTime(61.9, (message, values) =>
    message.replace("{minutes}", values.minutes).replace("{seconds}", values.seconds)
  ), "1分1秒");
});

test("ピアノロールの鍵盤境界は黒鍵と整数ピクセル行に整合する", () => {
  const layout = { minNote: 60, noteSpan: 13, height: 130, noteHeight: 130 };

  assert.equal(isPianorollBlackKey(61), true);
  assert.equal(isPianorollBlackKey(60), false);
  assert.equal(pianorollOctaveLabel(60), "C4");
  assert.deepEqual(pianorollPitchBounds(60, layout), { top: 120, bottom: 130, height: 10 });
  const whiteBounds = pianorollWhiteKeyBounds(60, layout);
  assert.ok(whiteBounds.top >= 0);
  assert.ok(whiteBounds.bottom > whiteBounds.top);
});
