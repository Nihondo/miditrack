import assert from "node:assert/strict";
import test from "node:test";

import { createFavoriteProgramsController } from "../src/miditrack/web_assets/favorite_programs.mjs";

test("読み込んだピン留め・使用回数から、ピン留め優先で並び順を作る", () => {
  const controller = createFavoriteProgramsController({ maxFavorites: 8 });

  controller.load({ pinnedPrograms: [10], usageCounts: { 20: 3, 30: 5, 40: 1 } });

  assert.equal(controller.isPinned(10), true);
  assert.equal(controller.isPinned(20), false);
  assert.deepEqual(controller.rankFavorites(), [
    { program: 10, isPinned: true },
    { program: 30, isPinned: false },
    { program: 20, isPinned: false },
    { program: 40, isPinned: false },
  ]);
});

test("並び順はmaxFavorites件までに切り詰められる", () => {
  const controller = createFavoriteProgramsController({ maxFavorites: 2 });
  controller.load({ pinnedPrograms: [], usageCounts: { 1: 1, 2: 2, 3: 3 } });

  assert.deepEqual(
    controller.rankFavorites().map((entry) => entry.program),
    [3, 2],
  );
});

test("ピン留めの切り替えと使用回数の加算は保存用スナップショットへ反映される", () => {
  const controller = createFavoriteProgramsController({ maxFavorites: 8 });

  assert.equal(controller.togglePinned(5), true);
  assert.deepEqual(controller.getPinnedPrograms(), [5]);
  assert.equal(controller.togglePinned(5), false);
  assert.deepEqual(controller.getPinnedPrograms(), []);

  controller.recordUsage(7);
  controller.recordUsage(7);
  assert.deepEqual(controller.getUsageCounts(), { 7: 2 });
});

test("nullプログラムは常にピン留めされていない扱いになる", () => {
  const controller = createFavoriteProgramsController({ maxFavorites: 8 });
  assert.equal(controller.isPinned(null), false);
});
