import assert from "node:assert/strict";
import test from "node:test";

import { createPianorollFollowController } from "../src/miditrack/web_assets/pianoroll_follow.mjs";

test("追従有効時、再生位置がビューポート中央を越えると目標scrollLeftを返す", () => {
  const controller = createPianorollFollowController();
  controller.setFollowing(true);

  const target = controller.planFollowScroll({
    durationSeconds: 100,
    timelineWidth: 1000,
    viewportWidth: 200,
    scrollLeft: 0,
    globalSeconds: 50,
  });

  assert.equal(target, 400);
});

test("追従無効時・時間軸情報が無い時・まだ中央に届かない時はnullを返す", () => {
  const controller = createPianorollFollowController();

  assert.equal(
    controller.planFollowScroll({
      durationSeconds: 100, timelineWidth: 1000, viewportWidth: 200, scrollLeft: 0, globalSeconds: 50,
    }),
    null,
  );

  controller.setFollowing(true);
  assert.equal(
    controller.planFollowScroll({
      durationSeconds: 0, timelineWidth: 1000, viewportWidth: 200, scrollLeft: 0, globalSeconds: 50,
    }),
    null,
  );
  assert.equal(
    controller.planFollowScroll({
      durationSeconds: 100, timelineWidth: 0, viewportWidth: 200, scrollLeft: 0, globalSeconds: 50,
    }),
    null,
  );
  assert.equal(
    controller.planFollowScroll({
      durationSeconds: 100, timelineWidth: 1000, viewportWidth: 200, scrollLeft: 0, globalSeconds: 1,
    }),
    null,
  );
});

test("追従由来のスクロールは維持され、手動スクロールは追従を解除する", () => {
  const controller = createPianorollFollowController();
  controller.setFollowing(true);
  const target = controller.planFollowScroll({
    durationSeconds: 100, timelineWidth: 1000, viewportWidth: 200, scrollLeft: 0, globalSeconds: 50,
  });

  assert.equal(controller.reconcileScroll(target), true);
  assert.equal(controller.isFollowing(), true);

  controller.planFollowScroll({
    durationSeconds: 100, timelineWidth: 1000, viewportWidth: 200, scrollLeft: target, globalSeconds: 60,
  });
  assert.equal(controller.reconcileScroll(target + 50), false);
  assert.equal(controller.isFollowing(), false);
});

test("先頭へのスクロール計画は常に0を返し、追従無効化は保留目標も破棄する", () => {
  const controller = createPianorollFollowController();
  controller.setFollowing(true);

  assert.equal(controller.planScrollToStart(), 0);
  controller.setFollowing(false);
  // 追従無効化直後は、保留中のスクロール目標が無いため常に手動スクロール扱いになる。
  assert.equal(controller.reconcileScroll(0), false);
});
