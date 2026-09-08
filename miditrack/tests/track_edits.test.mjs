import assert from "node:assert/strict";
import test from "node:test";

import { createTrackEditController } from "../src/miditrack/web_assets/track_edits.mjs";

test("トラック編集は同一ターンの変更を一つのPATCHへまとめる", async () => {
  const commits = [];
  const controller = createTrackEditController({
    commit: async (edits) => { commits.push(edits); return true; },
    debounceMs: 0,
  });

  controller.queueAssignment(1, 80);
  controller.queueVolume(1, 75);
  controller.queueSource(2, "game");

  assert.equal(await controller.flush(), true);
  assert.deepEqual(commits, [{
    assignments: { 1: 80 },
    volumes: { 1: 75 },
    sources: { 2: "game" },
  }]);
});

test("トラック編集は進行中のPATCH後に新しい変更を直列送信する", async () => {
  const commits = [];
  let finishFirstCommit;
  let commitCount = 0;
  const controller = createTrackEditController({
    commit: (edits) => {
      commits.push(edits);
      if (commitCount++ > 0) return Promise.resolve(true);
      return new Promise((resolve) => { finishFirstCommit = () => resolve(true); });
    },
    debounceMs: 0,
  });

  controller.queueAssignment(1, 80);
  const firstFlush = controller.flush();
  controller.queueVolume(1, 50);
  const secondFlush = controller.flush();
  finishFirstCommit();

  assert.equal(await firstFlush, true);
  assert.equal(await secondFlush, true);
  assert.deepEqual(commits, [
    { assignments: { 1: 80 }, volumes: {}, sources: {} },
    { assignments: {}, volumes: { 1: 50 }, sources: {} },
  ]);
});
