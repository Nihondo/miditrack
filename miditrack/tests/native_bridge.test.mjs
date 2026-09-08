import assert from "node:assert/strict";
import test from "node:test";

import { createNativeBridgeController } from "../src/miditrack/web_assets/native_bridge.mjs";

function immediateFrame(callback) {
  callback();
  return 0;
}

test("ローカルファイル読み込み要求は先行する処理の完了を待ってから実行される", async () => {
  const bridge = createNativeBridgeController({ isNativeApp: true, requestFrame: immediateFrame });
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = bridge.queueLocalOpen(["a.mid"], async (paths) => {
    order.push(`start:${paths[0]}`);
    await firstGate;
    order.push(`end:${paths[0]}`);
  });
  const second = bridge.queueLocalOpen(["b.mid"], async (paths) => {
    order.push(`start:${paths[0]}`);
    order.push(`end:${paths[0]}`);
  });

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(order, ["start:a.mid", "end:a.mid", "start:b.mid", "end:b.mid"]);
});

test("ネイティブアプリでない、またはメッセージハンドラが無ければ通知しない", async () => {
  const notNative = createNativeBridgeController({ isNativeApp: false, requestFrame: immediateFrame });
  let postedNotNative = false;
  await notNative.notifyReady({ postMessage: () => { postedNotNative = true; } });
  assert.equal(postedNotNative, false);

  const native = createNativeBridgeController({ isNativeApp: true, requestFrame: immediateFrame });
  await native.notifyReady(undefined);
});

test("ネイティブアプリかつハンドラがあれば、次フレーム後に空メッセージを送る", async () => {
  const native = createNativeBridgeController({ isNativeApp: true, requestFrame: immediateFrame });
  let receivedMessage = null;
  await native.notifyReady({ postMessage: (message) => { receivedMessage = message; } });
  assert.deepEqual(receivedMessage, {});
});
