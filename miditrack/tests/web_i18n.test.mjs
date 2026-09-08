import assert from "node:assert/strict";
import test from "node:test";

import { createTranslator } from "../src/miditrack/web_assets/i18n.mjs";

test("日本語はカタログを取得せずmsgidと置換値を返す", async () => {
  let fetchCount = 0;
  const translator = createTranslator("ja", async () => {
    fetchCount += 1;
    return { json: async () => ({}) };
  });

  await translator.loadCatalog();
  assert.equal(fetchCount, 0);
  assert.equal(translator.translate("こんにちは、{name}", { name: "MIDI" }), "こんにちは、MIDI");
});

test("英語カタログと読込失敗時のmsgidフォールバックを使う", async () => {
  const translator = createTranslator("en", async () => ({
    json: async () => ({ "こんにちは、{name}": "Hello, {name}" }),
  }));
  await translator.loadCatalog();
  assert.equal(translator.translate("こんにちは、{name}", { name: "MIDI" }), "Hello, MIDI");

  const fallback = createTranslator("en", async () => { throw new Error("offline"); });
  await fallback.loadCatalog();
  assert.equal(fallback.translate("未翻訳"), "未翻訳");
});
